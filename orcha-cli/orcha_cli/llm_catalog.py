"""Define LLM providers, models, use-case defaults, and credential resolution."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Optional

ANTHROPIC_BASE_URL = "https://api.anthropic.com"
ANTHROPIC_VERSION = "2023-06-01"
XAI_BASE_URL = "https://api.x.ai/v1"

MODEL_HAIKU = "claude-haiku-4-5-20251001"
MODEL_SONNET = "claude-sonnet-5"
MODEL_OPUS = "claude-opus-4-8"
MODEL_GROK_4_3 = "grok-4.3"
MODEL_GROK_4_20_REASONING = "grok-4.20-0309-reasoning"
MODEL_GROK_4_20_NONREASONING = "grok-4.20-0309-non-reasoning"


class LLMError(RuntimeError):
    """Any failure talking to an LLM provider."""


class ProviderNotImplemented(LLMError):
    """A catalogued provider whose transport is not wired yet."""


@dataclass(frozen=True)
class ModelSpec:
    """Resolved provider, model, budget, and timeout for one use case."""

    provider: str = "anthropic"
    model: str = MODEL_SONNET
    max_tokens: int = 1024
    timeout_s: float = 30.0

    def swap(self, **overrides: Any) -> "ModelSpec":
        merged = {**self.__dict__, **{k: v for k, v in overrides.items() if v is not None}}
        return ModelSpec(**merged)


PROVIDER_CATALOG: list[dict] = [
    {
        "id": "anthropic",
        "name": "Anthropic",
        "available": True,
        "models": [
            {"id": MODEL_HAIKU, "name": "Haiku 4.5"},
            {"id": MODEL_SONNET, "name": "Sonnet 5"},
            {"id": MODEL_OPUS, "name": "Opus 4.8"},
        ],
    },
    {
        "id": "xai",
        "name": "xAI",
        "available": True,
        "models": [
            {"id": MODEL_GROK_4_3, "name": "Grok 4.3"},
            {"id": MODEL_GROK_4_20_REASONING, "name": "Grok 4.20 (reasoning)"},
            {"id": MODEL_GROK_4_20_NONREASONING, "name": "Grok 4.20 (non-reasoning)"},
        ],
    },
    {"id": "openai", "name": "OpenAI", "available": False, "models": []},
    {"id": "gemini", "name": "Gemini", "available": False, "models": []},
]

USE_CASE_DEFAULTS: dict[str, ModelSpec] = {
    "triage": ModelSpec(model=MODEL_HAIKU, max_tokens=256, timeout_s=12.0),
    "ack": ModelSpec(model=MODEL_HAIKU, max_tokens=384, timeout_s=12.0),
    "onboarding": ModelSpec(model=MODEL_SONNET, max_tokens=8192, timeout_s=60.0),
    "digest_summary": ModelSpec(model=MODEL_HAIKU, max_tokens=512, timeout_s=20.0),
    "curation": ModelSpec(model=MODEL_SONNET, max_tokens=512, timeout_s=20.0),
    "vision": ModelSpec(model=MODEL_SONNET, max_tokens=1024, timeout_s=45.0),
}
_DEFAULT_SPEC = ModelSpec()

USE_CASE_REGISTRY: list[dict] = [
    {
        "key": "onboarding",
        "label": "Onboarding",
        "purpose": "Drafts the agent roster from your goal. Wants a capable model.",
    },
    {
        "key": "triage",
        "label": "Wake eligibility",
        "purpose": "Triages whether an incoming event is worth waking an agent. Wants a cheap model.",
    },
    {
        "key": "ack",
        "label": "Routine handoff",
        "purpose": "Acknowledges a routine handoff without waking a full agent. Wants a cheap model.",
    },
]


def provider_catalog() -> list[dict]:
    """Return a copy safe for callers and JSON serializers to mutate."""
    return [
        {
            "id": provider["id"],
            "name": provider["name"],
            "available": provider["available"],
            "models": [dict(model) for model in provider["models"]],
        }
        for provider in PROVIDER_CATALOG
    ]


def is_catalog_choice(provider: str, model: str) -> bool:
    """Whether the provider/model pair is currently selectable."""
    for candidate in PROVIDER_CATALOG:
        if candidate["id"] == provider and candidate["available"]:
            return any(item["id"] == model for item in candidate["models"])
    return False


def use_case_registry() -> list[dict]:
    """Join settings-page metadata with the actual shipped defaults."""
    result = []
    for use_case in USE_CASE_REGISTRY:
        spec = USE_CASE_DEFAULTS.get(use_case["key"], _DEFAULT_SPEC)
        result.append(
            {
                **use_case,
                "default_provider": spec.provider,
                "default_model": spec.model,
            }
        )
    return result


def resolve_spec(use_case: str, *, config: Optional[dict] = None) -> ModelSpec:
    """Resolve a use-case spec, applying an optional partial override."""
    base = USE_CASE_DEFAULTS.get(use_case, _DEFAULT_SPEC)
    if config and isinstance(config.get(use_case), dict):
        return base.swap(**config[use_case])
    return base


def resolve_api_key(provider: str, *, explicit: Optional[str] = None) -> str:
    """Resolve an explicit, Orcha-managed, or provider-conventional API key."""
    if explicit:
        return explicit
    if orcha_key := os.environ.get("ORCHA_LLM_API_KEY"):
        return orcha_key
    fallback_env = {
        "anthropic": "ANTHROPIC_API_KEY",
        "xai": "XAI_API_KEY",
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
