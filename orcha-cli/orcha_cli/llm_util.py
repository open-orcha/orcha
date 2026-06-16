"""Universal, provider-agnostic LLM utility client (Orcha#290).

A SINGLE low-cost LLM call shared by features that need an LLM that is **NOT** the
per-agent embodiment model:

  * #288 Tier-1 wake triage  — high-volume, low-value-per-call -> cheap model (Haiku).
  * Onboarding roster builder — low-volume, high-value         -> capable model (Sonnet).

Design constraints (all validated against the codebase):

  * **Pure stdlib (urllib).** Zero third-party deps, so this file imports UNCHANGED from
    both deploy contexts: the host daemon (`from orcha_cli.llm_util import ...`) and the
    portal container (top-level `import llm_util`, copied in at scaffold like migrations).
    It mirrors notifier.py, which already does all its HTTP over urllib.
  * **Direct API, not the agent's CLI auth.** Credentials come from an Orcha-managed env
    key (`ORCHA_LLM_API_KEY`), independent of any agent's Claude/Codex login. This means it
    works even for **Codex** agents — it is runtime infra, not the agent's brain.
  * **Provider abstraction.** Anthropic Messages API is live; OpenAI / Gemini are stubbed
    behind the same interface (`Provider`). v1 hardcodes the default model per use-case;
    config-swappable later (ties #294 settings / #241 effort levels — kept separate here).
  * **Two call shapes.** (a) one-shot structured classification (`classify` / `triage_wake`,
    via a forced tool call -> deterministic JSON); (b) streaming + tool-use
    (`stream_tool_call` + `collect_tool_call`, e.g. onboarding's `propose_roster`).
  * **Safety defaults for triage.** Fail-OPEN toward WAKE on any error/timeout/uncertainty;
    bounded latency + token budget; every call emits a structured log record on logger
    ``orcha.llm`` for #289's cost / false-skip measurement.

Testability: the public call shapes accept a ``provider=`` override, so unit tests inject a
fake provider and exercise everything with no network and no live key.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Iterator, Optional

# A dedicated logger so #289 can attach a handler and meter cost / false-skips without this
# module knowing anything about the metering project. Default behaviour: emit one JSON record
# per call at INFO. No handler configured -> Python's last-resort handler stays quiet.
log = logging.getLogger("orcha.llm")

# Anthropic Messages API.
ANTHROPIC_BASE_URL = "https://api.anthropic.com"
ANTHROPIC_VERSION = "2023-06-01"

# Model ids (latest Claude family as of 2026-01). Cheap triage model vs. capable onboarding
# model. v1 hardcodes these; #294 settings make them config-swappable per use-case later.
MODEL_HAIKU = "claude-haiku-4-5-20251001"
MODEL_SONNET = "claude-sonnet-4-6"
MODEL_OPUS = "claude-opus-4-8"


# ------------------------------------------------------------------- catalog (#294)
#
# The provider+model catalog that feeds the SETTINGS page dropdowns (SPEC-SETTINGS §0/§3).
# This is the universal-client axis (provider abstraction: Anthropic live, OpenAI/Gemini
# stubbed) — deliberately DISTINCT from GET /api/models, which is the spawnable-embodiment
# (claude/codex runtime) catalog. Feeding the Settings dropdowns from here, not /api/models,
# is the §0 "two model concepts, never one" guarantee. A stubbed provider stays in the list
# but `available=False` so the UI can show it disabled ("coming soon") — honest, never a dead
# option. `models` mirrors the registry above; a new model ships by adding one row here.
PROVIDER_CATALOG: list[dict] = [
    {"id": "anthropic", "name": "Anthropic", "available": True, "models": [
        {"id": MODEL_HAIKU, "name": "Haiku 4.5"},
        {"id": MODEL_SONNET, "name": "Sonnet 4.6"},
        {"id": MODEL_OPUS, "name": "Opus 4.8"},
    ]},
    {"id": "openai", "name": "OpenAI", "available": False, "models": []},
    {"id": "gemini", "name": "Gemini", "available": False, "models": []},
]


def provider_catalog() -> list[dict]:
    """A deep-ish copy of PROVIDER_CATALOG for the GET /settings/providers route. Copied so a
    caller (or JSON serializer) can't mutate the module constant."""
    return [
        {"id": p["id"], "name": p["name"], "available": p["available"],
         "models": [dict(m) for m in p["models"]]}
        for p in PROVIDER_CATALOG
    ]


def is_catalog_choice(provider: str, model: str) -> bool:
    """True iff (provider, model) is a live, selectable choice in the catalog — an AVAILABLE
    provider that lists this model. The SETTINGS PUT validates against this so a stubbed
    provider (openai/gemini) or a bogus model id can't be stored. (A model that LATER retires
    from the catalog is handled separately on read — the stored row is kept, not auto-cleared,
    and resolve_spec degrades to the default; SPEC-SETTINGS §4.)"""
    for p in PROVIDER_CATALOG:
        if p["id"] == provider and p["available"]:
            return any(m["id"] == model for m in p["models"])
    return False


# ---------------------------------------------------------------------------- errors


class LLMError(RuntimeError):
    """Any failure talking to a provider (HTTP error, timeout, bad response, no key)."""


class ProviderNotImplemented(LLMError):
    """A provider exists in the registry but its transport is not wired yet (OpenAI/Gemini)."""


# ------------------------------------------------------------------------ model specs


@dataclass(frozen=True)
class ModelSpec:
    """Resolved {provider, model, budget} for one use-case. Frozen so a default can't be
    mutated by a caller; ``swap()`` returns a modified copy for config overrides."""

    provider: str = "anthropic"
    model: str = MODEL_SONNET
    max_tokens: int = 1024
    timeout_s: float = 30.0

    def swap(self, **overrides: Any) -> "ModelSpec":
        merged = {**self.__dict__, **{k: v for k, v in overrides.items() if v is not None}}
        return ModelSpec(**merged)


# v1 hardcoded per-use-case defaults. Triage is cheap + tightly bounded (high volume); the
# capable use-cases get a bigger budget and longer timeout (low volume, high value).
USE_CASE_DEFAULTS: dict[str, ModelSpec] = {
    "triage": ModelSpec(provider="anthropic", model=MODEL_HAIKU, max_tokens=256, timeout_s=12.0),
    # #307 graded-wake T2 cheap-act: judge-AND-compose a routine handoff acknowledgement. Same
    # cheap/high-volume profile as triage (it sits on the same per-event wake path), with a touch
    # more budget since it also composes a one-sentence reply. Fails CLOSED so a tight timeout
    # escalates to a full boot rather than dropping the handoff.
    "ack": ModelSpec(provider="anthropic", model=MODEL_HAIKU, max_tokens=384, timeout_s=12.0),
    "onboarding": ModelSpec(provider="anthropic", model=MODEL_SONNET, max_tokens=8192, timeout_s=60.0),
    # #287 boot-copy digest tail-summary: high-volume (per wake), low-value-per-call → cheap
    # model, tight budget. Fails safe to a deterministic breadcrumb (digest_curate), never blocks.
    "digest_summary": ModelSpec(provider="anthropic", model=MODEL_HAIKU, max_tokens=512, timeout_s=20.0),
    # #247 item-3 cold-boot history curation: judgment-heavy (a lossy summary poisons the boot)
    # so SONNET, but it sits ON the cold-boot latency path → a SMALL token budget + a tight
    # timeout, so a slow call fails open to the mechanical drop instead of stalling the spawn.
    # Deliberately NOT in USE_CASE_REGISTRY for v1 (kept off the #294 settings page); the
    # thresholds live as constants in digest_curation and #294 can register+tune this later.
    "curation": ModelSpec(provider="anthropic", model=MODEL_SONNET, max_tokens=512, timeout_s=20.0),
    # #338 Codex image->text: a Codex agent is text-only argv (notifier.py) and cannot SEE image
    # pixels, so an attached image/PDF is invisible to it. This use-case runs a vision-capable
    # model over the file's bytes to produce an OCR/description the Codex prompt can carry as text.
    # Off the latency-critical path (runs while building a one-shot worker prompt, not on a human's
    # keystroke), so a generous-but-bounded budget; Sonnet is the cheapest reliable-vision tier.
    "vision": ModelSpec(provider="anthropic", model=MODEL_SONNET, max_tokens=1024, timeout_s=45.0),
}

# Fallback for an unknown use-case: capable model, modest budget. Callers should register a
# real entry, but an unknown key must not crash a feature.
_DEFAULT_SPEC = ModelSpec(provider="anthropic", model=MODEL_SONNET, max_tokens=1024, timeout_s=30.0)


# The REGISTERED use-case set the SETTINGS page renders (SPEC-SETTINGS §2). ORDERED, and the
# single place a use-case is named: adding a use-case to the page is registering an entry here
# (+ a USE_CASE_DEFAULTS spec) — zero page edits (issue DoD "new key appears with zero page
# edits"). `label`/`purpose` are the row's copy; the shipped default provider+model come from
# USE_CASE_DEFAULTS[key] so they can never drift from what resolve_spec actually falls back to.
USE_CASE_REGISTRY: list[dict] = [
    {"key": "onboarding", "label": "Onboarding",
     "purpose": "Drafts the agent roster from your goal. Wants a capable model."},
    {"key": "triage", "label": "Wake eligibility",
     "purpose": "Triages whether an incoming event is worth waking an agent. Wants a cheap model."},
    {"key": "ack", "label": "Routine handoff",
     "purpose": "Acknowledges a routine handoff (an answer or an approval) without waking a full "
                "agent. Wants a cheap model."},
]


def use_case_registry() -> list[dict]:
    """The registered use-cases joined with their shipped-default {provider, model} from
    USE_CASE_DEFAULTS — the data the GET /settings/models route layers stored overrides onto.
    Defaults are sourced from the same USE_CASE_DEFAULTS that resolve_spec uses, so the page's
    'default: X' chip is always exactly the fallback the client would apply."""
    out = []
    for uc in USE_CASE_REGISTRY:
        spec = USE_CASE_DEFAULTS.get(uc["key"], _DEFAULT_SPEC)
        out.append({"key": uc["key"], "label": uc["label"], "purpose": uc["purpose"],
                    "default_provider": spec.provider, "default_model": spec.model})
    return out


def resolve_spec(use_case: str, *, config: Optional[dict] = None) -> ModelSpec:
    """Resolve the ModelSpec for ``use_case``.

    Precedence: explicit ``config`` override (a {use_case: {provider/model/...}} dict, the
    shape #294 will supply) > hardcoded ``USE_CASE_DEFAULTS`` > ``_DEFAULT_SPEC``. An override
    is a partial — only the keys present are swapped, the rest keep the default.
    """
    base = USE_CASE_DEFAULTS.get(use_case, _DEFAULT_SPEC)
    if config and use_case in config and isinstance(config[use_case], dict):
        base = base.swap(**config[use_case])
    return base


# ------------------------------------------------------------------- credentials


def resolve_api_key(provider: str, *, explicit: Optional[str] = None) -> str:
    """Resolve the Orcha-managed API key for ``provider``.

    Precedence: explicit arg > ``ORCHA_LLM_API_KEY`` (Orcha-managed, provider-neutral) >
    the provider's conventional env var. The Orcha key is deliberately FIRST + independent of
    any agent's CLI auth so this works for Codex agents and in CI/headless contexts.
    """
    if explicit:
        return explicit
    orcha_key = os.environ.get("ORCHA_LLM_API_KEY")
    if orcha_key:
        return orcha_key
    fallback_env = {
        "anthropic": "ANTHROPIC_API_KEY",
        "openai": "OPENAI_API_KEY",
        "gemini": "GEMINI_API_KEY",
    }.get(provider)
    key = os.environ.get(fallback_env) if fallback_env else None
    if not key:
        raise LLMError(
            f"no API key for provider '{provider}': set ORCHA_LLM_API_KEY "
            f"(or {fallback_env}) in the environment"
        )
    return key


# --------------------------------------------------------------------- providers


class Provider:
    """Transport interface. A provider turns a normalised request into either a single
    response dict (``complete``) or an iterator of normalised stream events (``stream``).

    Normalised response (``complete``): ``{"text": str, "tool_calls": [{"name","input"}],
    "usage": {"input_tokens", "output_tokens"}, "stop_reason": str}``.

    Normalised stream events (``stream``): dicts ``{"type": ...}`` — ``text_delta``/``text``,
    ``tool_start``/``tool_input_delta``/``tool_stop`` (input accumulates as JSON-string
    fragments), and ``usage``. ``collect_tool_call`` knows how to assemble these.
    """

    name = "base"

    def complete(self, *, spec: ModelSpec, system: Optional[str], messages: list[dict],
                 tools: Optional[list[dict]] = None, tool_choice: Optional[dict] = None,
                 api_key: str) -> dict:
        raise NotImplementedError

    def stream(self, *, spec: ModelSpec, system: Optional[str], messages: list[dict],
               tools: Optional[list[dict]] = None, tool_choice: Optional[dict] = None,
               api_key: str) -> Iterator[dict]:
        raise NotImplementedError


class AnthropicProvider(Provider):
    """Live provider over the Anthropic Messages API, using only urllib."""

    name = "anthropic"

    def __init__(self, base_url: Optional[str] = None) -> None:
        # ORCHA_LLM_BASE_URL lets ops point at a proxy/gateway without code changes.
        self.base_url = (base_url or os.environ.get("ORCHA_LLM_BASE_URL") or ANTHROPIC_BASE_URL).rstrip("/")

    def _headers(self, api_key: str) -> dict:
        return {
            "x-api-key": api_key,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
        }

    def _body(self, *, spec: ModelSpec, system, messages, tools, tool_choice, stream: bool) -> dict:
        body: dict[str, Any] = {
            "model": spec.model,
            "max_tokens": spec.max_tokens,
            "messages": messages,
        }
        if system:
            body["system"] = system
        if tools:
            body["tools"] = tools
        if tool_choice:
            body["tool_choice"] = tool_choice
        if stream:
            body["stream"] = True
        return body

    def complete(self, *, spec, system, messages, tools=None, tool_choice=None, api_key):
        body = self._body(spec=spec, system=system, messages=messages, tools=tools,
                          tool_choice=tool_choice, stream=False)
        raw = _http_post_json(self.base_url + "/v1/messages", self._headers(api_key), body,
                              timeout_s=spec.timeout_s)
        return _normalise_anthropic_response(raw)

    def stream(self, *, spec, system, messages, tools=None, tool_choice=None, api_key):
        body = self._body(spec=spec, system=system, messages=messages, tools=tools,
                          tool_choice=tool_choice, stream=True)
        for sse in _http_post_sse(self.base_url + "/v1/messages", self._headers(api_key), body,
                                  timeout_s=spec.timeout_s):
            for ev in _normalise_anthropic_stream_event(sse):
                yield ev


class _StubProvider(Provider):
    """OpenAI / Gemini placeholders: present in the registry, behind the SAME interface, so a
    caller can select them via config — but the transport is not wired yet. They raise a clear
    error instead of silently behaving like Anthropic."""

    def __init__(self, name: str) -> None:
        self.name = name

    def complete(self, **_):
        raise ProviderNotImplemented(f"provider '{self.name}' is stubbed (Anthropic only in v1)")

    def stream(self, **_):
        raise ProviderNotImplemented(f"provider '{self.name}' is stubbed (Anthropic only in v1)")


# Registry. ``get_provider`` is the single entry point so call shapes never instantiate
# providers directly (keeps the swap-in point for tests / future providers in one place).
_PROVIDERS: dict[str, Callable[[], Provider]] = {
    "anthropic": AnthropicProvider,
    "openai": lambda: _StubProvider("openai"),
    "gemini": lambda: _StubProvider("gemini"),
}


def get_provider(name: str) -> Provider:
    factory = _PROVIDERS.get(name)
    if factory is None:
        raise LLMError(f"unknown provider '{name}' (known: {', '.join(sorted(_PROVIDERS))})")
    return factory()


# ------------------------------------------------------------------ HTTP (urllib)


def _http_post_json(url: str, headers: dict, body: dict, *, timeout_s: float) -> dict:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:500] if hasattr(e, "read") else str(e)
        raise LLMError(f"HTTP {e.code} from {url}: {detail}") from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise LLMError(f"transport error to {url}: {e}") from e
    except json.JSONDecodeError as e:
        raise LLMError(f"non-JSON response from {url}: {e}") from e


def _http_post_sse(url: str, headers: dict, body: dict, *, timeout_s: float) -> Iterator[dict]:
    """POST and yield parsed SSE ``data:`` payloads as dicts (Anthropic stream framing)."""
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            for raw in resp:
                line = raw.decode("utf-8", "replace").strip()
                if not line or line.startswith("event:"):
                    continue
                if line.startswith("data:"):
                    payload = line[len("data:"):].strip()
                    if not payload or payload == "[DONE]":
                        continue
                    try:
                        yield json.loads(payload)
                    except json.JSONDecodeError:
                        continue
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:500] if hasattr(e, "read") else str(e)
        raise LLMError(f"HTTP {e.code} from {url}: {detail}") from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise LLMError(f"transport error to {url}: {e}") from e


# ----------------------------------------------------- Anthropic normalisation


def _normalise_anthropic_response(raw: dict) -> dict:
    text_parts: list[str] = []
    tool_calls: list[dict] = []
    for block in raw.get("content", []) or []:
        btype = block.get("type")
        if btype == "text":
            text_parts.append(block.get("text", ""))
        elif btype == "tool_use":
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


def _normalise_anthropic_stream_event(sse: dict) -> Iterator[dict]:
    """Map one raw Anthropic SSE event to zero+ normalised stream events."""
    etype = sse.get("type")
    if etype == "content_block_start":
        block = sse.get("content_block", {}) or {}
        if block.get("type") == "tool_use":
            yield {"type": "tool_start", "index": sse.get("index"),
                   "name": block.get("name"), "id": block.get("id")}
    elif etype == "content_block_delta":
        delta = sse.get("delta", {}) or {}
        dtype = delta.get("type")
        if dtype == "text_delta":
            yield {"type": "text_delta", "text": delta.get("text", "")}
        elif dtype == "input_json_delta":
            yield {"type": "tool_input_delta", "index": sse.get("index"),
                   "partial_json": delta.get("partial_json", "")}
    elif etype == "content_block_stop":
        yield {"type": "tool_stop", "index": sse.get("index")}
    elif etype == "message_delta":
        delta = sse.get("delta", {}) or {}
        usage = sse.get("usage", {}) or {}
        stop_reason = delta.get("stop_reason")
        if usage or stop_reason:
            ev = {"type": "usage"}
            if usage.get("output_tokens") is not None:
                ev["output_tokens"] = usage.get("output_tokens", 0)
            if stop_reason:
                ev["stop_reason"] = stop_reason
            yield ev


# ----------------------------------------------------------------- observability


def _log_call(*, use_case: str, spec: ModelSpec, outcome: str, latency_ms: int,
              usage: Optional[dict] = None, error: Optional[str] = None) -> None:
    """Emit one structured record per call so #289 can meter cost / false-skips."""
    record = {
        "event": "llm_call",
        "use_case": use_case,
        "provider": spec.provider,
        "model": spec.model,
        "outcome": outcome,  # ok | error | fail_open
        "latency_ms": latency_ms,
        "input_tokens": (usage or {}).get("input_tokens", 0),
        "output_tokens": (usage or {}).get("output_tokens", 0),
    }
    if error:
        record["error"] = error[:300]
    log.info(json.dumps(record, sort_keys=True))


def _now_ms() -> int:
    return int(time.monotonic() * 1000)


# ---------------------------------------------------------------- call shape (a)


def classify(use_case: str, *, system: Optional[str], user: str, schema: dict,
             tool_name: str = "emit_result", config: Optional[dict] = None,
             api_key: Optional[str] = None, provider: Optional[Provider] = None) -> dict:
    """One-shot STRUCTURED classification.

    Forces the model to call a single tool whose ``input_schema`` is ``schema`` and returns
    that tool's input dict — deterministic JSON, no brittle text parsing. Raises ``LLMError``
    on any failure (callers that need a safety default wrap this — see ``triage_wake``).
    """
    spec = resolve_spec(use_case, config=config)
    prov = provider or get_provider(spec.provider)
    key = "" if provider is not None else resolve_api_key(spec.provider, explicit=api_key)
    tools = [{"name": tool_name, "description": f"Return the structured result for {use_case}.",
              "input_schema": schema}]
    tool_choice = {"type": "tool", "name": tool_name}
    started = _now_ms()
    try:
        resp = prov.complete(spec=spec, system=system, messages=[{"role": "user", "content": user}],
                             tools=tools, tool_choice=tool_choice, api_key=key)
    except Exception as e:
        _log_call(use_case=use_case, spec=spec, outcome="error",
                  latency_ms=_now_ms() - started, error=str(e))
        raise
    calls = resp.get("tool_calls") or []
    # Forced tool call: require the EXACT tool we asked for. A wrong-named tool's
    # output must NOT be accepted via a positional fallback — for triage that would
    # let a malformed {wake:false} suppress a wake (see triage_wake fail-open contract).
    chosen = next((c for c in calls if c.get("name") == tool_name), None)
    if not chosen or not isinstance(chosen.get("input"), dict):
        _log_call(use_case=use_case, spec=spec, outcome="error",
                  latency_ms=_now_ms() - started, usage=resp.get("usage"),
                  error="no tool_use block in response")
        raise LLMError(f"{use_case}: model returned no '{tool_name}' tool call")
    _log_call(use_case=use_case, spec=spec, outcome="ok",
              latency_ms=_now_ms() - started, usage=resp.get("usage"))
    return chosen["input"]


# Schema for the triage decision: a wake bool + a short reason.
TRIAGE_SCHEMA = {
    "type": "object",
    "properties": {
        "wake": {"type": "boolean",
                 "description": "True if this event needs the agent woken; False if it is safe to skip."},
        "reason": {"type": "string", "description": "One short sentence justifying the decision."},
    },
    "required": ["wake", "reason"],
}

_TRIAGE_SYSTEM = (
    "You decide whether an autonomous agent must be WOKEN for an incoming event, or whether "
    "waking would burn tokens for no action. Wake if the event needs a human-or-agent response, "
    "changes task state, or asks a question. Skip pure acknowledgements/FYIs that need no action. "
    "When uncertain, prefer to WAKE."
)


def triage_wake(event_text: str, *, system: Optional[str] = None, config: Optional[dict] = None,
                api_key: Optional[str] = None, provider: Optional[Provider] = None) -> dict:
    """#288 Tier-1 triage. Returns ``{"wake": bool, "reason": str}``.

    FAIL-OPEN: any error/timeout/uncertainty -> ``{"wake": True, ...}`` so a flaky LLM can
    never *suppress* a wake (the expensive failure mode). The decision is logged either way.
    """
    spec = resolve_spec("triage", config=config)
    try:
        result = classify("triage", system=system or _TRIAGE_SYSTEM, user=event_text,
                          schema=TRIAGE_SCHEMA, config=config, api_key=api_key, provider=provider)
        # FAIL-OPEN: only an explicit boolean False suppresses a wake. A missing/null/
        # non-bool ``wake`` is malformed output and must NOT be coerced to skip
        # (bool(None) is False) — anything that isn't literally False wakes the agent.
        raw = result.get("wake", True)
        wake = raw is not False
        return {"wake": wake, "reason": str(result.get("reason", ""))}
    except Exception as e:
        _log_call(use_case="triage", spec=spec, outcome="fail_open", latency_ms=0, error=str(e))
        return {"wake": True, "reason": f"fail-open: {e}"}


# ---------------------------------------------------------------- call shape (c)

# Media types we can hand to the vision model. Images go in an `image` content block; PDFs in a
# `document` block (Anthropic reads both natively). Anything else has no pixels/pages to OCR.
_VISION_IMAGE_TYPES = {"image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"}
_VISION_DOC_TYPES = {"application/pdf"}

_DESCRIBE_SYSTEM = (
    "You convert a binary file (an image or PDF) into TEXT for a text-only agent that cannot see "
    "it. Transcribe ALL readable text verbatim (OCR), then briefly describe non-text visual content "
    "(diagrams, charts, photos, layout) so the agent can act on the file. Be faithful and concise; "
    "do not speculate beyond what is present. Output plain text only."
)


def can_describe(content_type: Optional[str]) -> bool:
    """True if describe_image can OCR/transcribe this media type (image or PDF)."""
    ct = (content_type or "").lower()
    return ct in _VISION_IMAGE_TYPES or ct in _VISION_DOC_TYPES


def describe_image(data: bytes, content_type: str, *, use_case: str = "vision",
                   prompt: Optional[str] = None, config: Optional[dict] = None,
                   api_key: Optional[str] = None, provider: Optional[Provider] = None) -> str:
    """#338 Codex image->text. Turn an image's (or PDF's) BYTES into transcribed/described TEXT a
    text-only runtime (Codex) can act on, since it cannot view pixels.

    FAIL-OPEN: returns ``""`` on ANY problem (unsupported type, missing key, network/timeout,
    empty model output). A failed conversion must never break the worker spawn — the agent still
    gets the file's URL from the feed and can fetch it; the extracted text is a best-effort
    enrichment, not a hard dependency. The conversion is logged either way for #289 metering.
    """
    ct = (content_type or "").lower()
    if not data or not can_describe(ct):
        return ""
    spec = resolve_spec(use_case, config=config)
    if ct in _VISION_DOC_TYPES:
        source_type, block_type = "application/pdf", "document"
    else:
        source_type, block_type = ct, "image"
    block = {"type": block_type,
             "source": {"type": "base64", "media_type": source_type,
                        "data": base64.b64encode(data).decode("ascii")}}
    messages = [{"role": "user", "content": [
        block,
        {"type": "text", "text": prompt or "Transcribe and describe this file for a text-only agent."},
    ]}]
    prov = provider or get_provider(spec.provider)
    key = "" if provider is not None else resolve_api_key(spec.provider, explicit=api_key)
    started = _now_ms()
    try:
        resp = prov.complete(spec=spec, system=_DESCRIBE_SYSTEM, messages=messages, api_key=key)
        text = (resp.get("text") or "").strip()
        _log_call(use_case=use_case, spec=spec, outcome="ok" if text else "fail_open",
                  latency_ms=_now_ms() - started, usage=resp.get("usage"),
                  error=None if text else "empty vision output")
        return text
    except Exception as e:
        _log_call(use_case=use_case, spec=spec, outcome="fail_open",
                  latency_ms=_now_ms() - started, error=str(e))
        return ""


# Schema for the #307 T2 handoff-ack decision: an ack bool + the composed acknowledgement line.
HANDOFF_ACK_SCHEMA = {
    "type": "object",
    "properties": {
        "ack": {"type": "boolean",
                "description": "True ONLY if the right next step is a brief acknowledgement that "
                               "closes the loop. False if the message asks for ANY real work — a "
                               "change, a rebase, a question to answer, a decision to make."},
        "text": {"type": "string",
                 "description": "A short, warm one-sentence acknowledgement to post in the agent's "
                                "voice. Only meaningful when ack is true."},
    },
    "required": ["ack", "text"],
}

_HANDOFF_ACK_SYSTEM = (
    "You are standing in for an autonomous agent that just received a ROUTINE handoff — an answer "
    "to one of its own questions, or an approval of work it completed. Decide whether the only "
    "appropriate next step is a brief acknowledgement that closes the loop (ack=true), or whether "
    "the message actually asks for more work — a change, a rebase, a question, a decision (ack=false). "
    "When ack=true, also compose a short, warm one-sentence acknowledgement in the agent's voice. "
    "When in ANY doubt, return ack=false so a full agent handles it."
)


def handoff_ack(handoff_text: str, *, system: Optional[str] = None, config: Optional[dict] = None,
                api_key: Optional[str] = None, provider: Optional[Provider] = None) -> dict:
    """#307 T2 cheap-act: judge whether a routine handoff needs only an acknowledgement, and if so
    compose it. Returns ``{"ack": bool, "text": str}``.

    FAIL-CLOSED — the deliberate MIRROR of ``triage_wake``'s fail-open. Any error/timeout, a
    non-boolean ``ack``, or an ack=True with a blank composed line all return
    ``{"ack": False, "text": ""}`` so the daemon ESCALATES to a full embodiment. A flaky cheap
    model must never auto-ack something that might need real work: here the expensive failure mode
    is a DROPPED handoff, not a wasted boot, so uncertainty escalates rather than suppresses."""
    spec = resolve_spec("ack", config=config)
    try:
        result = classify("ack", system=system or _HANDOFF_ACK_SYSTEM, user=handoff_text,
                          schema=HANDOFF_ACK_SCHEMA, config=config, api_key=api_key, provider=provider)
        # FAIL-CLOSED: only an explicit boolean True WITH a non-empty composed line acks. A
        # missing/null/non-bool ack (the bool(None) trap) or a blank line escalates.
        ack = result.get("ack")
        text = (result.get("text") or "").strip()
        if ack is True and text:
            return {"ack": True, "text": text}
        return {"ack": False, "text": ""}
    except Exception as e:
        _log_call(use_case="ack", spec=spec, outcome="fail_closed", latency_ms=0, error=str(e))
        return {"ack": False, "text": ""}


# ---------------------------------------------------------------- call shape (b)


def stream_tool_call(use_case: str, *, system: Optional[str], messages: list[dict],
                     tools: list[dict], tool_choice: Optional[dict] = None,
                     config: Optional[dict] = None, api_key: Optional[str] = None,
                     provider: Optional[Provider] = None) -> Iterator[dict]:
    """Streaming + tool-use. Yields normalised stream events (see ``Provider``). The onboarding
    backend streams progress to the UI and uses ``collect_tool_call`` to pull the final
    ``propose_roster`` input once the stream completes."""
    spec = resolve_spec(use_case, config=config)
    prov = provider or get_provider(spec.provider)
    key = "" if provider is not None else resolve_api_key(spec.provider, explicit=api_key)
    started = _now_ms()
    out_tokens = 0
    try:
        for ev in prov.stream(spec=spec, system=system, messages=messages, tools=tools,
                              tool_choice=tool_choice, api_key=key):
            if ev.get("type") == "usage":
                out_tokens = ev.get("output_tokens", out_tokens)
            yield ev
    except Exception as e:
        _log_call(use_case=use_case, spec=spec, outcome="error",
                  latency_ms=_now_ms() - started, error=str(e))
        raise
    _log_call(use_case=use_case, spec=spec, outcome="ok", latency_ms=_now_ms() - started,
              usage={"output_tokens": out_tokens})


def collect_tool_call(events: Iterable[dict], tool_name: Optional[str] = None) -> Optional[dict]:
    """Assemble a tool call from a stream of normalised events.

    Accumulates ``tool_input_delta`` ``partial_json`` fragments per block, parses the JSON at
    ``tool_stop``, and returns ``{"name", "input"}`` for the first matching tool (or the first
    tool if ``tool_name`` is None). Returns None if no complete tool call was produced.
    """
    by_index: dict[Any, dict] = {}
    for ev in events:
        etype = ev.get("type")
        idx = ev.get("index")
        if etype == "tool_start":
            by_index[idx] = {"name": ev.get("name"), "buf": "", "done": False}
        elif etype == "tool_input_delta" and idx in by_index:
            by_index[idx]["buf"] += ev.get("partial_json", "")
        elif etype == "tool_stop" and idx in by_index:
            by_index[idx]["done"] = True
    for entry in by_index.values():
        if not entry["done"]:
            continue
        if tool_name is not None and entry["name"] != tool_name:
            continue
        try:
            parsed = json.loads(entry["buf"]) if entry["buf"] else {}
        except json.JSONDecodeError:
            continue
        return {"name": entry["name"], "input": parsed}
    return None


def tool_call_diagnostics(events: Iterable[dict], tool_name: Optional[str] = None) -> dict:
    """Summarise why ``collect_tool_call`` may have returned None for a stream.

    Existing callers keep the simple success-only API, while streaming endpoints
    can tell a missing tool from a truncated or malformed forced tool call.
    """
    by_index: dict[Any, dict] = {}
    out: dict[str, Any] = {
        "started": False,
        "completed": False,
        "json_error": False,
        "stop_reason": None,
        "output_tokens": 0,
    }
    for ev in events:
        etype = ev.get("type")
        idx = ev.get("index")
        if etype == "usage":
            if ev.get("output_tokens") is not None:
                out["output_tokens"] = ev.get("output_tokens", 0)
            if ev.get("stop_reason"):
                out["stop_reason"] = ev.get("stop_reason")
        elif etype == "tool_start":
            by_index[idx] = {"name": ev.get("name"), "buf": "", "done": False}
        elif etype == "tool_input_delta" and idx in by_index:
            by_index[idx]["buf"] += ev.get("partial_json", "")
        elif etype == "tool_stop" and idx in by_index:
            by_index[idx]["done"] = True

    for entry in by_index.values():
        if tool_name is not None and entry["name"] != tool_name:
            continue
        out["started"] = True
        if not entry["done"]:
            continue
        out["completed"] = True
        try:
            json.loads(entry["buf"]) if entry["buf"] else {}
        except json.JSONDecodeError:
            out["json_error"] = True
    return out
