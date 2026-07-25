"""Stream container events and escalate expired agent requests."""

import json
import time
from typing import Optional

from fastapi import HTTPException, Query
from fastapi.responses import StreamingResponse

from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.events import publish_event, wait_for_event
from portal_backend.guards import (
    pick_human,
    require_container,
    require_kind,
    valid_uuid,
)


@app.get("/api/containers/{cid}/events")
async def container_events(cid: str, since_ts: float = Query(default=0.0)):
    """SSE stream of container-wide events (escalations, suggestions) for dashboards / humans."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (_, cur):
        require_container(cur, cid)
    key = f"c:{cid}"

    async def event_stream():
        cursor_ts = since_ts
        while True:
            event = await wait_for_event(key, cursor_ts, 15.0)
            if event is None:
                yield f": heartbeat {int(time.time())}\n\n"
            else:
                cursor_ts = event["ts"]
                yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/api/containers/{cid}/sweep", status_code=200)
def sweep_expired(cid: str, actor_agent_id: str = Query(...)):
    """Escalate any open requests past expires_at — re-targets at a human (Orcha#30)."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (connection, cur):
        require_kind(cur, actor_agent_id, ("human",))
        require_container(cur, cid)
        cur.execute(
            """SELECT r.id, r.target_id FROM requests r
               JOIN agents a ON a.id = r.target_id
               WHERE r.container_id=%s AND r.status='open'
                 AND r.expires_at IS NOT NULL AND r.expires_at < now()
                 AND a.kind = 'ai'""",
            (cid,),
        )
        expired = cur.fetchall()
        human_id: Optional[str] = pick_human(cur, cid) if expired else None
        for request in expired:
            request_id = str(request["id"])
            cur.execute(
                "UPDATE requests SET target_id=%s WHERE id=%s",
                (human_id, request["id"]),
            )
            log_event(
                cur,
                cid,
                "system",
                None,
                "request",
                request_id,
                "escalated",
                {"reason": "expires_at passed (sweep)", "to_human_id": human_id},
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
