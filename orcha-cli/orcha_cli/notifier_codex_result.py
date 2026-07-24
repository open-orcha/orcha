"""Derive a terminal result status from a Codex JSON event log."""

from __future__ import annotations

import json
import os
from typing import Optional

from .notifier_codex_events import _codex_event_phase, _codex_is_rate_limit, _codex_is_turn_end

def _codex_result_status(log_path) -> Optional[str]:
    """GH#61 (PR #80 review round 2): the Codex sibling of `_result_status`. Return a terminal
    status ('success' / 'error') when a Codex (`codex exec --json`) worker's log tail shows a
    COMPLETED turn as its last meaningful signal, else None.

    Why `reap_workers` needs this distinctly from `_worker_is_live`: when a Codex worker finishes,
    its terminal `turn.completed` line is fresh log GROWTH, so `reap_workers` reads the worker as
    `stalled=False`. `_result_status` only understands Claude's `result` event (→ None for Codex),
    so the finished worker skipped the hold-off/exit-cleanly branch and fell through to the
    checkpoint branch (`respawnable and (not stalled or ...)`) — which respawned an ALREADY-FINISHED
    worker. Mirroring the Claude `result` path, a turn-terminal Codex tail must instead take the
    terminal branch: hold off, let the process exit on its own (reaped 'exited', SessionEnd/C1
    digest runs), never checkpoint-respawn it.

    Terminal means the LAST turn/tool signal in the tail is a `turn.completed`/`turn.failed` with
    NOTHING live after it — no later `item.started`, no unpaired in-flight id, no rate-limit
    backoff. A worker that went silent WITHOUT a turn end (e.g. crashed mid-item) is NOT terminal
    here → it stays on the stall/liveness/respawn path, exactly as before. A turn end followed by a
    new turn's activity is likewise not terminal (the new turn is still running). Tolerant/fail-open
    parsing (codex unpinned on this host), and — like `_result_status` — a still-being-written final
    line (unparseable last line) defers the decision to a later tick rather than risk a false
    terminal on a live worker."""
    if not log_path:
        return None
    try:
        with open(log_path, "rb") as f:
            f.seek(0, os.SEEK_END)
            end = f.tell()
            f.seek(max(0, end - 65536))          # tail is plenty; terminal lines are small
            tail = f.read()
    except OSError:
        return None
    # the LAST non-empty line must parse cleanly; a truncated final line means codex is still
    # mid-write → don't declare terminal yet (mirrors _result_status's last-line guard).
    for raw in reversed(tail.split(b"\n")):
        s = raw.strip()
        if not s:
            continue
        try:
            json.loads(s)
        except ValueError:
            return None
        break
    last_signal = None                           # 'start' | 'end' | 'rate_limit' | 'turn_end'
    last_turn_status = None                      # 'success' | 'error' — status of the last turn end
    for raw in tail.split(b"\n"):
        s = raw.strip()
        if not s:
            continue
        try:
            obj = json.loads(s)
        except ValueError:
            continue                             # partial/garbled line (e.g. truncated tail head)
        if not isinstance(obj, dict):
            continue
        if _codex_is_turn_end(obj):
            last_signal = "turn_end"
            blob = ((obj.get("type") or "") + " "
                    + ((obj.get("msg") or {}).get("type") or "")).lower()
            last_turn_status = "error" if "fail" in blob else "success"
            continue
        if _codex_is_rate_limit(obj):
            last_signal = "rate_limit"
            continue
        phase, _iid = _codex_event_phase(obj)
        if phase == "start":
            last_signal = "start"
        elif phase == "end":
            last_signal = "end"
    # terminal ONLY when the tail's last meaningful signal is a turn end (nothing live after it).
    return last_turn_status if last_signal == "turn_end" else None
