"""Background check of Verdikt runs from the host daemon (portal: verdikt_autofix.sweep, mig 068).

Verdikt results used to be fetched only while someone looked at the task. The portal now runs
its own timer, and — so the auto-fix loop still closes if that thread is gone — this daemon
asks too: `POST /api/containers/{cid}/verdikt/sweep` refreshes the project's in-flight runs and
applies the loop (fail → back to the agent; pass / a stop condition → the human). The portal
judges every finished run exactly once, so the two never double up.

Cadence: every ACTIVE_EVERY_S while the last answer said runs are in flight, otherwise every
IDLE_EVERY_S (one cheap call). Never raises into the daemon loop; skipped in --dry-run.
"""

from __future__ import annotations

import sys
import time
from typing import Callable, Optional

ACTIVE_EVERY_S = 12.0
IDLE_EVERY_S = 60.0


class SweepState:
    def __init__(self) -> None:
        self.next_at = 0.0
        self.in_flight = 0
        self.last: Optional[dict] = None


STATE = SweepState()


def _default_post(url, body, timeout=30.0):
    from .notifier_host import _post_json

    return _post_json(url, body, timeout=timeout)


def maybe_sweep(api_base: str, cid: str, state: SweepState = STATE, *, quiet: bool = True,
                dry_run: bool = False, post: Callable = _default_post,
                clock: Callable[[], float] = time.monotonic) -> Optional[dict]:
    """One daemon tick: call the sweep when it is due. Returns the portal's answer (or None)."""
    if dry_run:
        return None
    now = clock()
    if now < state.next_at:
        return None
    res = None
    try:
        res = post(f"{api_base}/api/containers/{cid}/verdikt/sweep", {})
    except Exception as e:  # noqa: BLE001 — a hiccup must never stall agent wakes
        if not quiet:
            print(f"[notifier] verdikt sweep error (continuing): {type(e).__name__}: {e}", file=sys.stderr)
    if isinstance(res, dict) and "in_flight" in res:
        state.in_flight = int(res.get("in_flight") or 0)
        state.last = res
        if not quiet and (res.get("judged") or 0):
            print(f"[notifier] verdikt: judged {res['judged']} finished run(s) for auto-fix")
    state.next_at = now + (ACTIVE_EVERY_S if state.in_flight else IDLE_EVERY_S)
    return res if isinstance(res, dict) else None
