"""orcha_cli.notifier.config — runtime resolution, project config, and HTTP helpers.

Leaf module with no dependency on the rest of the notifier package: it resolves
the worker runtime (claude vs. codex) and its executable, loads the project's
``.claude/orcha.json`` to derive the API base + container id, and wraps the tiny
GET/POST JSON helpers (plus the container-probe used to refuse a misbound daemon).
Extracted verbatim from ``notifier.py`` (issue #29) and re-exported from the
package ``__init__`` so ``orcha_cli.notifier.<name>`` keeps working unchanged.
"""
from __future__ import annotations

import json
import os
import pathlib
import shutil
import sys
import urllib.error
import urllib.request
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


def _resolve_runtime_executable(runtime: Optional[str]) -> Optional[str]:
    runtime = _normalize_runtime(runtime)
    leaf = _runtime_executable(runtime)
    override = _executable_override(ORCHA_CODEX_EXEC if runtime == RUNTIME_CODEX else ORCHA_CLAUDE_EXEC)
    if override:
        return override
    if shutil.which(leaf):
        return leaf
    if runtime == RUNTIME_CODEX:
        for candidate in _CODEX_EXEC_FALLBACKS:
            p = pathlib.Path(candidate).expanduser()
            if p.is_file() and os.access(p, os.X_OK):
                return str(p)
    return None


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


def _load_config(cwd: pathlib.Path) -> dict:
    cfg = cwd / ".claude" / "orcha.json"
    if not cfg.exists():
        sys.exit(
            "error: no .claude/orcha.json in CWD. Run the notifier from the project "
            "root (where `orcha init`/`orcha connect` was run)."
        )
    return json.loads(cfg.read_text())


def _api_and_cid(cwd: pathlib.Path, api_override: Optional[str],
                 cid_override: Optional[str]) -> tuple[str, str]:
    # Both overrides supplied → don't require a project config file (lets the
    # daemon run from anywhere, e.g. a systemd unit or the demo harness).
    if api_override and cid_override:
        return api_override.rstrip("/"), cid_override
    cfg = _load_config(cwd)
    api_base = (api_override or cfg.get("api_base_url") or "").rstrip("/")
    cid = cid_override or cfg.get("current_container_id")
    if not api_base:
        sys.exit("error: api_base_url missing from .claude/orcha.json")
    if not cid:
        sys.exit("error: no container_id — pass --container or set current_container_id "
                 "in .claude/orcha.json (run /orcha-container).")
    return api_base, cid


def _get_json(url: str, timeout: float = 8.0) -> Optional[dict]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return json.loads(resp.read())
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError):
        return None


def _probe_container(api_base: str, cid: str) -> str:
    """Does this API actually know this container? 'ok' | 'missing' (definitive HTTP 404)
    | 'unreachable' (API down/booting). _get_json can't distinguish a 404 from a dead API —
    this can, and ONLY a definitive 404 should make the daemon refuse to start.

    Why it matters: a daemon bound to a container its API doesn't know is a permanent no-op
    that still LOOKS alive in ps. The 2026-06-10 postmortem found stale orcha.json files
    pointing at OTHER projects' API ports after a stack reshuffle — those daemons would idle
    forever, deepening the which-daemon-is-which confusion during an incident."""
    url = f"{api_base}/api/containers/{cid}/wake-scan?cooldown=15&min_idle=30"
    try:
        with urllib.request.urlopen(url, timeout=8.0) as resp:
            resp.read()
        return "ok"
    except urllib.error.HTTPError as e:
        # 404 = the API answered and doesn't know the container. Any other HTTP error
        # means the API is alive — not grounds to refuse.
        return "missing" if e.code == 404 else "ok"
    except (urllib.error.URLError, ValueError, OSError):
        return "unreachable"


def _post_json(url: str, body: dict, timeout: float = 8.0) -> Optional[dict]:
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError):
        return None
