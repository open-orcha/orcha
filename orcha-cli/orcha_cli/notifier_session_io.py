"""Read and write Claude/Codex resident-session stream files."""

from __future__ import annotations

import json
import os
import pathlib
from typing import Optional

def _send_user_turn(proc, content: str) -> bool:
    """Write ONE user turn to the resident's stdin as a stream-json NDJSON line (the exact shape
    E2 proved: type=user, message.role=user, content=[{type:text,text:…}]). The resident answers
    in-session and emits a `result`; stdin stays OPEN for the next turn (closing it = graceful EOF
    → claude exits → SessionEnd/C1 runs). Returns False if the pipe is gone (resident died)."""
    if proc is None or getattr(proc, "stdin", None) is None:
        return False
    line = json.dumps({"type": "user",
                       "message": {"role": "user",
                                   "content": [{"type": "text", "text": content}]}}) + "\n"
    try:
        proc.stdin.write(line.encode())
        proc.stdin.flush()
        return True
    except (BrokenPipeError, OSError, ValueError):
        return False


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


def _result_after(log_path, start_offset: int = 0) -> Optional[dict]:
    """E3 reply-capture: find the FIRST terminal `result` event at/after `start_offset` bytes —
    the boundary that ends the turn the manager just fed. Returns {text, subtype, num_turns,
    session_id, end_offset} (end_offset = byte position just past the result line, so the next
    turn scans from there), or None if the turn hasn't finished (no complete result line yet)."""
    if not log_path:
        return None
    try:
        with open(log_path, "rb") as f:
            f.seek(start_offset)
            chunk = f.read()
    except OSError:
        return None
    off = start_offset
    for raw in chunk.split(b"\n"):
        advance = len(raw) + 1               # bytes consumed incl. the trailing newline
        s = raw.strip()
        if s:
            try:
                obj = json.loads(s)
            except ValueError:
                obj = None                   # a still-being-written final line → not done yet
            if obj and obj.get("type") == "result":
                return {"text": obj.get("result"), "subtype": obj.get("subtype"),
                        "num_turns": obj.get("num_turns"), "session_id": obj.get("session_id"),
                        "end_offset": off + advance}
        off += advance
    return None
