"""Persist and poll the durable database-backed event bus."""

import asyncio
import json
import time
from typing import Optional

from portal_backend.database import db_cursor


def publish_event(
    cur,
    container_id: Optional[str],
    target_agent_id: Optional[str],
    event_name: str,
    payload: dict,
) -> None:
    """Persist an event through the caller's open transaction."""
    timestamp = time.time()
    body = json.dumps(payload)
    keys: list[tuple[str, Optional[str]]] = []
    if target_agent_id:
        keys.append((str(target_agent_id), str(target_agent_id)))
    if container_id:
        keys.append((f"c:{container_id}", None))
    for event_key, target in keys:
        cur.execute(
            """INSERT INTO agent_events
                 (container_id, target_id, event_key, event_name, ts, payload)
               VALUES (%s, %s, %s, %s, %s, %s::jsonb)""",
            (container_id, target, event_key, event_name, timestamp, body),
        )


def poke_path_forward(
    cur,
    container_id,
    recipient_id,
    from_agent_id,
    message,
) -> None:
    """Send an actionable prompt after a rejected or cancelled work path."""
    publish_event(
        cur,
        container_id,
        recipient_id,
        "prompt",
        {"message": message, "from_agent_id": from_agent_id},
    )


def fetch_next_event(key: str, since_ts: float) -> Optional[dict]:
    """Return the first event newer than the supplied cursor."""
    with db_cursor() as (_, cur):
        cur.execute(
            """SELECT event_name, ts, payload FROM agent_events
               WHERE event_key = %s AND ts > %s
               ORDER BY ts, id
               LIMIT 1""",
            (key, since_ts),
        )
        row = cur.fetchone()
    if not row:
        return None
    return {
        "event": row["event_name"],
        "ts": row["ts"],
        **(row["payload"] or {}),
    }


async def wait_for_event(
    key: str,
    since_ts: float,
    timeout_s: float,
    poll_interval_s: float = 0.5,
) -> Optional[dict]:
    """Poll without blocking the event loop until an event or timeout."""
    deadline = time.time() + timeout_s
    while True:
        event = await asyncio.to_thread(fetch_next_event, key, since_ts)
        if event is not None:
            return event
        if time.time() >= deadline:
            return None
        await asyncio.sleep(poll_interval_s)
