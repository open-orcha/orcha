"""Deliver directed prompts, long-poll events, and agent event streams."""

import json
import time
from typing import Optional

from fastapi import HTTPException, Query
from fastapi.responses import StreamingResponse

from portal_backend.agent_status import log_event, touch_heartbeat
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.events import wait_for_event
from portal_backend.guards import require_agent, valid_uuid
from portal_backend.schemas.wakes import PromptEvent

_publish_prompt = None


def configure_compatibility(publish_prompt):
    """Bind the facade-owned prompt event compatibility seam."""
    global _publish_prompt
    _publish_prompt = publish_prompt


@app.post("/api/agents/{aid}/prompt", status_code=201)
def prompt_agent(aid: str, body: PromptEvent):
    """A3: wake an agent with a directed message.

    Publishes a `prompt` agent_event carrying `message` on the agent's key (so wake-scan counts
    it as pending work and the daemon wakes the agent) and on the container key (so dashboards /
    the thread see it). The woken headless worker is shown the message text in its wake prompt
    (see notifier.build_wake_prompt), so it acts on the prompt specifically rather than just
    'draining the inbox'. Keystone for B2 (prompt-from-portal) and B12 (poke / reject-loop).
    """
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    if body.from_agent_id is not None and not valid_uuid(body.from_agent_id):
        raise HTTPException(400, "from_agent_id is not a valid UUID")
    with db_cursor() as (connection, cur):
        agent = require_agent(cur, aid)
        payload = {"message": body.message, "from_agent_id": body.from_agent_id}
        _publish_prompt(cur, str(agent["container_id"]), aid, payload)
        log_event(
            cur,
            str(agent["container_id"]),
            "agent",
            body.from_agent_id,
            "agent",
            aid,
            "prompt_sent",
            {"chars": len(body.message)},
        )
        connection.commit()
    return {"agent_id": aid, "event": "prompt", "delivered": True}


def assigned_ready_task(cur, aid: str) -> Optional[str]:
    """Return the first assigned task the agent could auto-start."""
    cur.execute(
        """SELECT t.id FROM tasks t
           JOIN agent_tasks at ON at.task_id = t.id AND at.agent_id = %s
           WHERE t.container_id = (SELECT container_id FROM agents WHERE id = %s)
             AND t.status = 'ready' AND t.is_root = false
           ORDER BY t.priority, t.created_at LIMIT 1""",
        (aid, aid),
    )
    row = cur.fetchone()
    return str(row["id"]) if row else None


def agent_claim_blocked(cur, aid: str) -> bool:
    """Return whether the agent-level task claim preconditions currently fail."""
    cur.execute(
        """SELECT a.terminated_at, c.status AS container_status
           FROM agents a JOIN containers c ON c.id = a.container_id
           WHERE a.id = %s""",
        (aid,),
    )
    row = cur.fetchone()
    return bool(
        row is None
        or row["container_status"] != "active"
        or row["terminated_at"] is not None
    )


def _ready_probe(cur, aid, since_ts):
    cur.execute(
        "SELECT 1 FROM agent_events WHERE event_key=%s AND ts > %s LIMIT 1",
        (aid, since_ts),
    )
    if cur.fetchone() or agent_claim_blocked(cur, aid):
        return None
    return assigned_ready_task(cur, aid)


def _ready_event(task_id, since_ts):
    return {
        "event": "task_ready",
        "ts": since_ts,
        "task_id": task_id,
        "assigned": True,
    }


@app.get("/api/agents/{aid}/wait")
async def agent_wait(
    aid: str,
    since_ts: float = Query(default=0.0),
    timeout: float = Query(default=30.0, ge=1, le=120),
):
    """Long-poll for the next event addressed to this agent.

    Returns `{event, ts, ...}` or `{event: 'timeout'}` after `timeout` seconds.
    Pass `since_ts` (epoch seconds) from the last received event's `ts` to avoid replay.
    """
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (connection, cur):
        require_agent(cur, aid)
        cur.execute("UPDATE agents SET last_heartbeat_at = now() WHERE id = %s", (aid,))
        cur.execute(
            """INSERT INTO agent_wake_state (agent_id, work_last_heartbeat_at)
               VALUES (%s, now())
               ON CONFLICT (agent_id) DO UPDATE SET work_last_heartbeat_at = now()""",
            (aid,),
        )
        ready_task = _ready_probe(cur, aid, since_ts)
        connection.commit()
    if ready_task is not None:
        touch_heartbeat(aid)
        return _ready_event(ready_task, since_ts)
    event = await wait_for_event(aid, since_ts, timeout)
    touch_heartbeat(aid)
    if event is not None:
        return event
    with db_cursor() as (_, cur):
        ready_task = (
            None if agent_claim_blocked(cur, aid) else assigned_ready_task(cur, aid)
        )
    return (
        _ready_event(ready_task, since_ts)
        if ready_task is not None
        else {"event": "timeout", "ts": time.time()}
    )


@app.get("/api/agents/{aid}/events")
async def agent_events(aid: str, since_ts: float = Query(default=0.0)):
    """SSE stream of events addressed to this agent. Forever; clients close to unsubscribe.

    Useful for the dashboard (where a browser tab can stay open) and for any non-Claude
    client that can hold a long-lived HTTP connection.
    """
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (_, cur):
        require_agent(cur, aid)

    async def event_stream():
        cursor_ts = since_ts
        while True:
            event = await wait_for_event(aid, cursor_ts, 15.0)
            if event is None:
                yield f": heartbeat {int(time.time())}\n\n"
            else:
                cursor_ts = event["ts"]
                yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")
