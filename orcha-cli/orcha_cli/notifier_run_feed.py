"""Stream complete worker-log events into the portal's durable run feed."""

from __future__ import annotations

import json
from typing import Optional


def is_stream_event_line(line: str) -> bool:
    """Return whether a line is a high-volume partial stream delta."""
    try:
        return json.loads(line).get("type") == "stream_event"
    except (ValueError, AttributeError):
        return False


def _event_of(line: str) -> Optional[dict]:
    try:
        obj = json.loads(line)
    except ValueError:
        return None
    if not isinstance(obj, dict) or obj.get("type") != "stream_event":
        return None
    event = obj.get("event")
    return obj if isinstance(event, dict) else None


def _envelope(obj: dict, event: dict, **extra) -> str:
    out = {"type": "stream_event", "event": event}
    for key in ("session_id", "parent_tool_use_id"):
        if key in obj:
            out[key] = obj[key]
    out.update(extra)
    return json.dumps(out, separators=(",", ":"))


def compact_stream_events(lines: list[str]) -> list[str]:
    """Keep what a live chat needs from Claude's `--include-partial-messages` deltas.

    The raw deltas are high-volume (hundreds per reply), so the feed used to drop every
    `stream_event` and a viewer saw a reply only when its whole block completed. Kept now,
    compacted — never invented:
      * consecutive `text_delta`s of one content block are joined into ONE stream_event
        whose text is exactly their concatenation (`orcha_coalesced` = how many);
      * `content_block_start` of a `tool_use` / `thinking` block survives with its input
        stripped (the complete `assistant` event still carries the full block), so a viewer
        knows a tool or thinking started before the block finishes;
      * every other partial (input_json/thinking/signature deltas, message_start/delta/stop,
        content_block_stop, text block starts) is dropped as before.
    Non-stream lines pass through untouched and in order."""
    out: list[str] = []
    run: Optional[dict] = None  # the text_delta run being joined

    def flush() -> None:
        nonlocal run
        if run is not None:
            out.append(
                _envelope(
                    run["obj"],
                    {
                        "type": "content_block_delta",
                        "index": run["index"],
                        "delta": {"type": "text_delta", "text": "".join(run["parts"])},
                    },
                    orcha_coalesced=len(run["parts"]),
                )
            )
            run = None

    for line in lines:
        obj = _event_of(line)
        if obj is None:
            if not is_stream_event_line(line):
                flush()
                out.append(line)
            continue
        event = obj["event"]
        etype = event.get("type")
        delta = event.get("delta") if isinstance(event.get("delta"), dict) else {}
        if etype == "content_block_delta" and delta.get("type") == "text_delta":
            text = delta.get("text")
            if not isinstance(text, str) or not text:
                continue
            key = (event.get("index"), obj.get("parent_tool_use_id"))
            if run is not None and run["key"] != key:
                flush()
            if run is None:
                run = {"key": key, "index": event.get("index"), "obj": obj, "parts": []}
            run["parts"].append(text)
            continue
        if etype == "content_block_start":
            block = event.get("content_block")
            if isinstance(block, dict) and block.get("type") in ("tool_use", "thinking"):
                flush()
                slim = {"type": block["type"]}
                for key in ("id", "name"):
                    if key in block:
                        slim[key] = block[key]
                out.append(
                    _envelope(
                        obj,
                        {"type": "content_block_start", "index": event.get("index"), "content_block": slim},
                    )
                )
            continue
        # any other partial is dropped; it does not end a text run (e.g. a ping)
    flush()
    return out


def pump_one(api_base: str, worker: dict, post_json) -> bool:
    """Post newly completed log lines while retaining partial and failed batches.

    Returns True when this call posted a terminal `result` line (the turn just finished),
    so a caller can act on it at once instead of on its next scheduled pass."""
    log_path = worker.get("log_path")
    run_id = worker.get("run_id")
    if not log_path or not run_id:
        return False
    offset = worker.get("lines_offset", 0)
    try:
        with open(log_path, "rb") as log:
            log.seek(offset)
            data = log.read()
    except OSError:
        return False
    if not data:
        return False

    buffered = worker.get("lines_buf", b"") + data
    *complete, tail = buffered.split(b"\n")
    if not complete:
        worker["lines_offset"] = offset + len(data)
        worker["lines_buf"] = tail
        return False

    lines = [part.decode("utf-8", "replace").rstrip("\r") for part in complete]
    lines = compact_stream_events([line for line in lines if line.strip()])
    start_seq = worker.get("lines_seq", 1)
    finished = False
    if lines:
        response = post_json(
            f"{api_base}/api/runs/{run_id}/lines",
            {"start_seq": start_seq, "lines": lines},
        )
        if response is None:
            return False
        worker["lines_seq"] = start_seq + len(lines)
        finished = any(_is_result(line) for line in lines)
    worker["lines_offset"] = offset + len(data)
    worker["lines_buf"] = tail
    return finished


def _is_result(line: str) -> bool:
    if '"result"' not in line:
        return False
    try:
        obj = json.loads(line)
    except ValueError:
        return False
    return isinstance(obj, dict) and obj.get("type") == "result"
