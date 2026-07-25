"""Auto-close pure acknowledgements or escalate requests to the human operator."""

from fastapi import HTTPException

from portal_backend.agent_status import bump_agent, log_event, recompute_agent_status
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.event_acknowledgement import _ack_events_handled
from portal_backend.events import publish_event as _publish_event
from portal_backend.guards import (
    pick_human as _pick_human,
    reject_if_retired as _reject_if_retired,
    require_container_active as _require_container_active,
    valid_uuid as _valid_uuid,
)
from portal_backend.request_lookup import require_request
from portal_backend.schemas.requests import RequestActorBody, TriageCloseBody


@app.post("/api/requests/{rid}/triage-close", status_code=200)
def triage_close_request(rid: str, body: TriageCloseBody):
    """#288: the notifier daemon closes an ANSWERED request whose answer was a pure ack — a
    no-action wake that would otherwise cost a full ephemeral spawn just to close the request.

    Deliberately DISTINCT from POST /api/requests/{rid}/close (an INTERNAL daemon endpoint,
    mirroring the wake-scan / wake-ack posture — localhost, not agent-authenticated):
      - records ``actor_type='system'`` / ``actor_id=NULL`` — it NEVER impersonates the requester
        (aligns with #271 actor-hardening); the dedicated path is exactly why a system close
        doesn't masquerade as the answerer or requester.
      - acts ONLY on a request in ``answered`` status (a ``closed`` one is an idempotent no-op;
        any other status is refused) — the precise no-action window, so it cannot be used to
        force-close an open/escalated request.
      - stamps ``{auto:true, reason:'triage_skip', triage_reason}`` into the ``request_closed``
        event JSONB (and the audit row) so #289 can measure suppressions with no migration.

    NOTE: there is no pre-existing daemon-auth primitive to bind to (wake-scan/wake-ack are
    unauthenticated localhost endpoints); the answered-only state gate + system-actor stamping are
    the v1 guardrails. A shared daemon token is a sensible follow-up (#247-adjacent) — flagged."""
    if not _valid_uuid(rid):
        raise HTTPException(400, "request_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        r = require_request(
            cur, rid, for_update=True
        )  # lock: serialize against a concurrent close
        if r["status"] == "closed":
            return {"request_id": rid, "status": "closed", "already_closed": True}
        if r["status"] != "answered":
            raise HTTPException(
                409,
                f"request is '{r['status']}', not 'answered' — triage-close only "
                f"closes a pure-ack answered request",
            )
        triage_reason = (body.triage_reason or "").strip()[:500]
        cur.execute(
            "UPDATE requests SET status='closed', closed_at=now() WHERE id=%s", (rid,)
        )
        # the requester's waiting_on changed — recompute its status, but DON'T bump_agent: this is a
        # system cleanup, not an action by the requester (must not inflate its turns_used/budget).
        recompute_agent_status(cur, str(r["requester_id"]))
        stamp = {"auto": True, "reason": "triage_skip", "triage_reason": triage_reason}
        log_event(
            cur, r["container_id"], "system", None, "request", rid, "closed", stamp
        )
        if r["target_id"]:
            _publish_event(
                cur,
                str(r["container_id"]),
                str(r["target_id"]),
                "request_closed",
                {"request_id": rid, **stamp},
            )
        conn.commit()
    return {"request_id": rid, "status": "closed", "auto": True}


@app.post("/api/requests/{rid}/escalate", status_code=200)
def escalate_request(rid: str, body: RequestActorBody):
    """Requester re-targets the request at a human (Orcha#30: target stays set; just becomes the human's id)."""
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
        if r["status"] not in ("open", "answered"):
            raise HTTPException(409, f"request is '{r['status']}' — cannot escalate")
        if str(r["requester_id"]) != body.requester_agent_id:
            raise HTTPException(403, "only the requester may escalate")
        human_id = _pick_human(cur, str(r["container_id"]))
        cur.execute(
            "UPDATE requests SET target_id=%s, status='open' WHERE id=%s",
            (human_id, rid),
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
            "escalated",
            {
                "reason": body.reason,
                "from_status": r["status"],
                "to_human_id": human_id,
            },
        )
        # Notify the human directly + the container channel for any dashboards.
        _publish_event(
            cur,
            str(r["container_id"]),
            human_id,
            "request_created",
            {
                "request_id": rid,
                "type": r["type"],
                "from_agent_id": body.requester_agent_id,
                "preview": (r["payload"] or "")[:120],
                "via": "escalated",
            },
        )
        _publish_event(
            cur,
            str(r["container_id"]),
            None,
            "request_escalated",
            {"request_id": rid, "reason": body.reason, "to_human_id": human_id},
        )
        # GH #58: escalation re-routes this request to a human; if it was a TASK request the original
        # agent target never accept/rejected, resolve its NEW_WORK request_created so it doesn't pin.
        if r["target_id"]:
            _ack_events_handled(
                cur, str(r["target_id"]), "request_created", "request_id", rid
            )
        conn.commit()
    return {
        "request_id": rid,
        "status": "open",
        "target_id": human_id,
        "escalated": True,
    }


# ---------- Phase 3 / Orcha#5: task requests + agent-suggestion ----------
