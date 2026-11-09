"""Give a project's agents the QA tools (`orcha qa mcp`) when the project turned QA on.

`orcha qa enable` writes `<root>/.orcha/qa/mcp.json` (an MCP config naming the `orcha` executable
that ran it). Worker launches (notifier_headless, notifier_resident_spawn) call `claude_flags` /
`codex_flags` with their cwd: a worktree resolves to its main checkout, so every worker of the
project gets the same server. No file, no flags: QA stays off and launches are unchanged.
Sandboxed workers never get it (a container cannot reach the host's simulators).
"""

from __future__ import annotations

import json
import os
import pathlib
import shutil
import sys
from typing import Optional

SERVER_NAME = "orcha-qa"
#: `start_session` waits in line for a device and the drafting tools wait for news, longer than
#: Codex's 60-second default for one tool call.
CODEX_TOOL_TIMEOUT_S = 300
CONFIG_REL = pathlib.Path(".orcha") / "qa" / "mcp.json"


def project_root(cwd: str | pathlib.Path) -> pathlib.Path:
    from orcha_cli.sandbox import workspace_root_for

    return workspace_root_for(cwd)


def config_path(cwd: str | pathlib.Path) -> Optional[pathlib.Path]:
    """The project's QA MCP config, or None when QA is off for it."""
    try:
        path = project_root(cwd) / CONFIG_REL
        return path if path.is_file() else None
    except OSError:
        return None


def orcha_executable() -> str:
    """The `orcha` that should serve the tools: the one on PATH, else this interpreter's."""
    found = shutil.which("orcha")
    if found:
        return found
    candidate = pathlib.Path(sys.executable).with_name("orcha")
    return str(candidate) if candidate.exists() else "orcha"


def server_entry() -> dict:
    return {"command": orcha_executable(), "args": ["qa", "mcp"]}


def enable(root: str | pathlib.Path) -> pathlib.Path:
    """Turn QA on for the project at `root`: write the MCP config workers launch with."""
    path = pathlib.Path(root) / CONFIG_REL
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"mcpServers": {SERVER_NAME: server_entry()}}, indent=2) + "\n")
    return path


def disable(root: str | pathlib.Path) -> bool:
    path = pathlib.Path(root) / CONFIG_REL
    try:
        path.unlink()
        return True
    except FileNotFoundError:
        return False


def _entry(path: pathlib.Path) -> Optional[dict]:
    try:
        entry = json.loads(path.read_text())["mcpServers"][SERVER_NAME]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return entry if isinstance(entry, dict) and entry.get("command") else None


def claude_flags(cwd: str | pathlib.Path, *, sandboxed: bool = False) -> list[str]:
    """`--mcp-config <file>` for a Claude worker of a project with QA on; [] otherwise."""
    if sandboxed or os.environ.get("ORCHA_QA_TOOLS") == "off":
        return []
    path = config_path(cwd)
    return ["--mcp-config", str(path)] if path and _entry(path) else []


def codex_flags(cwd: str | pathlib.Path, *, sandboxed: bool = False) -> list[str]:
    """`-c mcp_servers.orcha-qa.*` overrides for a Codex worker of a project with QA on."""
    if sandboxed or os.environ.get("ORCHA_QA_TOOLS") == "off":
        return []
    path = config_path(cwd)
    entry = _entry(path) if path else None
    if not entry:
        return []
    key = f"mcp_servers.{SERVER_NAME}"
    return [
        "-c", f"{key}.command={json.dumps(entry['command'])}",
        "-c", f"{key}.args={json.dumps(list(entry.get('args') or []))}",
        "-c", f"{key}.tool_timeout_sec={CODEX_TOOL_TIMEOUT_S}",
    ]
