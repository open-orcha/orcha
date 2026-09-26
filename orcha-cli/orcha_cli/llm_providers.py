"""Implement Anthropic and xAI transports behind Orcha's normalized provider interface."""

from __future__ import annotations

import os
from typing import Any, Callable, Iterator, Optional

try:
    from .llm_catalog import (
        ANTHROPIC_BASE_URL,
        ANTHROPIC_VERSION,
        XAI_BASE_URL,
        LLMError,
        ModelSpec,
        ProviderNotImplemented,
    )
    from .llm_formats import (
        flush_openai_stream,
        normalise_anthropic_response,
        normalise_anthropic_stream_event,
        normalise_openai_response,
        normalise_openai_stream_event,
        to_openai_messages,
        to_openai_tool_choice,
        to_openai_tools,
    )
except ImportError:  # Portal copies these modules into a top-level build directory.
    from llm_catalog import (
        ANTHROPIC_BASE_URL,
        ANTHROPIC_VERSION,
        XAI_BASE_URL,
        LLMError,
        ModelSpec,
        ProviderNotImplemented,
    )
    from llm_formats import (
        flush_openai_stream,
        normalise_anthropic_response,
        normalise_anthropic_stream_event,
        normalise_openai_response,
        normalise_openai_stream_event,
        to_openai_messages,
        to_openai_tool_choice,
        to_openai_tools,
    )


def _http_helpers():
    """Resolve facade helpers at call time so existing monkeypatch contracts remain valid."""
    try:
        from . import llm_util
    except ImportError:
        import llm_util
    return llm_util._http_post_json, llm_util._http_post_sse


class Provider:
    """Transport interface returning Orcha-normalized responses and stream events."""

    name = "base"

    def complete(
        self,
        *,
        spec: ModelSpec,
        system: Optional[str],
        messages: list[dict],
        tools: Optional[list[dict]] = None,
        tool_choice: Optional[dict] = None,
        api_key: str,
    ) -> dict:
        raise NotImplementedError

    def stream(
        self,
        *,
        spec: ModelSpec,
        system: Optional[str],
        messages: list[dict],
        tools: Optional[list[dict]] = None,
        tool_choice: Optional[dict] = None,
        api_key: str,
    ) -> Iterator[dict]:
        raise NotImplementedError


class AnthropicProvider(Provider):
    """Anthropic Messages API transport implemented with urllib."""

    name = "anthropic"

    def __init__(self, base_url: Optional[str] = None) -> None:
        self.base_url = (
            base_url or os.environ.get("ORCHA_LLM_BASE_URL") or ANTHROPIC_BASE_URL
        ).rstrip("/")

    @staticmethod
    def _headers(api_key: str) -> dict:
        return {
            "x-api-key": api_key,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
        }

    @staticmethod
    def _body(*, spec, system, messages, tools, tool_choice, stream: bool) -> dict:
        body: dict[str, Any] = {
            "model": spec.model,
            "max_tokens": spec.max_tokens,
            "messages": messages,
        }
        for key, value in (("system", system), ("tools", tools), ("tool_choice", tool_choice)):
            if value:
                body[key] = value
        if stream:
            body["stream"] = True
        return body

    def complete(self, *, spec, system, messages, tools=None, tool_choice=None, api_key):
        post_json, _ = _http_helpers()
        body = self._body(
            spec=spec,
            system=system,
            messages=messages,
            tools=tools,
            tool_choice=tool_choice,
            stream=False,
        )
        raw = post_json(
            self.base_url + "/v1/messages",
            self._headers(api_key),
            body,
            timeout_s=spec.timeout_s,
        )
        return normalise_anthropic_response(raw)

    def stream(self, *, spec, system, messages, tools=None, tool_choice=None, api_key):
        _, post_sse = _http_helpers()
        body = self._body(
            spec=spec,
            system=system,
            messages=messages,
            tools=tools,
            tool_choice=tool_choice,
            stream=True,
        )
        for sse in post_sse(
            self.base_url + "/v1/messages",
            self._headers(api_key),
            body,
            timeout_s=spec.timeout_s,
        ):
            yield from normalise_anthropic_stream_event(sse)


class GrokProvider(Provider):
    """xAI transport using its Chat Completions-compatible wire format."""

    name = "xai"

    def __init__(self, base_url: Optional[str] = None) -> None:
        self.base_url = (
            base_url or os.environ.get("ORCHA_XAI_BASE_URL") or XAI_BASE_URL
        ).rstrip("/")

    @staticmethod
    def _headers(api_key: str) -> dict:
        return {"authorization": f"Bearer {api_key}", "content-type": "application/json"}

    @staticmethod
    def _body(*, spec, system, messages, tools, tool_choice, stream: bool) -> dict:
        body: dict[str, Any] = {
            "model": spec.model,
            "max_tokens": spec.max_tokens,
            "messages": to_openai_messages(system, messages),
        }
        if converted_tools := to_openai_tools(tools):
            body["tools"] = converted_tools
        if (choice := to_openai_tool_choice(tool_choice)) is not None:
            body["tool_choice"] = choice
        if stream:
            body.update(stream=True, stream_options={"include_usage": True})
        return body

    def complete(self, *, spec, system, messages, tools=None, tool_choice=None, api_key):
        post_json, _ = _http_helpers()
        body = self._body(
            spec=spec,
            system=system,
            messages=messages,
            tools=tools,
            tool_choice=tool_choice,
            stream=False,
        )
        raw = post_json(
            self.base_url + "/chat/completions",
            self._headers(api_key),
            body,
            timeout_s=spec.timeout_s,
        )
        return normalise_openai_response(raw)

    def stream(self, *, spec, system, messages, tools=None, tool_choice=None, api_key):
        _, post_sse = _http_helpers()
        body = self._body(
            spec=spec,
            system=system,
            messages=messages,
            tools=tools,
            tool_choice=tool_choice,
            stream=True,
        )
        state: dict[str, Any] = {"tools": {}, "closed": set(), "finish_reason": None}
        for sse in post_sse(
            self.base_url + "/chat/completions",
            self._headers(api_key),
            body,
            timeout_s=spec.timeout_s,
        ):
            yield from normalise_openai_stream_event(sse, state)
        yield from flush_openai_stream(state)


class _StubProvider(Provider):
    """Clear placeholders for catalogued transports that are not live yet."""

    def __init__(self, name: str) -> None:
        self.name = name

    def complete(self, **_):
        raise ProviderNotImplemented(f"provider '{self.name}' is stubbed (Anthropic only in v1)")

    def stream(self, **_):
        raise ProviderNotImplemented(f"provider '{self.name}' is stubbed (Anthropic only in v1)")


_PROVIDERS: dict[str, Callable[[], Provider]] = {
    "anthropic": AnthropicProvider,
    "xai": GrokProvider,
    "openai": lambda: _StubProvider("openai"),
    "gemini": lambda: _StubProvider("gemini"),
}


def get_provider(name: str) -> Provider:
    """Construct the requested provider or raise a clear configuration error."""
    factory = _PROVIDERS.get(name)
    if factory is None:
        raise LLMError(f"unknown provider '{name}' (known: {', '.join(sorted(_PROVIDERS))})")
    return factory()
