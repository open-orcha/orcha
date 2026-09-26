"""Convert an answered information request into delegated work."""

import json
from typing import Optional

from fastapi import HTTPException, Request

from portal_backend.agent_status import bump_agent, log_event, recompute_agent_status
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.event_acknowledgement import _ack_events_handled
from portal_backend.events import publish_event as _publish_event
from portal_backend.guards import (
    require_container_active as _require_container_active,
    resolve_alias as _resolve_alias,
    valid_uuid as _valid_uuid,
)
from portal_backend.identity_routes import trusted_actor as _trusted_actor
from portal_backend.request_lookup import require_request
from portal_backend.schemas.requests import RequestConvert


@app.post("/api/requests/{rid}/convert-to-task", status_code=200)
def convert_to_task(rid: str, body: RequestConvert, request: Request):
    """Convert an answered info request into a real task (e.g. answer was insufficient and warrants work).

    Request moves from 'answered' → 'converted_to_task'; a new task is created with optional
    assignee. Spawned_task_id is recorded so /requests can show the link.
    """
    if not _valid_uuid(rid):
        raise HTTPException(400, "request_id is not a valid UUID")
    if not _valid_uuid(body.requester_agent_id):
        raise HTTPException(400, "requester_agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        r = require_request(
            cur, rid, for_update=True
        )  # lock: serialize all request-state mutations
        # Per-project identity: a trusted proxy login IS the actor (403 non-member).
        body.requester_agent_id = _trusted_actor(
            cur, request, str(r["container_id"]), body.requester_agent_id
        )
        _require_container_active(
            cur, str(r["container_id"]), body.requester_agent_id
        )  # GH #24 (human may still convert)
        if r["status"] != "answered":
            raise HTTPException(
                409, f"request is '{r['status']}', not 'answered' — cannot convert"
            )
        if str(r["requester_id"]) != body.requester_agent_id:
            raise HTTPException(403, "only the requester may convert")
        if r["type"] != "info":
            raise HTTPException(
                409, f"only info requests can be converted (this is '{r['type']}')"
            )
        assignee_id: Optional[str] = None
        if body.assignee_alias:
            assignee_id = _resolve_alias(
                cur, str(r["container_id"]), body.assignee_alias
            )
        initial_status = "in_progress" if assignee_id else "ready"
        started_clause = "now()" if assignee_id else "NULL"
        cur.execute(
            f"""INSERT INTO tasks
                  (container_id, title, description, definition_of_done,
                   status, priority, created_by_agent_id, started_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, {started_clause})
                RETURNING id""",
            (
                str(r["container_id"]),
                body.title,
                f"Converted from request {rid[:8]}…",
                body.definition_of_done,
                initial_status,
                body.priority,
                body.requester_agent_id,
            ),
        )
        tid = str(cur.fetchone()["id"])
        if assignee_id:
            cur.execute(
                "INSERT INTO agent_tasks (agent_id, task_id, assignment_status) VALUES (%s, %s, 'working')",
                (assignee_id, tid),
            )
            # ISS-86 / #245 (GAP A): don't bump_agent(assignee) — see create_task. Resetting the
            # cold assignee's heartbeat would suppress the task_assigned wake below. The requester
            # (the actor doing the convert) IS active and is still bumped further down.
            recompute_agent_status(cur, assignee_id)
        cur.execute(
            "UPDATE requests SET status='converted_to_task', spawned_task_id=%s, closed_at=now() WHERE id=%s",
            (tid, rid),
        )
        bump_agent(cur, body.requester_agent_id)
        recompute_agent_status(cur, body.requester_agent_id)
        log_event(
            cur,
            r["container_id"],
            "ai",
            body.requester_agent_id,
            "request",
            rid,
            "converted_to_task",
            {
                "spawned_task_id": tid,
                "title": body.title,
                "assignee_alias": body.assignee_alias,
            },
        )
        log_event(
            cur,
            r["container_id"],
            "ai",
            body.requester_agent_id,
            "task",
            tid,
            "created",
            {"title": body.title, "via": "info-request conversion"},
        )
        if assignee_id:
            _publish_event(
                cur,
                str(r["container_id"]),
                assignee_id,
                "task_assigned",
                {
                    "task_id": tid,
                    "title": body.title,
                    "via": "converted from info request",
                },
            )
        # GH #58: converting terminally resolves the original request — if the target still had a
        # pending request_created for it, ack it so it stops re-surfacing (mirrors close/escalate).
        if r["target_id"]:
            _ack_events_handled(
                cur, str(r["target_id"]), "request_created", "request_id", rid
            )
        conn.commit()
    return {
        "request_id": rid,
        "status": "converted_to_task",
        "spawned_task_id": tid,
        "assignee_alias": body.assignee_alias,
    }


# ---------- A3: prompt-event (wake an agent with a directed message) ----------
