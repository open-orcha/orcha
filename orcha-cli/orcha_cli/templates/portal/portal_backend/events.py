"""Persist and poll the durable database-backed event bus."""

import asyncio
import json
import signal
import threading
import time
from typing import Optional

from portal_backend import stream_signal
from portal_backend.database import db_cursor


# Parity r2 (graceful stop): long-lived SSE streams (container /events, agent /events,
# run /stream) never end on their own, and uvicorn's graceful shutdown waits for every
# in-flight response BEFORE it runs the lifespan shutdown hooks — so a SIGTERM hung
# until the orchestrator SIGKILLed the process. The streams instead watch this flag,
# which a chained signal handler sets the moment SIGINT/SIGTERM arrives, and end
# within one poll tick. Browsers' EventSource reconnects on its own once the stack is
# back up, so ending a stream early loses nothing (events are durable; since_ts resumes).
_SHUTTING_DOWN = threading.Event()


def shutting_down() -> bool:
    """True once the process has been asked to stop (SIGINT/SIGTERM)."""
    return _SHUTTING_DOWN.is_set()


def install_stream_shutdown_hook() -> None:
    """Chain a flag-setting handler in front of the current SIGINT/SIGTERM handlers.

    Run as a startup hook: uvicorn installs its own exit handlers before the lifespan
    startup, so the chained previous handler IS uvicorn's and its graceful-exit
    behavior is unchanged — we only additionally flip `_SHUTTING_DOWN` so open streams
    return. Idempotent; a no-op off the main thread (signals are main-thread-only)."""
    if threading.current_thread() is not threading.main_thread():
        return
    for sig in (signal.SIGINT, signal.SIGTERM):
        prev = signal.getsignal(sig)
        if getattr(prev, "_orcha_stream_hook", False):
            continue

        def _handler(signum, frame, _prev=prev):
            _SHUTTING_DOWN.set()
            if callable(_prev):
                _prev(signum, frame)
            elif _prev == signal.SIG_DFL:
                signal.signal(signum, signal.SIG_DFL)
                signal.raise_signal(signum)

        _handler._orcha_stream_hook = True  # type: ignore[attr-defined]
        signal.signal(sig, _handler)


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
    """Poll without blocking the event loop until an event or timeout.

    Between reads it waits on an in-process wake-up for `key` (stream_signal: a writer
    notifies after its commit), so a new event is returned at once instead of after the
    poll interval; the interval stays the fallback for a missed notify."""
    deadline = time.time() + timeout_s
    waiter = stream_signal.register(key)
    try:
        while True:
            if _SHUTTING_DOWN.is_set():
                return None  # stopping: let the caller's stream end (see _SHUTTING_DOWN)
            waiter[1].clear()
            event = await asyncio.to_thread(fetch_next_event, key, since_ts)
            if event is not None:
                return event
            left = deadline - time.time()
            if left <= 0:
                return None
            await stream_signal.wait(waiter, min(poll_interval_s, left))
    finally:
        stream_signal.unregister(key, waiter)
