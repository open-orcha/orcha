"""Reject delegated work or propose a better-suited agent."""

import json

from fastapi import HTTPException

from portal_backend.agent_status import bump_agent, log_event, recompute_agent_status
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.event_acknowledgement import _ack_events_handled
from portal_backend.events import poke_path_forward as _poke_path_forward
from portal_backend.events import publish_event as _publish_event
from portal_backend.guards import (
    pick_human as _pick_human,
    require_container_active as _require_container_active,
    resolve_alias as _resolve_alias,
    valid_uuid as _valid_uuid,
)
from portal_backend.request_lookup import require_request
from portal_backend.schemas.requests import AgentSuggestion, TaskRequestReject


@app.post("/api/requests/{rid}/reject-task", status_code=200)
def reject_task_request(rid: str, body: TaskRequestReject):
    """Target rejects a task request with a reason; requester can then re-ask, suggest agent, or escalate."""
    if not _valid_uuid(rid):
        raise HTTPException(400, "request_id is not a valid UUID")
    if not _valid_uuid(body.responder_agent_id):
        raise HTTPException(400, "responder_agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        r = require_request(
            cur, rid, for_update=True
        )  # lock: serialize all request-state mutations
        _require_container_active(
            cur, str(r["container_id"]), body.responder_agent_id
        )  # GH #24
        if r["type"] != "task":
            raise HTTPException(
                409, f"request type is '{r['type']}', not 'task' — cannot reject-task"
            )
        if r["status"] != "open":
            raise HTTPException(
                409, f"request is '{r['status']}', not 'open' — cannot reject"
            )
        if r["target_id"] is None or str(r["target_id"]) != body.responder_agent_id:
            raise HTTPException(403, "only the target agent may reject")
        cur.execute(
            "UPDATE requests SET status='rejected', rejection_reason=%s, responded_at=now() WHERE id=%s",
            (body.reason, rid),
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
            "rejected",
            {"reason": body.reason},
        )
        _publish_event(
            cur,
            str(r["container_id"]),
            str(r["requester_id"]),
            "task_request_rejected",
            {"request_id": rid, "reason": body.reason},
        )
        # ISS-42 (B12): don't strand the requester at a dead-end. The machine event above wakes them
        # but carries no surfaced content; poke them with the reason + the three concrete paths forward
        # (re-ask, suggest a different agent, escalate to a human) so the rejection becomes actionable.
        reason_txt = (body.reason or "").strip() or "(no reason given)"
        _poke_path_forward(
            cur,
            str(r["container_id"]),
            str(r["requester_id"]),
            body.responder_agent_id,
            f"Your task request (id {rid}) was rejected: {reason_txt}. You're not stuck — pick a path "
            f"forward: re-ask another agent (/orcha-ask --task), propose a new agent for it "
            f"(/orcha-suggest-agent {rid}), or escalate to a human (/orcha-escalate {rid}).",
        )
        # GH #58: rejecting CONSUMES the target's NEW_WORK request_created notification so it stops
        # re-waking the responder (the work is now back with the requester to re-route).
        _ack_events_handled(
            cur, body.responder_agent_id, "request_created", "request_id", rid
        )
        conn.commit()
    return {
        "request_id": rid,
        "status": "rejected",
        "reason": body.reason,
        "requester_poked": True,
    }


@app.post("/api/requests/{rid}/suggest-agent", status_code=200)
def suggest_agent(rid: str, body: AgentSuggestion):
    """Requester escalates with a structured proposal: 'please create a new agent X with role Y'.

    The request stays status='open' (target=null) so it appears in the human's escalations queue
    alongside other escalated items, but with `detail.proposed_*` populated so the human can
    /decide-suggestion to create, reassign, or refuse.
    """
    if not _valid_uuid(rid):
        raise HTTPException(400, "request_id is not a valid UUID")
    if not _valid_uuid(body.requester_agent_id):
        raise HTTPException(400, "requester_agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        r = require_request(
            cur, rid, for_update=True
        )  # lock: serialize all request-state mutations
        _require_container_active(
            cur, str(r["container_id"]), body.requester_agent_id
        )  # GH #24
        if r["status"] not in ("open", "answered", "rejected"):
            raise HTTPException(
                409, f"request is '{r['status']}' — cannot escalate-with-suggestion"
            )
        if str(r["requester_id"]) != body.requester_agent_id:
            raise HTTPException(403, "only the requester may suggest an agent")
        # Merge the suggestion into the request's `detail`, alongside any existing task payload.
        existing = r["detail"] or {}
        existing["proposed_alias"] = body.proposed_alias
        existing["proposed_role"] = body.proposed_role
        existing["proposed_prompt"] = body.proposed_prompt
        existing["rationale"] = body.rationale
        # Orcha#30: re-target at the container's human instead of nulling target_id.
        # detail.proposed_alias is what distinguishes a suggestion from a plain re-target.
        human_id = _pick_human(cur, str(r["container_id"]))
        cur.execute(
            """UPDATE requests
                 SET target_id=%s, status='open', detail=%s::jsonb
                 WHERE id=%s""",
            (human_id, json.dumps(existing), rid),
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
            "agent_suggested",
            {
                "proposed_alias": body.proposed_alias,
                "proposed_role": body.proposed_role,
                "rationale": body.rationale[:120],
                "to_human_id": human_id,
            },
        )
        _publish_event(
            cur,
            str(r["container_id"]),
            human_id,
            "agent_suggested",
            {
                "request_id": rid,
                "proposed_alias": body.proposed_alias,
                "from_agent_id": body.requester_agent_id,
            },
        )
        conn.commit()
    return {
        "request_id": rid,
        "status": "open",
        "target_id": None,
        "suggestion": {
            "proposed_alias": body.proposed_alias,
            "proposed_role": body.proposed_role,
            "rationale": body.rationale,
        },
    }
