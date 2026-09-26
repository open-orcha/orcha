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
