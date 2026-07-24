"""Resolve host runtime executables, prompts, and compatible command-line flags."""

from __future__ import annotations

import os
import pathlib
import shutil
from typing import Optional

RUNTIME_CLAUDE = "claude"
RUNTIME_CODEX = "codex"
ORCHA_CLAUDE_EXEC = "ORCHA_CLAUDE_EXEC"
ORCHA_CODEX_EXEC = "ORCHA_CODEX_EXEC"
_CODEX_EXEC_FALLBACKS = (
    "/Applications/Codex.app/Contents/Resources/codex",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "~/.local/bin/codex",
)
# GH #51: Codex reasoning-effort tiers don't include 'xhigh' — fold it into 'high'. Others pass through.
_CODEX_EFFORT = {"low": "low", "medium": "medium", "high": "high", "xhigh": "high"}


def _normalize_runtime(runtime: Optional[str]) -> str:
    return RUNTIME_CODEX if runtime == RUNTIME_CODEX else RUNTIME_CLAUDE


def _runtime_executable(runtime: Optional[str]) -> str:
    return "codex" if _normalize_runtime(runtime) == RUNTIME_CODEX else "claude"


def _executable_override(env_var: str) -> Optional[str]:
    override = os.environ.get(env_var)
    if not override:
        return None
    if shutil.which(override):
        return override
    p = pathlib.Path(override).expanduser()
    return str(p) if p.is_file() and os.access(p, os.X_OK) else None


def _resolve_runtime_executable(
    runtime: Optional[str],
    fallbacks: Optional[tuple[str, ...]] = None,
) -> Optional[str]:
    runtime = _normalize_runtime(runtime)
    leaf = _runtime_executable(runtime)
    override = _executable_override(ORCHA_CODEX_EXEC if runtime == RUNTIME_CODEX else ORCHA_CLAUDE_EXEC)
    if override:
        return override
    if shutil.which(leaf):
        return leaf
    if runtime == RUNTIME_CODEX:
        for candidate in fallbacks or _CODEX_EXEC_FALLBACKS:
            p = pathlib.Path(candidate).expanduser()
            if p.is_file() and os.access(p, os.X_OK):
                return str(p)
    return None


def _codex_prompt(prompt: str, system_prompt: Optional[str]) -> str:
    if not system_prompt:
        return prompt
    return f"{system_prompt.strip()}\n\n## Orcha Wake Instruction\n{prompt}"


def _runtime_extra_flags(runtime: Optional[str], flags: Optional[str]) -> list[str]:
    """Carry user-supplied headless flags, dropping Claude-only permission flags for Codex."""
    extra = flags.split() if flags else []
    if _normalize_runtime(runtime) != RUNTIME_CODEX:
        return extra
    filtered: list[str] = []
    skip_next = False
    for flag in extra:
        if skip_next:
            skip_next = False
            continue
        if flag == "--dangerously-skip-permissions":
            continue
        if flag == "--permission-mode":
            skip_next = True
            continue
        if flag.startswith("--permission-mode="):
            continue
        filtered.append(flag)
    return filtered
