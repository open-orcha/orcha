"""Close answered requests and route authoritative close reasons."""

from fastapi import HTTPException, Request

from portal_backend.agent_status import bump_agent, log_event, recompute_agent_status
from portal_backend.application import app
from portal_backend.auth_provider import authorize, resolve_actor
from portal_backend.database import db_cursor
from portal_backend.decision_routing import _route_close_reason
from portal_backend.event_acknowledgement import _ack_events_handled
from portal_backend.events import poke_path_forward as _poke_path_forward
from portal_backend.events import publish_event as _publish_event
from portal_backend.guards import (
    require_container_active as _require_container_active,
    valid_uuid as _valid_uuid,
)
from portal_backend.request_lookup import require_request
from portal_backend.schemas.requests import RequestActorBody


@app.post("/api/requests/{rid}/close", status_code=200)
def close_request(rid: str, body: RequestActorBody, request: Request):
    if not _valid_uuid(rid):
        raise HTTPException(400, "request_id is not a valid UUID")
    if not _valid_uuid(body.requester_agent_id):
        raise HTTPException(400, "requester_agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        r = require_request(
            cur, rid, for_update=True
        )  # lock: serialize overlapping retries
        # SEAM A (#211): default no-op resolve/authorize; downstream overridable.
        resolved_actor = resolve_actor(cur, request, str(r["container_id"]), body.requester_agent_id)
        authorize(cur, request, resolved_actor, "close_request", str(r["container_id"]))
        _require_container_active(
            cur, str(r["container_id"]), body.requester_agent_id
        )  # GH #24 (human may still close)
        # B7 (ISS-23): the actor may be the requester (owner) OR ANY human — the human is the
        # authoritative party and can abandon a stale request regardless of owner. Non-humans
        # stay owner-only and get a 403, regardless of status.
        cur.execute("SELECT kind FROM agents WHERE id=%s", (body.requester_agent_id,))
        arow = cur.fetchone()
        if not arow:
            raise HTTPException(404, f"agent {body.requester_agent_id} not found")
        is_human = arow["kind"] == "human"
        is_owner = str(r["requester_id"]) == body.requester_agent_id
        if not is_human and not is_owner:
            raise HTTPException(403, "only the requester (or a human) may close")
        # R2.3 idempotency: re-closing an already-closed request is a safe no-op (200).
        if r["status"] == "closed":
            return {"request_id": rid, "status": "closed", "already_closed": True}
        # Non-humans keep the answered-only rule; a human may force-close from any non-closed
        # status (authoritative abandon).
        if not is_human and r["status"] != "answered":
            raise HTTPException(
                409, f"request is '{r['status']}', not 'answered' — cannot close"
            )
        # B7.2: a human closing a request they do NOT own must give a reason — it's routed to
        # the owner so it learns why (the API enforces this, not only the UI).
        reason = (body.reason or "").strip()
        forced = is_human and not is_owner
        if forced and not reason:
            raise HTTPException(
                422,
                {
                    "error": "reason_required",
                    "detail": "a reason is required when a human closes another agent's request",
                },
            )
        cur.execute(
            "UPDATE requests SET status='closed', closed_at=now() WHERE id=%s", (rid,)
        )
        # Recompute the OWNER (requester) — its waiting_on changed.
        bump_agent(cur, str(r["requester_id"]))
        recompute_agent_status(cur, str(r["requester_id"]))
        log_event(
            cur,
            r["container_id"],
            ("human" if is_human else "ai"),
            body.requester_agent_id,
            "request",
            rid,
            "closed",
            {"by_human": is_human, "forced": forced},
        )
        if r["target_id"]:
            _publish_event(
                cur,
                str(r["container_id"]),
                str(r["target_id"]),
                "request_closed",
                {"request_id": rid},
            )
            # GH #58: a TASK request closed before the target accepted/rejected would otherwise pin the
            # target's cursor on its NEW_WORK request_created (no accept/reject seam ever ran). Closing
            # terminally resolves it.
            _ack_events_handled(
                cur, str(r["target_id"]), "request_created", "request_id", rid
            )
        if forced:
            _route_close_reason(
                cur,
                r["container_id"],
                "request_close",
                rid,
                reason,
                body.requester_agent_id,
                str(r["requester_id"]),
            )
        conn.commit()
    return {"request_id": rid, "status": "closed", "forced_by_human": forced}
