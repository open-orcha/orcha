"""Read requests and record target responses."""

from fastapi import HTTPException, Request

from portal_backend.agent_status import bump_agent, log_event, recompute_agent_status
from portal_backend.application import app
from portal_backend.auth_provider import authorize, resolve_actor
from portal_backend.database import db_cursor
from portal_backend.events import publish_event as _publish_event
from portal_backend.guards import (
    reject_if_retired as _reject_if_retired,
    require_container_active as _require_container_active,
    valid_uuid as _valid_uuid,
)
from portal_backend.request_lookup import require_request
from portal_backend.schemas.requests import RequestRespond


@app.get("/api/requests/{rid}")
def get_request(rid: str):
    """Read a single request by id. Read-only, localhost posture like wake-scan/wake-ack.

    GH#36: the notifier daemon calls this to decide whether a graded `ack_close` wake is still
    ACTIONABLE (status='answered' — there is a real answer to acknowledge + close) or a resolved
    NO-OP (closed/escalated/gone) it should NOT spend a full headless boot on. Booting a worker for
    an already-resolved request is exactly the empty-inbox boot→stall→watchdog-kill loop this read
    breaks: the daemon advances the wake cursor instead of spawning."""
    if not _valid_uuid(rid):
        raise HTTPException(400, "request_id is not a valid UUID")
    with db_cursor() as (_, cur):
        r = require_request(cur, rid)  # 404 if missing
        return {
            "request_id": str(r["id"]),
            "type": r["type"],
            "status": r["status"],
            "requester_id": str(r["requester_id"]) if r["requester_id"] else None,
            "target_id": str(r["target_id"]) if r["target_id"] else None,
        }


@app.post("/api/requests/{rid}/respond", status_code=200)
def respond_request(rid: str, body: RequestRespond, request: Request):
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
        _reject_if_retired(cur, body.responder_agent_id)  # ISS-51 [P1]
        _require_container_active(
            cur, str(r["container_id"]), body.responder_agent_id
        )  # GH #24
        # Orcha#30: target_id is never null now (humans are agents with rows).
        # Only the target — agent or human — may answer. Check actor FIRST so a wrong
        # actor always gets 403, regardless of the request's current status.
        if r["target_id"] is None or str(r["target_id"]) != body.responder_agent_id:
            raise HTTPException(403, "only the target agent may respond")
        # R2.3 idempotency: the correct target re-responding to an already-answered
        # request gets the current state (200), not a 409 — so an at-least-once retry
        # after a dropped response is a safe no-op. Other terminal states (closed,
        # accepted) are genuine illegal transitions and still 409.
        if r["status"] == "answered":
            return {
                "request_id": rid,
                "status": "answered",
                "already_answered": True,
                "response": r["response"],
                "unblocks_parent": None,
            }
        # GH #56 (Point 4): `accepted` is now a WAYPOINT, not a dead end. The accepter
        # (still the target) may post its real result to flip accepted → answered, which
        # fires the answer notification so the requester wakes on its originating_task_id.
        # The requester — not the accepter — later flips answered → closed (close_request).
        if r["status"] not in ("open", "accepted"):
            raise HTTPException(
                409,
                f"request is '{r['status']}', not 'open'/'accepted' — cannot respond",
            )
        cur.execute(
            "UPDATE requests SET status='answered', response=%s, responded_at=now() WHERE id=%s",
            (body.response, rid),
        )
        bump_agent(cur, body.responder_agent_id)
        recompute_agent_status(cur, body.responder_agent_id)  # just acted
        # The requester might also need recomputation if this answered their only open ask
        recompute_agent_status(cur, str(r["requester_id"]))
        log_event(
            cur,
            r["container_id"],
            "ai",
            body.responder_agent_id,
            "request",
            rid,
            "answered",
            {
                "preview": body.response[:120],
                "parent_request_id": str(r["parent_request_id"])
                if r["parent_request_id"]
                else None,
                "chain_depth": r["chain_depth"],
            },
        )

        # If this answered request had a parent, surface it in the response so the requester
        # (who is the target of the parent) knows their parent task is now unblocked. The
        # requester sees this naturally via /orcha-outbox; the response field is a convenience
        # for callers who want to chain logic immediately.
        unblocks_parent = None
        if r["parent_request_id"]:
            cur.execute(
                """SELECT p.id, p.payload, p.status, t.alias AS target_alias
                   FROM requests p LEFT JOIN agents t ON t.id = p.target_id
                   WHERE p.id = %s""",
                (str(r["parent_request_id"]),),
            )
            parent = cur.fetchone()
            if parent:
                unblocks_parent = {
                    "parent_request_id": str(parent["id"]),
                    "parent_target_alias": parent["target_alias"],
                    "parent_status": parent["status"],
                    "parent_payload_preview": (parent["payload"] or "")[:120],
                }
        # GH #56 (Point 3 / FLAG 2a): carry originating_task_id on the answer event so the
        # requester's wake attaches to the task it asked on behalf of (wake-scan reads this →
        # the run is stamped against that task → activity surfaces on the task thread, and the
        # protocol loaded is that task's). Null for conversation/taskless asks (unchanged path).
        _publish_event(
            cur,
            str(r["container_id"]),
            str(r["requester_id"]),
            "request_answered",
            {
                "request_id": rid,
                "preview": body.response[:120],
                "originating_task_id": str(r["originating_task_id"])
                if r["originating_task_id"]
                else None,
            },
        )
        conn.commit()
    return {"request_id": rid, "status": "answered", "unblocks_parent": unblocks_parent}
