"""Terminate worker process groups and extract bounded run output and usage."""

from __future__ import annotations

import json
import os
import pathlib
import signal
import time

def _kill_worker(proc, graceful: bool = False, grace_secs: float = 10.0) -> None:
    """Kill a worker's whole process GROUP, then reap the leader.

    Workers are spawned with start_new_session=True, so each is its own session +
    process-group leader (pgid == pid) and claude's grandchildren (tool subprocesses
    — e.g. the `bash` that runs the orcha `curl`s) inherit that group. A bare
    proc.kill() SIGKILLs only the claude pid and leaves those grandchildren orphaned
    and ALIVE, so a timed-out worker could keep doing work while the daemon green-lit a
    replacement (ISS-15 P1). Signal the GROUP so the whole tree dies.

    `graceful=True` (ISS-29 completion path AND ISS-45 watchdog kills) sends SIGTERM to the
    group first and gives it `grace_secs` to unwind — so claude's SessionEnd hook (the C1
    continuity-digest write-on-exit) gets to run — escalating to SIGKILL only if it ignores the
    term. A hard SIGKILL is what was eating the digest before: on a finished-but-lingering
    worker (ISS-29) and, worse, on a stall/hard-cap kill of a still-working worker (ISS-45),
    where the digest is the only record of what it did. So EVERY watchdog kill is graceful —
    a genuinely-hung worker that ignores SIGTERM is still SIGKILLed after the window."""
    try:
        pgid = os.getpgid(proc.pid)
    except (ProcessLookupError, OSError):
        pgid = proc.pid                      # start_new_session => pgid == pid anyway
    if graceful:
        try:
            os.killpg(pgid, signal.SIGTERM)  # let SessionEnd (C1 digest) run before we force it
        except (ProcessLookupError, PermissionError, OSError):
            pass
        try:
            proc.wait(timeout=grace_secs)
            return                           # exited on SIGTERM — clean teardown, no SIGKILL
        except Exception:
            pass                             # ignored the term → fall through to SIGKILL
    try:
        os.killpg(pgid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            proc.kill()                      # fallback: at least kill the leader
        except OSError:
            pass
    try:
        proc.wait(timeout=5)                 # reap the leader so it doesn't linger as a zombie
    except Exception:
        pass


def _capture_run_output(log_path, cap: int = 200_000):
    """A2: read the per-wake stream-json log (tail-capped) so the API can persist it.
    The daemon has FS access to the host log; the portal (different container) does not,
    so the text is sent on /finish. Returns None if there's no log / it can't be read."""
    if not log_path:
        return None
    try:
        data = pathlib.Path(log_path).read_bytes()
    except OSError:
        return None
    if len(data) > cap:
        data = b"...[truncated]...\n" + data[-cap:]
    return data.decode("utf-8", "replace")


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
    exactly one result event, so this IS the whole wake.

    Codex runs (`codex exec --json`) carry no `result` event; their terminal `turn.completed`
    usage is read instead (see _codex_usage) — same five keys, cost left to the portal."""
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
        if not isinstance(obj, dict):
            continue
        if obj.get("type") == "result":
            usage = obj.get("usage") or {}
            if not isinstance(usage, dict):
                usage = {}
            out = {k: usage.get(k) for k in keys[:4]}
            out["total_cost_usd"] = obj.get("total_cost_usd")
            return out
        codex = _codex_usage(obj)
        if codex is not None:
            return codex
    return {}


def _codex_token(value):
    """A usable token count, else None (bool / negative / non-numeric never meter)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        return None
    return int(value)


def _codex_usage(obj: dict):
    """Codex metering: `codex exec --json` ends a turn with
    `{"type":"turn.completed","usage":{"input_tokens","cached_input_tokens","output_tokens"}}`
    (older builds: `{"msg":{"type":"token_count","info":{"total_token_usage":{…}}}}`). Map it onto
    the Claude fields: OpenAI's input_tokens INCLUDES the cached part, so input_tokens here is the
    uncached remainder and cache_read_input_tokens the cached part; output_tokens as reported
    (reasoning included, as billed). Codex reports no dollar figure — total_cost_usd stays None
    and the portal estimates it from the agent's model (codex_pricing). Any other / malformed
    shape → None (no metering, never a crash)."""
    usage = None
    if obj.get("type") == "turn.completed":
        usage = obj.get("usage")
    else:
        msg = obj.get("msg")
        if isinstance(msg, dict) and msg.get("type") == "token_count":
            info = msg.get("info")
            if isinstance(info, dict):
                usage = info.get("total_token_usage")
    if not isinstance(usage, dict):
        return None
    total_in = _codex_token(usage.get("input_tokens"))
    cached = _codex_token(usage.get("cached_input_tokens"))
    output = _codex_token(usage.get("output_tokens"))
    if total_in is None and cached is None and output is None:
        return None
    cached_n = min(cached or 0, total_in) if total_in is not None else (cached or 0)
    return {
        "input_tokens": (total_in - cached_n) if total_in is not None else None,
        "output_tokens": output,
        "cache_read_input_tokens": cached_n if (cached is not None or total_in is not None) else None,
        "cache_creation_input_tokens": 0,
        "total_cost_usd": None,
    }
