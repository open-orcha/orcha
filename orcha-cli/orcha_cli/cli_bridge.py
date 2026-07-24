"""Run or ensure the host websocket bridge used by embedded live terminals."""

from __future__ import annotations

import asyncio
import json
import pathlib
import sys


def _project_bridge_config(cwd: pathlib.Path) -> tuple[object, object]:
    """Read the optional API base and bridge port from project configuration."""
    config_path = cwd / ".claude" / "orcha.json"
    if not config_path.exists():
        return None, None
    try:
        config = json.loads(config_path.read_text())
        return config.get("api_base_url"), config.get("bridge_port")
    except (OSError, ValueError):
        return None, None


def terminal_bridge_command(args) -> None:
    """Ensure the singleton bridge or serve it in the foreground."""
    from orcha_cli import terminal_bridge

    cwd = pathlib.Path.cwd()
    if getattr(args, "ensure", False):
        terminal_bridge.ensure_bridge(cwd, quiet=args.quiet)
        return
    configured_api, configured_port = _project_bridge_config(cwd)
    api_base = args.api_base or configured_api
    if not api_base:
        sys.exit(
            "error: no api_base_url — pass --api-base or run from a project "
            "with .claude/orcha.json"
        )
    host = args.host or terminal_bridge.BRIDGE_HOST
    port = args.port or configured_port or terminal_bridge.BRIDGE_PORT
    try:
        asyncio.run(
            terminal_bridge.serve_bridge(
                api_base, str(cwd), host=host, port=port, quiet=args.quiet
            )
        )
    except KeyboardInterrupt:
        pass
