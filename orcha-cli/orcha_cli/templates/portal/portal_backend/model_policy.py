"""Define supported worker models and resolve persisted runtime preferences."""

from typing import Optional

_STANDARD_EFFORTS = ["low", "medium", "high", "xhigh"]
_MAX_EFFORTS = [*_STANDARD_EFFORTS, "max"]
_ULTRA_EFFORTS = [*_MAX_EFFORTS, "ultra"]

AVAILABLE_MODELS = [
    {
        "id": "claude-fable-5-1",
        "name": "Fable 5.1",
        "runtime": "claude",
        "reasoning_efforts": _MAX_EFFORTS,
    },
    {
        "id": "claude-opus-5",
        "name": "Opus 5",
        "runtime": "claude",
        "reasoning_efforts": _MAX_EFFORTS,
    },
    {
        "id": "claude-fable-5",
        "name": "Fable 5",
        "runtime": "claude",
        "reasoning_efforts": _MAX_EFFORTS,
    },
    {
        "id": "claude-sonnet-5",
        "name": "Sonnet 5",
        "runtime": "claude",
        "reasoning_efforts": _MAX_EFFORTS,
    },
    {
        "id": "claude-haiku-4-5-20251001",
        "name": "Haiku 4.5",
        "runtime": "claude",
        "reasoning_efforts": [],
    },
    {
        "id": "gpt-6-astra",
        "name": "GPT-6 Astra",
        "runtime": "codex",
        "reasoning_efforts": _MAX_EFFORTS,
    },
    {
        "id": "gpt-5.6-sol",
        "name": "GPT-5.6 Sol",
        "runtime": "codex",
        "reasoning_efforts": _ULTRA_EFFORTS,
    },
    {
        "id": "gpt-5.6-terra",
        "name": "GPT-5.6 Terra",
        "runtime": "codex",
        "reasoning_efforts": _ULTRA_EFFORTS,
    },
    {
        "id": "gpt-5.6-luna",
        "name": "GPT-5.6 Luna",
        "runtime": "codex",
        "reasoning_efforts": _MAX_EFFORTS,
    },
    {
        "id": "gpt-5.5",
        "name": "GPT-5.5",
        "runtime": "codex",
        "reasoning_efforts": _STANDARD_EFFORTS,
    },
    {
        "id": "gpt-5.4",
        "name": "GPT-5.4",
        "runtime": "codex",
        "reasoning_efforts": _STANDARD_EFFORTS,
    },
    {
        "id": "gpt-5.4-mini",
        "name": "GPT-5.4 mini",
        "runtime": "codex",
        "reasoning_efforts": _STANDARD_EFFORTS,
    },
    {
        "id": "gpt-5.3-codex-spark",
        "name": "GPT-5.3 Codex Spark",
        "runtime": "codex",
        "reasoning_efforts": _STANDARD_EFFORTS,
    },
]
DEFAULT_MODEL = "claude-opus-5"
MODEL_IDS = {model["id"] for model in AVAILABLE_MODELS}
MODELS_BY_ID = {model["id"]: model for model in AVAILABLE_MODELS}

AVAILABLE_REASONING_EFFORTS = [
    {"id": "low", "name": "Low"},
    {"id": "medium", "name": "Medium"},
    {"id": "high", "name": "High"},
    {"id": "xhigh", "name": "Extra-high"},
    {"id": "max", "name": "Maximum"},
    {"id": "ultra", "name": "Ultra"},
]
DEFAULT_REASONING_EFFORT = "medium"
REASONING_EFFORT_IDS = {effort["id"] for effort in AVAILABLE_REASONING_EFFORTS}
REASONING_EFFORT_IDS_BY_MODEL = {
    model["id"]: set(model["reasoning_efforts"]) for model in AVAILABLE_MODELS
}


def resolve_model(model: Optional[str], supported: set[str] = MODEL_IDS) -> str:
    """Return a supported model, falling back without mutating persisted state."""
    return model if model in supported else DEFAULT_MODEL


def resolve_model_runtime(
    model: Optional[str],
    supported: set[str] = MODEL_IDS,
) -> str:
    """Return the local worker runtime for a supported persisted model."""
    resolved = resolve_model(model, supported)
    return MODELS_BY_ID.get(resolved, {}).get("runtime", "claude")


def reasoning_efforts_for_model(model: Optional[str]) -> set[str]:
    """Return the exact effort ids supported by a curated worker model."""
    resolved = resolve_model(model)
    return REASONING_EFFORT_IDS_BY_MODEL.get(resolved, set())


def resolve_reasoning_effort(
    effort: Optional[str], model: Optional[str] = None
) -> Optional[str]:
    """Return a model-compatible effort while preserving an unset preference."""
    if effort is None:
        return None
    if model is None:
        return effort if effort in REASONING_EFFORT_IDS else DEFAULT_REASONING_EFFORT
    supported = reasoning_efforts_for_model(model)
    if effort in supported:
        return effort
    return DEFAULT_REASONING_EFFORT if DEFAULT_REASONING_EFFORT in supported else None
