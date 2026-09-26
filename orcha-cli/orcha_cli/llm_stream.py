"""Assemble and diagnose normalized streaming tool calls."""

from __future__ import annotations

import json
from typing import Any, Iterable, Optional


def _collect_blocks(events: Iterable[dict]) -> tuple[dict[Any, dict], dict]:
    """Accumulate tool blocks and usage metadata from a normalized event stream."""
    blocks: dict[Any, dict] = {}
    usage: dict[str, Any] = {"stop_reason": None, "output_tokens": 0}
    for event in events:
        event_type = event.get("type")
        index = event.get("index")
        if event_type == "usage":
            if event.get("output_tokens") is not None:
                usage["output_tokens"] = event.get("output_tokens", 0)
            if event.get("stop_reason"):
                usage["stop_reason"] = event["stop_reason"]
        elif event_type == "tool_start":
            blocks[index] = {"name": event.get("name"), "buf": "", "done": False}
        elif event_type == "tool_input_delta" and index in blocks:
            blocks[index]["buf"] += event.get("partial_json", "")
        elif event_type == "tool_stop" and index in blocks:
            blocks[index]["done"] = True
    return blocks, usage


def collect_tool_call(events: Iterable[dict], tool_name: Optional[str] = None) -> Optional[dict]:
    """Return the first complete, valid matching tool call from a stream."""
    blocks, _ = _collect_blocks(events)
    for block in blocks.values():
        if not block["done"] or (tool_name is not None and block["name"] != tool_name):
            continue
        try:
            parsed = json.loads(block["buf"]) if block["buf"] else {}
        except json.JSONDecodeError:
            continue
        return {"name": block["name"], "input": parsed}
    return None


def tool_call_diagnostics(events: Iterable[dict], tool_name: Optional[str] = None) -> dict:
    """Explain whether a matching tool call started, completed, or contained invalid JSON."""
    blocks, usage = _collect_blocks(events)
    result: dict[str, Any] = {
        "started": False,
        "completed": False,
        "json_error": False,
        **usage,
    }
    for block in blocks.values():
        if tool_name is not None and block["name"] != tool_name:
            continue
        result["started"] = True
        if not block["done"]:
            continue
        result["completed"] = True
        try:
            json.loads(block["buf"]) if block["buf"] else {}
        except json.JSONDecodeError:
            result["json_error"] = True
    return result
