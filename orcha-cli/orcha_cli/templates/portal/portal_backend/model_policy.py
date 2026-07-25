"""Define supported worker models and resolve persisted runtime preferences."""

from typing import Optional

AVAILABLE_MODELS = [
    {"id": "claude-opus-5", "name": "Opus 5", "runtime": "claude"},
    {"id": "claude-fable-5", "name": "Fable 5", "runtime": "claude"},
    {"id": "claude-sonnet-5", "name": "Sonnet 5", "runtime": "claude"},
    {"id": "claude-haiku-4-5-20251001", "name": "Haiku 4.5", "runtime": "claude"},
    {"id": "gpt-5.6-sol", "name": "GPT-5.6 Sol", "runtime": "codex"},
    {"id": "gpt-5.6-terra", "name": "GPT-5.6 Terra", "runtime": "codex"},
    {"id": "gpt-5.6-luna", "name": "GPT-5.6 Luna", "runtime": "codex"},
    {"id": "gpt-5.5", "name": "GPT-5.5", "runtime": "codex"},
    {"id": "gpt-5.4", "name": "GPT-5.4", "runtime": "codex"},
    {"id": "gpt-5.4-mini", "name": "GPT-5.4 mini", "runtime": "codex"},
    {"id": "gpt-5.3-codex-spark", "name": "GPT-5.3 Codex Spark", "runtime": "codex"},
]
DEFAULT_MODEL = "claude-opus-5"
MODEL_IDS = {model["id"] for model in AVAILABLE_MODELS}
MODELS_BY_ID = {model["id"]: model for model in AVAILABLE_MODELS}

AVAILABLE_REASONING_EFFORTS = [
    {"id": "low", "name": "Low"},
    {"id": "medium", "name": "Medium"},
    {"id": "high", "name": "High"},
    {"id": "xhigh", "name": "Extra-high"},
]
DEFAULT_REASONING_EFFORT = "medium"
REASONING_EFFORT_IDS = {effort["id"] for effort in AVAILABLE_REASONING_EFFORTS}


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


def resolve_reasoning_effort(effort: Optional[str]) -> Optional[str]:
    """Return a supported effort while preserving an unset preference."""
    if effort is None:
        return None
    return effort if effort in REASONING_EFFORT_IDS else DEFAULT_REASONING_EFFORT
