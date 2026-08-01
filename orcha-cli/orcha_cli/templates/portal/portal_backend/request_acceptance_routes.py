"""Accept delegated work requests and create the assigned task."""

import json
from typing import Optional

from fastapi import Header, HTTPException, Request

from portal_backend.agent_status import bump_agent, log_event, recompute_agent_status
from portal_backend.application import app
from portal_backend.auth_provider import authorize, resolve_actor
from portal_backend.database import db_cursor
from portal_backend.event_acknowledgement import _ack_events_handled
from portal_backend.events import publish_event as _publish_event
from portal_backend.guards import (
    reject_if_retired as _reject_if_retired,
    require_agent as _require_agent,
    require_container_active as _require_container_active,
    valid_uuid as _valid_uuid,
)
from portal_backend.limits import MAX_PROTOCOL_FIELD_LEN
from portal_backend.protocol_helpers import _build_report_back, _clean_protocol
from portal_backend.request_lookup import require_request
from portal_backend.schemas.requests import TaskRequestAccept
from portal_backend.worker_auth import require_work_lane as _require_work_lane

_attribute_token_run_to_task_getter = None


def configure_compatibility(attribute_token_run_to_task_getter):
    """Bind the facade-owned current-run attribution seam."""
    global _attribute_token_run_to_task_getter
    _attribute_token_run_to_task_getter = attribute_token_run_to_task_getter


@app.post("/api/requests/{rid}/accept-task", status_code=200)
def accept_task_request(
    rid: str,
    body: TaskRequestAccept,
    request: Request,
    x_orcha_run_token: Optional[str] = Header(default=None, alias="X-Orcha-Run-Token"),
):
    """Target accepts a task request → creates the task, assigns it, marks request 'accepted'."""
    if not _valid_uuid(rid):
        raise HTTPException(400, "request_id is not a valid UUID")
    if not _valid_uuid(body.responder_agent_id):
        raise HTTPException(400, "responder_agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        r = require_request(
            cur, rid, for_update=True
        )  # lock: serialize overlapping retries
        # SEAM A (#211): default no-op resolve/authorize; downstream overridable.
        resolved_actor = resolve_actor(cur, request, str(r["container_id"]), body.responder_agent_id)
        authorize(cur, request, resolved_actor, "respond_request", str(r["container_id"]))
        # GH #91/#90: accepting a task request creates an agent_tasks 'working' row — that is moving a
        # task INTO working, which is WORK-lane only. Gate on the ACCEPTING agent (the target /
        # responder). A conversation-lane embodiment can DISPATCH a task (create/assign a request) but
        # cannot accept one into its own working set (403).
        _require_work_lane(cur, body.responder_agent_id, x_orcha_run_token)
        _reject_if_retired(
            cur, body.responder_agent_id
        )  # ISS-51 [P1]: retired can't take on work
        _require_container_active(
            cur, str(r["container_id"]), body.responder_agent_id
        )  # GH #24
        if r["type"] != "task":
            raise HTTPException(
                409, f"request type is '{r['type']}', not 'task' — cannot accept-task"
            )
        # Check actor first so a non-target always gets 403, regardless of status.
        if str(r["target_id"]) != body.responder_agent_id:
            raise HTTPException(403, "only the target agent may accept")
        # R2.3 idempotency: the target re-accepting an already-accepted task request gets
        # the SAME spawned task back (200) — so a retry never spawns a duplicate task.
        # 'rejected'/other states are genuine illegal transitions (409).
        # GH #56 (review P-retry): the retry MUST echo the report-back instruction too. If the
        # first accept response was lost, this idempotent retry is the only thing the same worker
        # session sees — returning the old instruction-less shape would let it miss report-back and
        # fall through to the Point 5 backstop. Rebuild it deterministically from the request detail.
        if r["status"] == "accepted":
            _retry_dod = (r["detail"] or {}).get("definition_of_done") or ""
            if r["spawned_task_id"]:
                _attribute_token_run_to_task_getter()(
                    cur,
                    body.responder_agent_id,
                    x_orcha_run_token,
                    str(r["spawned_task_id"]),
                )
                conn.commit()
            return {
                "request_id": rid,
                "status": "accepted",
                "spawned_task_id": str(r["spawned_task_id"])
                if r["spawned_task_id"]
                else None,
                "report_back": _build_report_back(rid, _retry_dod),
                "report_back_request_id": rid,
                "already_accepted": True,
            }
        if r["status"] != "open":
            raise HTTPException(
                409, f"request is '{r['status']}', not 'open' — cannot accept"
            )
        task = r["detail"] or {}
        if "title" not in task or "definition_of_done" not in task:
            raise HTTPException(
                500, "request detail is malformed; cannot synthesize a task"
            )
        # GH #55: if the request carried a protocol, populate it on the spawned task so the
        # accepter reads its loop rules on the very wake this accept triggers (no follow-up PATCH).
        # GH #56 (Point 4.4/4.5): also auto-inject a report-back instruction into protocol.notes —
        # this is HOW the accepter learns to report back (it's in the protocol it reads every wake).
        # It spells out what "materially done" means for THIS request (the definition_of_done) and
        # is explicitly decoupled from /orcha-done (reporting back ≠ sending the task to verification).
        cleaned_proto = _clean_protocol(task.get("protocol")) or {}
        dod = (task.get("definition_of_done") or "").strip()
        # GH #56 (review P-retry): same builder as the idempotent-retry branch above, so the
        # fresh accept and a lost-response retry hand back the identical report-back instruction.
        report_back = _build_report_back(rid, dod)
        existing_notes = (cleaned_proto.get("notes") or "").strip()
        # GH #56 (Point 4.4/4.5, review P2): the report-back instruction is the MECHANISM that
        # tells the accepter to answer the request, so it must survive the per-field cap intact.
        # Prepend it and trim only the OLDER carried notes — never tail-truncate, or a near-max
        # carried `notes` would silently drop the whole REPORT BACK line and the answer waypoint
        # would be lost. report_back is well under the cap, but clamp defensively regardless.
        if existing_notes:
            sep = "\n\n"
            room = MAX_PROTOCOL_FIELD_LEN - len(report_back) - len(sep)
            merged_notes = (
                report_back + sep + existing_notes[:room] if room > 0 else report_back
            )
        else:
            merged_notes = report_back
        cleaned_proto["notes"] = merged_notes
        protocol_json = json.dumps(cleaned_proto)
        # Create the task, assign to the accepter, start it.
        cur.execute(
            """INSERT INTO tasks
                 (container_id, title, description, definition_of_done,
                  status, priority, created_by_agent_id, protocol, started_at)
               VALUES (%s, %s, %s, %s, 'in_progress', %s, %s, %s::jsonb, now())
               RETURNING id""",
            (
                str(r["container_id"]),
                task["title"],
                task.get("description"),
                task["definition_of_done"],
                task.get("priority", 100),
                str(r["requester_id"]),
                protocol_json,
            ),
        )
        tid = str(cur.fetchone()["id"])
        cur.execute(
            "INSERT INTO agent_tasks (agent_id, task_id, assignment_status) VALUES (%s, %s, 'working')",
            (body.responder_agent_id, tid),
        )
        # Mark the request as accepted, point at the spawned task.
        cur.execute(
            "UPDATE requests SET status='accepted', response=%s, responded_at=now(), spawned_task_id=%s WHERE id=%s",
            (body.note, tid, rid),
        )
        bump_agent(cur, body.responder_agent_id)
        recompute_agent_status(cur, body.responder_agent_id)
        recompute_agent_status(cur, str(r["requester_id"]))
        log_event(
            cur,
            r["container_id"],
            "ai",
            body.responder_agent_id,
            "request",
            rid,
            "accepted",
            {"spawned_task_id": tid, "note": body.note},
        )
        log_event(
            cur,
            r["container_id"],
            "ai",
            body.responder_agent_id,
            "task",
            tid,
            "created",
            {"title": task["title"], "via": "task-request accept"},
        )
        _attribute_token_run_to_task_getter()(
            cur, body.responder_agent_id, x_orcha_run_token, tid
        )
        # GH #56 (Point 6): accept must NOT wake the requester — only the real ANSWER (at material
        # completion) wakes them. The accept stays in the audit feed via log_event above, but we no
        # longer publish a wake-worthy `task_request_accepted` event toward the requester (it was
        # classified as a `request_answered` notification — a premature receipt). Accept is silent now.
        # GH #58: accepting CONSUMES the target's NEW_WORK request_created notification (the accept IS
        # the handling; the spawned task drives the work) so it stops re-waking the responder.
        _ack_events_handled(
            cur, body.responder_agent_id, "request_created", "request_id", rid
        )
        conn.commit()
    # GH #56 (review P1): the same worker session that accepts a task-request keeps working it
    # WITHOUT reloading the spawned task's protocol, so the report-back note buried in
    # protocol.notes is invisible on this wake — the primary accepted->answered path gets skipped
    # and the Point 5 backstop becomes the normal route. Echo the instruction in the accept
    # RESPONSE so /orcha-accept-task can surface it immediately, in the same session, before the
    # agent starts the work.
    return {
        "request_id": rid,
        "status": "accepted",
        "spawned_task_id": tid,
        "report_back": report_back,
        "report_back_request_id": rid,
    }
