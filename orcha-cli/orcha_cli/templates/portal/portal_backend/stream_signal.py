"""In-process wake-ups for long-lived streams (latency only — the DB stays the truth).

The SSE streams (a run's `/stream`, container/agent `/events`, `/wait`) read the database
and, when nothing is new, used to sleep a fixed interval before reading again — so a row
committed just after a read sat unseen for up to that interval. A writer now calls
`notify(key)` AFTER its commit; every stream waiting on that key wakes at once and
re-reads. Keys: a run id (worker_run_lines batches / finish) or an agent_events
event_key (an agent id, or "c:<container id>").

Purely an accelerator: waiters still re-read on their own short timeout, so a missed
notify (another process, a notify before the waiter registered) costs at most that
timeout — never a lost row. Thread-safe: sync route handlers run in the threadpool,
streams on the event loop.
"""

from __future__ import annotations

import asyncio
import threading
from typing import Dict, Set, Tuple

_LOCK = threading.Lock()
_WAITERS: Dict[str, Set[Tuple[asyncio.AbstractEventLoop, asyncio.Event]]] = {}

Waiter = Tuple[asyncio.AbstractEventLoop, asyncio.Event]


def register(key: str) -> Waiter:
    """Register the calling coroutine (must run on its event loop) for `key` wake-ups."""
    entry = (asyncio.get_running_loop(), asyncio.Event())
    with _LOCK:
        _WAITERS.setdefault(str(key), set()).add(entry)
    return entry


def unregister(key: str, entry: Waiter) -> None:
    """Drop a registration (idempotent)."""
    with _LOCK:
        waiters = _WAITERS.get(str(key))
        if waiters is None:
            return
        waiters.discard(entry)
        if not waiters:
            _WAITERS.pop(str(key), None)


def notify(*keys: str) -> int:
    """Wake every waiter on any of `keys`. Returns how many were signalled. Never raises."""
    with _LOCK:
        entries = [e for k in keys if k for e in _WAITERS.get(str(k), ())]
    woke = 0
    for loop, event in entries:
        try:
            loop.call_soon_threadsafe(event.set)
            woke += 1
        except RuntimeError:  # loop already closed (shutdown) — nothing to wake
            continue
    return woke


async def wait(entry: Waiter, timeout: float) -> bool:
    """Wait up to `timeout`s for a notify on `entry`; True when woken. Clears the flag."""
    event = entry[1]
    try:
        await asyncio.wait_for(event.wait(), timeout=timeout)
        return True
    except asyncio.TimeoutError:
        return False
    finally:
        event.clear()


def waiter_count(key: str) -> int:
    """Test/diagnostic helper: how many waiters are registered for `key`."""
    with _LOCK:
        return len(_WAITERS.get(str(key), ()))
