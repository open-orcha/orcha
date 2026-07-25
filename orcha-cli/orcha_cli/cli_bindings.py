"""Resolve local human and AI agent bindings for CLI commands and hooks."""
from __future__ import annotations

import json
import os
import pathlib
import sys
from typing import Optional

def resolve_human_agent_id(cwd: pathlib.Path) -> str:
    """Find the acting human's agent_id for human-only CLI calls (pause/resume/stop).

    Order matches the skills' 4-step resolution, minus the AskUserQuestion fallback
    (the CLI is non-interactive):
      1. $ORCHA_ALIAS → .claude/orcha-tabs/<alias>.json
      2. Single binding file in .claude/orcha-tabs/ if exactly one exists
    Anything else → exit with a clear message.
    """
    tabs_dir = cwd / ".claude" / "orcha-tabs"

    env_alias = (os.environ.get("ORCHA_ALIAS") or "").strip()
    if env_alias:
        f = tabs_dir / f"{env_alias}.json"
        if not f.exists():
            sys.exit(
                f"error: $ORCHA_ALIAS='{env_alias}' but {f} doesn't exist. "
                f"Register first via `orcha init --as {env_alias}` or `/orcha-register-human {env_alias}`."
            )
        return json.loads(f.read_text())["agent_id"]

    if tabs_dir.exists():
        bindings = sorted(tabs_dir.glob("*.json"))
        if len(bindings) == 1:
            return json.loads(bindings[0].read_text())["agent_id"]
        if len(bindings) > 1:
            names = ", ".join(b.stem for b in bindings)
            sys.exit(
                f"error: multiple bindings in {tabs_dir} ({names}). "
                f"Set ORCHA_ALIAS=<name> in your shell to pick which human is acting."
            )

    sys.exit(
        "error: no human binding found. Run `orcha init --as <YourName>` first, "
        "or set $ORCHA_ALIAS to a registered human alias."
    )


def resolve_any_binding(cwd: pathlib.Path, alias_override: Optional[str] = None) -> Optional[dict]:
    """Find ANY binding (ai or human) for hook-friendly polling.

    Returns the binding dict {alias, agent_id, container_id, kind?} or None.
    Order: explicit alias arg → $ORCHA_ALIAS → single binding. **Never raises.**
    A hook running in a session that isn't an Orcha project must be a silent
    no-op; raising would break unrelated Claude work.
    """
    tabs_dir = cwd / ".claude" / "orcha-tabs"
    if not tabs_dir.exists():
        return None

    pick = (alias_override or os.environ.get("ORCHA_ALIAS") or "").strip()
    if pick:
        f = tabs_dir / f"{pick}.json"
        if not f.exists():
            return None
        try:
            return json.loads(f.read_text())
        except Exception:
            return None

    bindings = sorted(tabs_dir.glob("*.json"))
    if len(bindings) != 1:
        return None
    try:
        return json.loads(bindings[0].read_text())
    except Exception:
        return None


def require_any_binding(cwd: pathlib.Path, alias_override: Optional[str], *, verb: str, services) -> dict:
    binding = services._resolve_any_binding(cwd, alias_override)
    if binding and binding.get("agent_id"):
        return binding
    pick = (alias_override or os.environ.get("ORCHA_ALIAS") or "").strip()
    if pick:
        sys.exit(
            f"error: no binding for alias '{pick}' in .claude/orcha-tabs/. "
            f"Register first, or set ORCHA_ALIAS to the agent running `{verb}`."
        )
    sys.exit(
        f"error: no agent binding found for `{verb}`. Set ORCHA_ALIAS or pass --alias."
    )
