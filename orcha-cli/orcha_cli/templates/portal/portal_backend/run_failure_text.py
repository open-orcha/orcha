"""Extract the provider's final error without mistaking tool output for a run failure."""

import json
import re


def _text(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(filter(None, (_text(v) for v in value)))
    if isinstance(value, dict):
        for key in ("text", "message", "content"):
            if value.get(key):
                return _text(value[key])
    return ""


def last_error(output):
    """Read Claude/Codex terminal errors and plain stderr; ignore retries and tool results."""
    found = ""
    for line in (output or "").splitlines():
        try:
            event = json.loads(line)
        except (ValueError, TypeError):
            if re.search(r"(?i)\b(error|fatal|exception|ENOTFOUND)\b", line):
                found = line
            continue
        if not isinstance(event, dict):
            continue
        msg = event.get("msg") or event.get("event") or event
        if not isinstance(msg, dict):
            continue
        kind = msg.get("type", "")
        text = ""
        if kind == "result" and (msg.get("is_error") or str(msg.get("subtype", "")).startswith("error")):
            text = _text(msg.get("result")) or _text(msg.get("errors"))
        elif kind in ("error", "turn.failed", "response.failed"):
            text = _text(msg.get("error")) or _text(msg.get("message"))
        elif kind in ("item.completed", "item.failed") and isinstance(msg.get("item"), dict):
            item = msg["item"]
            if item.get("type") == "error":
                text = _text(item.get("message")) or _text(item.get("text"))
        elif kind == "assistant":
            candidate = _text(msg.get("message"))
            if candidate.lstrip()[:10].lower().startswith(("api error:", "error:", "fatal:")):
                text = candidate
        if text.strip():
            found = text
    # A short, plain line is safe for both the run list and the Needs you request.
    lines = [line.strip() for line in found.splitlines() if line.strip()]
    return re.sub(r"\x1b\[[0-9;]*m", "", lines[-1])[:1000] if lines else None


def failure_reason(run):
    if run.get("status") in ("failed", "rate_limited") or (
        run.get("status") == "exited" and run.get("exit_code") not in (None, 0)
    ):
        return last_error(run.get("output"))
    return None
