"""Routines scheduler hook — rides the notifier's existing wake tick (no new daemon).

Once per TICK_EVERY_SECS per container, ask the portal to fire whatever routines are
due: POST /api/containers/{cid}/routines/tick. Every decision (what is due, skip-if-open,
catch-up after downtime, slot de-duplication) and every DB write happens server-side in
portal_backend/routine_routes.py; this module only pokes it. Tasks a routine creates go
through the normal task-creation path, so the wake scan then treats them like any other
task (assignment wakes, plan approval, verification all unchanged).

Never raises: a routines hiccup must not stall agent wakes. Skipped in --dry-run (a dry
run must not create tasks).
"""
from __future__ import annotations

import sys
import time

TICK_EVERY_SECS = 30.0
_LAST_TICK: dict = {}


def _monotonic() -> float:
    return time.monotonic()


def maybe_fire_routines(api_base, container_id, services, *, quiet=False, dry_run=False):
    """Fire due routines for one container, throttled; returns the portal's reply or None."""
    if dry_run:
        return None
    now = _monotonic()
    last = _LAST_TICK.get(container_id)
    if last is not None and now - last < TICK_EVERY_SECS:
        return None
    _LAST_TICK[container_id] = now
    try:
        result = services._post_json(f"{api_base}/api/containers/{container_id}/routines/tick", {})
    except Exception as error:  # noqa: BLE001 - never stall the wake tick
        if not quiet:
            print(f"[notifier] routines tick failed (continuing): {error}", file=sys.stderr)
        return None
    if not quiet and isinstance(result, dict):
        for fired in result.get("fired") or []:
            outcome = fired.get("outcome")
            if outcome in ("created", "skipped", "failed"):
                print(
                    f"[notifier] routine {fired.get('routine_id')}: {outcome}"
                    + (f" task {fired.get('task_id')}" if fired.get("task_id") else "")
                    + (f" — {fired.get('detail')}" if fired.get("detail") else "")
                )
    return result
