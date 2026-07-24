"""Detect Claude and Codex worker liveness and terminal status from log tails."""

from __future__ import annotations

import json
import os
from typing import Optional

from .notifier_codex_events import _codex_tail_is_live
from .notifier_codex_result import _codex_result_status

def _result_status(log_path) -> Optional[str]:
    """ISS-29: return the subtype of a terminal stream-json `result` event if the worker has
    COMPLETED its agent loop (e.g. 'success', 'error_max_turns'), else None.

    `claude -p --output-format stream-json` emits exactly one `result` object as the FINAL
    NDJSON line. Once it's present the run has finished — a still-alive process is merely slow
    to exit (a known linger on long headless sessions). Such a worker must NOT be reaped as
    'killed', and its SessionEnd hook (the C1 digest) deserves a window to run. We read only
    the log's tail (the result line is small) and inspect the LAST complete line: a truncated
    final line means claude is still mid-write → not done yet."""
    if not log_path:
        return None
    try:
        with open(log_path, "rb") as f:
            f.seek(0, os.SEEK_END)
            end = f.tell()
            f.seek(max(0, end - 65536))      # tail is plenty; result lines are small
            tail = f.read()
    except OSError:
        return None
    for raw in reversed(tail.split(b"\n")):
        s = raw.strip()
        if not s:
            continue
        try:
            obj = json.loads(s)
        except ValueError:
            return None                       # last line still being written → not complete
        return obj.get("subtype") if obj.get("type") == "result" else None
    return None


def _last_event_type(log_path) -> Optional[str]:
    """#270: the `type` of the LAST complete stream-json line in the worker log, or None.

    Part of the watchdog kill diagnostic: it explains what the worker was doing when it went
    log-silent — an 'assistant' (mid tool_use), a 'stream_event' (mid token/thinking generation),
    a 'rate_limit_event' (backing off a 429), or 'result' (already finished). We scan the tail in
    reverse and skip any garbled/partial trailing line (a still-being-written final line)."""
    if not log_path:
        return None
    try:
        with open(log_path, "rb") as f:
            f.seek(0, os.SEEK_END)
            end = f.tell()
            f.seek(max(0, end - 65536))      # tail is plenty; we only want the last line's type
            tail = f.read()
    except OSError:
        return None
    for raw in reversed(tail.split(b"\n")):
        s = raw.strip()
        if not s:
            continue
        try:
            return json.loads(s).get("type")
        except ValueError:
            continue                          # partial/garbled line — fall back to the previous
    return None

def _worker_is_live(log_path, runtime=None) -> bool:
    """ISS-45: liveness probe for the STALL watchdog. A worker whose stream-json log has
    stopped growing is NOT necessarily stalled — output-silence ≠ death. Two common cases are
    a worker that is very much alive yet legitimately quiet:

      * an IN-FLIGHT tool call — `claude -p` emits the assistant `tool_use` immediately, but
        the matching `tool_result` only lands when the subprocess returns, so the log freezes
        for the whole duration of a long `Bash` (build, big `git`, a sleep, a slow `curl`);
      * a RATE-LIMIT backoff — a top-level `{"type":"rate_limit_event", ...}` then silence
        while claude sleeps off a 429 before resuming.

    The old size-only heuristic mistook both for a stall and SIGKILLed the worker mid-work
    (Invy run 5a9c7cbe: a long command + 2 rate_limit_events → >120s no growth → killed at
    ~11min, no result, C1 digest lost). Return True if the log's tail shows either signal so
    the stall kill is suppressed. This only governs the STALL path — the 1200s hard-cap
    backstop still reaps a genuinely-hung worker even while it looks 'live'.

    Detecting an outstanding tool call must NOT assume the blocks carry ids. `claude -p` does
    emit `tool_use.id` / `tool_result.tool_use_id` in the wild, but other real-shaped streams
    (and our own fixtures) carry NO ids — and an id-only pairing would miss the exact ISS-45
    case there, stall-killing the worker anyway. So we read three shape-agnostic signals over
    the tail and treat ANY as 'alive' (a false 'alive' merely defers the kill to the 1200s hard
    cap; a false 'stalled' is the bug we're fixing):
      * id pairing — `tool_use` ids not yet seen as a `tool_result` id (precise, orphan-safe
        when ids exist);
      * count — more `tool_use` blocks than `tool_result` blocks (covers no-id + parallel calls);
      * order — the LAST tool-related block in the stream is a `tool_use` (covers a no-id call
        in flight at the tail, even when an orphan result earlier balances the count).
    A `tool_result` always follows its `tool_use`, so an orphan result whose `tool_use` scrolled
    out of the tail can't fabricate a false in-flight under any of the three.

    GH#61: the probe is RUNTIME-AWARE. Codex workers launch via `codex exec --json` (not
    `claude -p`), which emits an entirely different event schema, so the Claude-only shapes below
    found none of a live Codex worker's signals and returned False → the #54 checkpoint protection
    never fired and an alive-but-silent Codex worker was hard-killed past the cap. For a Codex
    runtime we delegate to `_codex_tail_is_live`; the default (None/claude) keeps the original
    Claude path so existing callers are unchanged."""
    if not log_path:
        return False
    try:
        with open(log_path, "rb") as f:
            f.seek(0, os.SEEK_END)
            end = f.tell()
            f.seek(max(0, end - 262144))     # 256KB tail: ample to pair recent tool calls
            tail = f.read()
    except OSError:
        return False
    if runtime == "codex":
        return _codex_tail_is_live(tail)
    tool_use_ids: set = set()
    tool_result_ids: set = set()
    use_count = result_count = 0
    last_tool_block = None                    # 'use' | 'result' — last tool-related block seen
    last_type = None
    for raw in tail.split(b"\n"):
        s = raw.strip()
        if not s:
            continue
        try:
            obj = json.loads(s)
        except ValueError:
            continue                          # partial/garbled line (e.g. truncated tail head)
        etype = obj.get("type")
        last_type = etype
        content = (obj.get("message") or {}).get("content") if isinstance(obj.get("message"), dict) else None
        if etype == "assistant" and isinstance(content, list):
            for blk in content:
                if isinstance(blk, dict) and blk.get("type") == "tool_use":
                    use_count += 1
                    last_tool_block = "use"
                    if blk.get("id"):
                        tool_use_ids.add(blk["id"])
        elif etype == "user" and isinstance(content, list):
            for blk in content:
                if isinstance(blk, dict) and blk.get("type") == "tool_result":
                    result_count += 1
                    last_tool_block = "result"
                    if blk.get("tool_use_id"):
                        tool_result_ids.add(blk["tool_use_id"])
    if last_type == "rate_limit_event":
        return True                           # mid-backoff on a 429 — alive, just sleeping
    if tool_use_ids - tool_result_ids:        # id pairing: an unanswered tool_use id
        return True
    if use_count > result_count:              # count: more calls issued than answered (no-id safe)
        return True
    return last_tool_block == "use"           # order: tail ends on an unanswered tool_use


def _terminal_status(log_path, runtime=None) -> Optional[str]:
    """GH#61 (PR #80 review round 2): runtime-aware 'has this worker FINISHED its agent loop?'.
    Claude emits a terminal stream-json `result` line (`_result_status`); a Codex worker emits a
    terminal `turn.completed`/`turn.failed` (`_codex_result_status`). `reap_workers` uses this to
    HOLD OFF on a finished worker — let it exit cleanly so SessionEnd (the C1 digest) runs and it is
    reaped 'exited' — instead of stall-killing OR checkpoint-respawning it. Without the Codex arm a
    finished Codex worker's terminal turn line read as fresh growth (`not stalled`) and was wrongly
    respawned by the checkpoint branch."""
    if runtime == "codex":
        return _codex_result_status(log_path)
    return _result_status(log_path)
