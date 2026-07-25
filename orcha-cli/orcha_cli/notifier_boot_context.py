"""Assemble fail-open history, provider credentials, and triage inputs for wakes."""
# ruff: noqa: BLE001, S110

from __future__ import annotations

import os
import pathlib
from typing import Any


def cold_boot_history(turns, services: Any) -> str:
    """Curate conversation history while retaining the mechanical fallback."""
    if services._format_history is None:
        return ""

    def mechanical(value):
        return services._format_history(value) or ""

    if services._curate_history is not None:
        try:
            block = services._curate_history(turns, mechanical=mechanical)
            if block:
                return block
        except Exception:
            pass
    return mechanical(turns)


def load_master_key() -> None:
    """Load the persisted local master key when the daemon did not inherit it."""
    if os.environ.get("ORCHA_SECRET_KEY"):
        return
    try:
        env_file = pathlib.Path.cwd() / ".orcha" / ".env"
        if not env_file.is_file():
            return
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line.startswith("ORCHA_SECRET_KEY="):
                value = line.split("=", 1)[1].strip().strip('"').strip("'")
                if value:
                    os.environ["ORCHA_SECRET_KEY"] = value
                return
    except Exception:
        return


def unseal_scan_key(scan: dict | None, field: str, services: Any) -> str | None:
    """Resolve a sealed wake-scan provider key, failing softly to environment keys."""
    secret_box = services._secret_box
    if secret_box is None:
        return None
    try:
        return secret_box.resolve_llm_key((scan or {}).get(field))
    except Exception:
        return None


def triage_wake(
    event_text: str,
    *,
    config: dict | None,
    api_key: str | None,
    services: Any,
) -> dict:
    """Delegate wake triage to the optional universal LLM client."""
    if services._llm_util is None:
        return {"wake": True, "reason": "llm_util unavailable — fail-open"}
    return services._llm_util.triage_wake(event_text, config=config, api_key=api_key)


def triage_config(scan: dict) -> dict | None:
    """Translate a wake-scan model override into universal-client configuration."""
    model = (scan or {}).get("triage_model")
    if isinstance(model, dict) and (model.get("provider") or model.get("model")):
        return {"triage": model}
    return None
