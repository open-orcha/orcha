"""Compatibility facade for bindings, watcher state, and session hook commands."""

from __future__ import annotations

import pathlib
import sys

from . import (
    cli_bindings,
    cli_hooks,
    cli_rehydrate,
    cli_session_hooks,
    cli_watch,
    cli_watch_state,
)

_CONV_BLOCKED_SLASH = cli_session_hooks.CONV_BLOCKED_SLASH
_CONV_BLOCKED_TOOLS = cli_session_hooks.CONV_BLOCKED_TOOLS
_CONV_INTERNAL_AGENT_TOOLS = cli_session_hooks.CONV_INTERNAL_AGENT_TOOLS
_CONV_MEMORY_DIR_RE = cli_session_hooks.CONV_MEMORY_DIR_RE

__all__ = [
    "_CONV_BLOCKED_SLASH",
    "_CONV_BLOCKED_TOOLS",
    "_CONV_INTERNAL_AGENT_TOOLS",
    "_CONV_MEMORY_DIR_RE",
    "_atomic_write_json",
    "_conv_is_memory_write",
    "_detect_tmux_target",
    "_fmt_rehydrate_brief",
    "_read_watch_state",
    "_require_any_binding",
    "_resolve_any_binding",
    "_resolve_human_agent_id",
    "_skip_managed_embodiment_hook",
    "_watch_pid_path",
    "_watch_state_path",
    "_write_hook_config",
    "cmd_conv_guard",
    "cmd_enable_hook",
    "cmd_poll_inbox",
    "cmd_reachability",
    "cmd_rehydrate",
    "cmd_unwatch",
    "cmd_watch",
]


def _services():
    """Resolve the facade in both imported and ``python -m orcha_cli`` execution."""
    return sys.modules.get("orcha_cli.__main__") or sys.modules["__main__"]


def _resolve_human_agent_id(cwd: pathlib.Path) -> str:
    return cli_bindings.resolve_human_agent_id(cwd)


def _resolve_any_binding(
    cwd: pathlib.Path, alias_override: str | None = None
) -> dict | None:
    return cli_bindings.resolve_any_binding(cwd, alias_override)


def _require_any_binding(
    cwd: pathlib.Path, alias_override: str | None, *, verb: str
) -> dict:
    return cli_bindings.require_any_binding(
        cwd, alias_override, verb=verb, services=_services()
    )


def _watch_state_path(cwd: pathlib.Path, alias: str) -> pathlib.Path:
    return cli_watch_state.watch_state_path(cwd, alias)


def _watch_pid_path(cwd: pathlib.Path, alias: str) -> pathlib.Path:
    return cli_watch_state.watch_pid_path(cwd, alias)


def _read_watch_state(cwd: pathlib.Path, alias: str) -> dict:
    return cli_watch_state.read_watch_state(cwd, alias, _services())


def _atomic_write_json(path: pathlib.Path, data: dict) -> None:
    cli_watch_state.atomic_write_json(path, data)


def _skip_managed_embodiment_hook(hook: str) -> bool:
    return cli_watch_state.skip_managed_embodiment_hook(hook)


def cmd_watch(args) -> None:
    cli_watch.cmd_watch(args, _services())


def cmd_unwatch(args) -> None:
    cli_watch.cmd_unwatch(args)


def _detect_tmux_target() -> str | None:
    return cli_hooks.detect_tmux_target()


def cmd_reachability(args) -> None:
    cli_hooks.record_reachability(args, _services())


def _write_hook_config(claude_dir: pathlib.Path) -> bool:
    return cli_hooks.write_hook_config(claude_dir)


def cmd_enable_hook(_) -> None:
    cli_hooks.enable_hooks(_services())


def cmd_poll_inbox(args) -> None:
    cli_session_hooks.poll_inbox(args, _services())


def _conv_is_memory_write(tool_input: dict) -> bool:
    return cli_session_hooks.is_memory_write(tool_input)


def cmd_conv_guard(_) -> None:
    cli_session_hooks.conversation_guard(_services())


def _fmt_rehydrate_brief(brief: dict) -> str:
    return cli_rehydrate.format_brief(brief)


def cmd_rehydrate(args) -> None:
    cli_rehydrate.rehydrate(args, _services())
