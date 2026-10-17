"""Stream container events and escalate expired agent requests."""

import json
import time
from typing import Optional

from fastapi import HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.events import (
    install_stream_shutdown_hook,
    publish_event,
    shutting_down,
    wait_for_event,
)
from portal_backend.guards import (
    pick_human,
    require_container,
    require_kind,
    valid_uuid,
)
from portal_backend.identity_routes import (
    enforce_grant,
    require_member_read,
    trusted_actor,
)
from portal_backend.org_chart import route_via_manager, stamp_routing


# Parity r2: SSE streams end on SIGINT/SIGTERM so uvicorn's graceful stop can finish
# (events.install_stream_shutdown_hook). Startup runs after uvicorn captured signals.
app.on_event("startup")(install_stream_shutdown_hook)


@app.get("/api/containers/{cid}/events")
async def container_events(
    cid: str, request: Request, since_ts: float = Query(default=0.0)
):
    """SSE stream of container-wide events (escalations, suggestions) for dashboards / humans."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        # Access model: reads are project-isolated (trusted non-member 403).
        require_member_read(cur, request, cid)
    key = f"c:{cid}"

    async def event_stream():
        cursor_ts = since_ts
        while not shutting_down():  # parity r2: end on SIGTERM (events.py)
            event = await wait_for_event(key, cursor_ts, 15.0)
            if event is None:
                yield f": heartbeat {int(time.time())}\n\n"
            else:
                cursor_ts = event["ts"]
                yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/api/containers/{cid}/sweep", status_code=200)
def sweep_expired(cid: str, http_request: Request, actor_agent_id: str = Query(...)):
    """Escalate any open requests past expires_at — re-targets at a human (Orcha#30)."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (connection, cur):
        require_container(cur, cid)
        # Per-project identity: a trusted proxy login IS the actor (403 non-member).
        # Access model: forcing the escalation sweep is owner-or-manage_autonomy
        # (the daemon's headerless lane passes through unchanged).
        enforce_grant(cur, http_request, cid, "manage_autonomy")
        actor_agent_id = trusted_actor(cur, http_request, cid, actor_agent_id)
        require_kind(cur, actor_agent_id, ("human",))
        cur.execute(
            """SELECT r.id, r.target_id, r.requester_id FROM requests r
               JOIN agents a ON a.id = r.target_id
               WHERE r.container_id=%s AND r.status='open'
                 AND r.expires_at IS NOT NULL AND r.expires_at < now()
                 AND a.kind = 'ai'
                 -- mig 057: an AI manager's pre-review is advisory; the human reviewer
                 -- already holds the task, so it is never escalated as a second ask.
                 AND COALESCE(r.detail->>'kind', '') <> 'manager_review'""",
            (cid,),
        )
        expired = cur.fetchall()
        fallback_human: Optional[str] = None
        for request in expired:
            request_id = str(request["id"])
            # Org chart (mig 052): the requester's nearest actionable manager first (viewers /
            # AI managers skipped), else the project-wide pick (resolved once, lazily — it
            # still 409s when nobody can act, exactly as before).
            requester = str(request["requester_id"]) if request["requester_id"] else None
            human_id, org_routing = route_via_manager(
                cur, cid, requester, exclude_ids=(requester,)
            )
            if human_id is None:
                if fallback_human is None:
                    fallback_human = pick_human(cur, cid)
                human_id = fallback_human
            cur.execute(
                "UPDATE requests SET target_id=%s WHERE id=%s",
                (human_id, request["id"]),
            )
            stamp_routing(cur, request_id, org_routing)
            log_event(
                cur,
                cid,
                "system",
                None,
                "request",
                request_id,
                "escalated",
                {
                    "reason": "expires_at passed (sweep)",
                    "to_human_id": human_id,
                    # Parity r1: the expired AI target it was escalated away from.
                    "from_target_id": str(request["target_id"]),
                },
            )
            publish_event(
                cur,
                cid,
                human_id,
                "request_created",
                {"request_id": request_id, "via": "expires_at sweep"},
            )
            publish_event(
                cur,
                cid,
                None,
                "request_escalated",
                {"request_id": request_id, "reason": "expires_at passed (sweep)"},
            )
        connection.commit()
    return {
        "escalated_count": len(expired),
        "request_ids": [str(request["id"]) for request in expired],
    }
