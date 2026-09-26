"""Assemble the public ``orcha`` command line from focused command modules."""
# ruff: noqa: F401

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _pkg_version

from .cli_env import _append_env_file, _read_env_file_value, _tighten_env_file
from .cli_hook_facade import *
from .cli_http import _get_json, _post_json, _put_json, _wait_for_portal
from .cli_project_facade import *
from .cli_runtime_facade import *
from .cli_text import (
    _codex_skill_body,
    _frontmatter_value,
    _sanitize_name,
    _strip_frontmatter,
)
from .notifier import cmd_notifier, stop_daemon_for_container


def _resolve_bridge_port(api_base: str) -> int | None:
    """Resolve through this public module so legacy monkeypatch seams still work."""
    from . import cli_connect

    return cli_connect.resolve_bridge_port(api_base, get_json=_get_json)


def cmd_connect(args) -> None:
    """Connect using dependencies exposed by this public compatibility module."""
    from . import cli_connect

    cli_connect.connect_command(
        args,
        sanitize_name=_sanitize_name,
        discover_stacks=_discover_stacks,
        wait_for_portal=_wait_for_portal,
        get_json=_get_json,
        resolve_port=_resolve_bridge_port,
        install_skill_templates=_install_orcha_skill_templates,
        write_hook_config=_write_hook_config,
        post_json=_post_json,
    )


def _cli_version() -> str:
    """Return installed distribution metadata or a source-tree sentinel."""
    try:
        return _pkg_version("orcha-cli")
    except PackageNotFoundError:
        return "0.0.0+source"


def build_parser() -> argparse.ArgumentParser:
    """Build the public parser while keeping handler objects patchable here."""
    from .cli_parser import build_parser as assemble_parser

    handlers = {
        "init": cmd_init,
        "up": cmd_up,
        "down": cmd_down,
        "migrate": cmd_migrate,
        "upgrade": cmd_upgrade,
        "update": cmd_update,
        "status": cmd_status,
        "ls": cmd_ls,
        "connect": cmd_connect,
        "poll-inbox": cmd_poll_inbox,
        "conv-guard": cmd_conv_guard,
        "watch": cmd_watch,
        "unwatch": cmd_unwatch,
        "rehydrate": cmd_rehydrate,
        "use": cmd_use,
        "snapshot": cmd_snapshot,
        "task-claim-guard": cmd_task_claim_guard,
        "self-wake": cmd_self_wake,
        "reachability": cmd_reachability,
        "enable-hook": cmd_enable_hook,
        "notifier": cmd_notifier,
        "terminal-bridge": cmd_terminal_bridge,
        "sandbox": cmd_sandbox,
        "pause": cmd_pause,
        "resume": cmd_resume,
        "stop": cmd_stop,
    }
    return assemble_parser(_cli_version(), handlers)


def main() -> None:
    """Parse one CLI invocation and dispatch it to the selected command."""
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
