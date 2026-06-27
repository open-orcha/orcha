"""orcha_cli.notifier.runlog — parsing of Claude/Codex worker session-log files.

Pure, dependency-free readers over the JSONL session logs a headless/resident
worker writes: session-id extraction, last-event/result-status inspection, the
"is this worker still live?" heuristic, and token-usage tallying. Extracted
verbatim from ``notifier.py`` (issue #29); re-exported from the package
``__init__`` so ``orcha_cli.notifier.<name>`` keeps working unchanged.
"""
from __future__ import annotations

import json
import os
from typing import Optional

def _extract_session_id(log_path) -> Optional[str]:
    """E3: claude assigns the session_id and stamps it on every stream-json event (the `system`
    init line is the first). The manager reads it from the head of the log after a COLD boot and
    pins it via POST /conversations/{id}/session so a later warm restart can --resume the same
    session. Returns the first session_id seen, or None if not emitted yet / unreadable."""
    if not log_path:
        return None
    try:
        with open(log_path, "rb") as f:
            head = f.read(65536)             # the init/system line is at the very top
    except OSError:
        return None
    for raw in head.split(b"\n"):
        s = raw.strip()
        if not s:
            continue
        try:
            obj = json.loads(s)
        except ValueError:
            continue                         # partial head line — try the next
        sid = obj.get("session_id")
        if sid:
            return sid
    return None


def _extract_codex_session_id(log_path) -> Optional[str]:
    """#286: pull the Codex session/rollout id from a `codex exec --json` log so a later turn can
    `codex exec resume <session_id>` instead of re-injecting the full thread history.

    Codex stamps the id on an early event; the exact event/key spelling varies across Codex
    versions and could NOT be empirically pinned here (codex is not installed on this host —
    Invy's feasibility caveat, task ff19f91c), so this scans the head TOLERANTLY for any of the
    known carriers — top-level `session_id`/`thread_id`/`conversation_id`, or nested under a
    `msg`/`session` object (e.g. the `session_configured` event). Returns the first id found, or
    None. A None (or a non-UUID the pin endpoint rejects) simply leaves the conversation on the
    cold full-history path — the #286 fail-open contract."""
    if not log_path:
        return None
    try:
        with open(log_path, "rb") as f:
            head = f.read(65536)             # the session event is at the very top
    except OSError:
        return None

    def _id_from(obj) -> Optional[str]:
        if not isinstance(obj, dict):
            return None
        for key in ("session_id", "thread_id", "conversation_id"):
            val = obj.get(key)
            if isinstance(val, str) and val:
                return val
        for nest in ("msg", "session", "payload"):
            found = _id_from(obj.get(nest))
            if found:
                return found
        return None

    for raw in head.split(b"\n"):
        s = raw.strip()
        if not s:
            continue
        try:
            obj = json.loads(s)
        except ValueError:
            continue                         # partial head line — try the next
        sid = _id_from(obj)
        if sid:
            return sid
    return None


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


def _worker_is_live(log_path) -> bool:
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
    out of the tail can't fabricate a false in-flight under any of the three."""
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


def _usage_from_log(log_path) -> dict:
    """#289 (efficiency measurement backbone): extract the TOKEN usage of a finished wake from
    its stream-json log. `claude -p --output-format stream-json` emits exactly one terminal
    `result` event whose `usage` object carries input_tokens / output_tokens /
    cache_creation_input_tokens / cache_read_input_tokens (cumulative for the invocation) plus a
    top-level `total_cost_usd`. The reply-capture path (_result_after) read that event for text
    and dropped the usage; this reads the SAME terminal event (from the log tail — result lines
    are small) for the five accounting fields. Returns a dict with those keys (any absent → None
    so a malformed / pre-result log degrades to NULL, never a crash). Empty dict if no log /
    unreadable / no complete result line yet.

    Caveat (documented V2): a resident worker that handled multiple turns in one process logs one
    result event per turn; we read the LAST, i.e. the cumulative usage of its final turn. For the
    ephemeral headless worker — the dominant per-wake cost and the control-project case — there is
    exactly one result event, so this IS the whole wake."""
    keys = ("input_tokens", "output_tokens", "cache_read_input_tokens",
            "cache_creation_input_tokens", "total_cost_usd")
    if not log_path:
        return {}
    try:
        with open(log_path, "rb") as f:
            f.seek(0, os.SEEK_END)
            end = f.tell()
            f.seek(max(0, end - 65536))      # tail is plenty; result lines are small
            tail = f.read()
    except OSError:
        return {}
    for raw in reversed(tail.split(b"\n")):
        s = raw.strip()
        if not s:
            continue
        try:
            obj = json.loads(s)
        except ValueError:
            return {}                         # last line still being written → not complete
        if obj.get("type") == "result":
            usage = obj.get("usage") or {}
            out = {k: usage.get(k) for k in keys[:4]}
            out["total_cost_usd"] = obj.get("total_cost_usd")
            return out
    return {}


def _is_stream_event_line(line: str) -> bool:
    """ISS-#251: True for a `--include-partial-messages` `stream_event` partial-delta line.

    These token/thinking deltas exist in the host log purely so the stall watchdog (reap_workers,
    which measures progress by log growth) sees a heartbeat while a worker is mid-generation. They
    must NOT be persisted to the DB line feed — at one line per token they would flood
    worker_run_lines and the portal SSE. Fail soft: a non-JSON line is treated as NOT a partial
    (kept), matching _pump_one's prior 'keep every non-blank line' behavior."""
    try:
        return json.loads(line).get("type") == "stream_event"
    except (ValueError, AttributeError):
        return False
