"""Expose Orcha's provider-neutral LLM API while delegating cohesive implementation modules."""

from __future__ import annotations

from typing import Iterator, Optional

try:
    from .llm_catalog import (
        ANTHROPIC_BASE_URL,
        ANTHROPIC_VERSION,
        XAI_BASE_URL,
        LLMError,
        MODEL_GROK_4_20_NONREASONING,
        MODEL_GROK_4_20_REASONING,
        MODEL_GROK_4_3,
        MODEL_HAIKU,
        MODEL_OPUS,
        MODEL_SONNET,
        ModelSpec,
        PROVIDER_CATALOG,
        ProviderNotImplemented,
        USE_CASE_DEFAULTS,
        USE_CASE_REGISTRY,
        is_catalog_choice,
        provider_catalog,
        resolve_api_key,
        resolve_spec,
        use_case_registry,
    )
    from .llm_decisions import HANDOFF_ACK_SCHEMA, TRIAGE_SCHEMA
    from .llm_decisions import handoff_ack as _handoff_ack
    from .llm_decisions import triage_wake as _triage_wake
    from .llm_formats import normalise_anthropic_response as _normalise_anthropic_response
    from .llm_formats import normalise_anthropic_stream_event as _normalise_anthropic_stream_event
    from .llm_http import http_post_json as _http_post_json, http_post_sse as _http_post_sse
    from .llm_observability import log, log_call as _log_call, now_ms as _now_ms
    from .llm_providers import AnthropicProvider, GrokProvider, Provider
    from .llm_providers import get_provider as _default_get_provider
    from .llm_stream import collect_tool_call, tool_call_diagnostics
    from .llm_vision import can_describe
    from .llm_vision import describe_image as _describe_image
except ImportError:  # Portal copies these modules into a top-level build directory.
    from llm_catalog import (
        ANTHROPIC_BASE_URL,
        ANTHROPIC_VERSION,
        XAI_BASE_URL,
        LLMError,
        MODEL_GROK_4_20_NONREASONING,
        MODEL_GROK_4_20_REASONING,
        MODEL_GROK_4_3,
        MODEL_HAIKU,
        MODEL_OPUS,
        MODEL_SONNET,
        ModelSpec,
        PROVIDER_CATALOG,
        ProviderNotImplemented,
        USE_CASE_DEFAULTS,
        USE_CASE_REGISTRY,
        is_catalog_choice,
        provider_catalog,
        resolve_api_key,
        resolve_spec,
        use_case_registry,
    )
    from llm_decisions import HANDOFF_ACK_SCHEMA, TRIAGE_SCHEMA
    from llm_decisions import handoff_ack as _handoff_ack
    from llm_decisions import triage_wake as _triage_wake
    from llm_formats import normalise_anthropic_response as _normalise_anthropic_response
    from llm_formats import normalise_anthropic_stream_event as _normalise_anthropic_stream_event
    from llm_http import http_post_json as _http_post_json, http_post_sse as _http_post_sse
    from llm_observability import log, log_call as _log_call, now_ms as _now_ms
    from llm_providers import AnthropicProvider, GrokProvider, Provider
    from llm_providers import get_provider as _default_get_provider
    from llm_stream import collect_tool_call, tool_call_diagnostics
    from llm_vision import can_describe
    from llm_vision import describe_image as _describe_image

get_provider = _default_get_provider


def classify(
    use_case: str,
    *,
    system: Optional[str],
    user: str,
    schema: dict,
    tool_name: str = "emit_result",
    config: Optional[dict] = None,
    api_key: Optional[str] = None,
    provider: Optional[Provider] = None,
) -> dict:
    """Force one structured tool call and return its validated input."""
    spec = resolve_spec(use_case, config=config)
    transport = provider or get_provider(spec.provider)
    key = "" if provider is not None else resolve_api_key(spec.provider, explicit=api_key)
    tools = [
        {
            "name": tool_name,
            "description": f"Return the structured result for {use_case}.",
            "input_schema": schema,
        }
    ]
    started = _now_ms()
    try:
        response = transport.complete(
            spec=spec,
            system=system,
            messages=[{"role": "user", "content": user}],
            tools=tools,
            tool_choice={"type": "tool", "name": tool_name},
            api_key=key,
        )
    except Exception as exc:
        _log_call(
            use_case=use_case,
            spec=spec,
            outcome="error",
            latency_ms=_now_ms() - started,
            error=str(exc),
        )
        raise
    chosen = next(
        (call for call in response.get("tool_calls") or [] if call.get("name") == tool_name),
        None,
    )
    if not chosen or not isinstance(chosen.get("input"), dict):
        _log_call(
            use_case=use_case,
            spec=spec,
            outcome="error",
            latency_ms=_now_ms() - started,
            usage=response.get("usage"),
            error="no tool_use block in response",
        )
        raise LLMError(f"{use_case}: model returned no '{tool_name}' tool call")
    _log_call(
        use_case=use_case,
        spec=spec,
        outcome="ok",
        latency_ms=_now_ms() - started,
        usage=response.get("usage"),
    )
    return chosen["input"]


def triage_wake(event_text: str, **kwargs) -> dict:
    """Fail open toward waking when triage is uncertain."""
    return _triage_wake(
        event_text,
        classify=classify,
        log_failure=_log_call,
        resolve_spec=resolve_spec,
        **kwargs,
    )


def handoff_ack(handoff_text: str, **kwargs) -> dict:
    """Fail closed toward a full wake when a handoff is uncertain."""
    return _handoff_ack(
        handoff_text,
        classify=classify,
        log_failure=_log_call,
        resolve_spec=resolve_spec,
        **kwargs,
    )


def describe_image(data: bytes, content_type: str, **kwargs) -> str:
    """Best-effort image or PDF transcription for text-only agents."""
    return _describe_image(
        data,
        content_type,
        resolve_spec=resolve_spec,
        get_provider=get_provider,
        resolve_api_key=resolve_api_key,
        log_call=_log_call,
        now_ms=_now_ms,
        **kwargs,
    )


def stream_tool_call(
    use_case: str,
    *,
    system: Optional[str],
    messages: list[dict],
    tools: list[dict],
    tool_choice: Optional[dict] = None,
    config: Optional[dict] = None,
    api_key: Optional[str] = None,
    provider: Optional[Provider] = None,
) -> Iterator[dict]:
    """Yield normalized provider events for a streaming tool call."""
    spec = resolve_spec(use_case, config=config)
    transport = provider or get_provider(spec.provider)
    key = "" if provider is not None else resolve_api_key(spec.provider, explicit=api_key)
    started = _now_ms()
    output_tokens = 0
    try:
        for event in transport.stream(
            spec=spec,
            system=system,
            messages=messages,
            tools=tools,
            tool_choice=tool_choice,
            api_key=key,
        ):
            if event.get("type") == "usage":
                output_tokens = event.get("output_tokens", output_tokens)
            yield event
    except Exception as exc:
        _log_call(
            use_case=use_case,
            spec=spec,
            outcome="error",
            latency_ms=_now_ms() - started,
            error=str(exc),
        )
        raise
    _log_call(
        use_case=use_case,
        spec=spec,
        outcome="ok",
        latency_ms=_now_ms() - started,
        usage={"output_tokens": output_tokens},
    )
