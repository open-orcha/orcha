"""Translate provider-specific messages and responses to Orcha's normalized LLM format."""

from __future__ import annotations

import json
from typing import Any, Iterator, Optional


def to_openai_tools(tools: Optional[list[dict]]) -> Optional[list[dict]]:
    """Convert Anthropic-shaped tools to Chat Completions function tools."""
    if not tools:
        return None
    return [
        {
            "type": "function",
            "function": {
                "name": tool.get("name"),
                "description": tool.get("description", ""),
                "parameters": tool.get("input_schema", {}),
            },
        }
        for tool in tools
    ]


def to_openai_tool_choice(tool_choice: Optional[dict]) -> Optional[Any]:
    """Convert a forced tool choice to Chat Completions format."""
    if not tool_choice:
        return None
    if tool_choice.get("type") == "tool" and tool_choice.get("name"):
        return {"type": "function", "function": {"name": tool_choice["name"]}}
    return "auto"


def to_openai_message(message: dict) -> dict:
    """Convert one normalized text or multimodal message."""
    role = message.get("role", "user")
    content = message.get("content")
    if isinstance(content, str):
        return {"role": role, "content": content}
    parts: list[dict] = []
    for block in content or []:
        block_type = block.get("type")
        if block_type == "text":
            parts.append({"type": "text", "text": block.get("text", "")})
        elif block_type == "image":
            source = block.get("source") or {}
            if source.get("type") == "base64":
                media_type = source.get("media_type", "image/png")
                uri = f"data:{media_type};base64,{source.get('data', '')}"
                parts.append({"type": "image_url", "image_url": {"url": uri}})
    return {"role": role, "content": parts}


def to_openai_messages(system: Optional[str], messages: list[dict]) -> list[dict]:
    """Convert a normalized conversation, prefixing its system message."""
    result: list[dict] = []
    if system:
        result.append({"role": "system", "content": system})
    result.extend(to_openai_message(message) for message in messages)
    return result


def normalise_openai_response(raw: dict) -> dict:
    """Normalize one Chat Completions response."""
    choices = raw.get("choices") or []
    message = (choices[0].get("message") if choices else {}) or {}
    tool_calls: list[dict] = []
    for tool_call in message.get("tool_calls") or []:
        function = tool_call.get("function") or {}
        arguments = function.get("arguments")
        try:
            parsed = json.loads(arguments) if isinstance(arguments, str) and arguments else arguments or {}
        except json.JSONDecodeError:
            parsed = {}
        tool_calls.append(
            {
                "name": function.get("name"),
                "input": parsed if isinstance(parsed, dict) else {},
            }
        )
    usage = raw.get("usage") or {}
    text = message.get("content")
    return {
        "text": text if isinstance(text, str) else "",
        "tool_calls": tool_calls,
        "usage": {
            "input_tokens": usage.get("prompt_tokens", 0),
            "output_tokens": usage.get("completion_tokens", 0),
        },
        "stop_reason": choices[0].get("finish_reason") if choices else None,
    }


def normalise_openai_stream_event(sse: dict, state: dict) -> Iterator[dict]:
    """Normalize one Chat Completions stream chunk."""
    usage = sse.get("usage")
    if usage:
        event = {"type": "usage"}
        if usage.get("completion_tokens") is not None:
            event["output_tokens"] = usage.get("completion_tokens", 0)
        if state.get("finish_reason"):
            event["stop_reason"] = state["finish_reason"]
        yield event
    for choice in sse.get("choices") or []:
        delta = choice.get("delta") or {}
        if text := delta.get("content"):
            yield {"type": "text_delta", "text": text}
        for tool_call in delta.get("tool_calls") or []:
            index = tool_call.get("index", 0)
            function = tool_call.get("function") or {}
            if index not in state["tools"]:
                state["tools"][index] = True
                yield {
                    "type": "tool_start",
                    "index": index,
                    "name": function.get("name"),
                    "id": tool_call.get("id"),
                }
            if arguments := function.get("arguments"):
                yield {"type": "tool_input_delta", "index": index, "partial_json": arguments}
        if finish_reason := choice.get("finish_reason"):
            state["finish_reason"] = finish_reason
            yield from flush_openai_stream(state)


def flush_openai_stream(state: dict) -> Iterator[dict]:
    """Close tool blocks that did not receive a provider block-stop event."""
    for index in sorted(state["tools"]):
        if index not in state["closed"]:
            state["closed"].add(index)
            yield {"type": "tool_stop", "index": index}


def normalise_anthropic_response(raw: dict) -> dict:
    """Normalize one Anthropic Messages response."""
    text_parts: list[str] = []
    tool_calls: list[dict] = []
    for block in raw.get("content", []) or []:
        if block.get("type") == "text":
            text_parts.append(block.get("text", ""))
        elif block.get("type") == "tool_use":
            tool_calls.append({"name": block.get("name"), "input": block.get("input", {})})
    usage = raw.get("usage", {}) or {}
    return {
        "text": "".join(text_parts),
        "tool_calls": tool_calls,
        "usage": {
            "input_tokens": usage.get("input_tokens", 0),
            "output_tokens": usage.get("output_tokens", 0),
        },
        "stop_reason": raw.get("stop_reason"),
    }


def normalise_anthropic_stream_event(sse: dict) -> Iterator[dict]:
    """Normalize one Anthropic Messages stream event."""
    event_type = sse.get("type")
    if event_type == "content_block_start":
        block = sse.get("content_block", {}) or {}
        if block.get("type") == "tool_use":
            yield {
                "type": "tool_start",
                "index": sse.get("index"),
                "name": block.get("name"),
                "id": block.get("id"),
            }
    elif event_type == "content_block_delta":
        delta = sse.get("delta", {}) or {}
        if delta.get("type") == "text_delta":
            yield {"type": "text_delta", "text": delta.get("text", "")}
        elif delta.get("type") == "input_json_delta":
            yield {
                "type": "tool_input_delta",
                "index": sse.get("index"),
                "partial_json": delta.get("partial_json", ""),
            }
    elif event_type == "content_block_stop":
        yield {"type": "tool_stop", "index": sse.get("index")}
    elif event_type == "message_delta":
        delta = sse.get("delta", {}) or {}
        usage = sse.get("usage", {}) or {}
        if usage or delta.get("stop_reason"):
            event = {"type": "usage"}
            if usage.get("output_tokens") is not None:
                event["output_tokens"] = usage.get("output_tokens", 0)
            if delta.get("stop_reason"):
                event["stop_reason"] = delta["stop_reason"]
            yield event
