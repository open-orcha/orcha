"""Compatibility facade for live sessions, exit hooks, and lifecycle commands."""

from __future__ import annotations

import pathlib
import sys

from . import (
    cli_claim_guard,
    cli_lifecycle,
    cli_live,
    cli_snapshot,
    cli_transcript,
)

RUNTIME_CLAUDE = cli_live.RUNTIME_CLAUDE
RUNTIME_CODEX = cli_live.RUNTIME_CODEX
ORCHA_CLAUDE_EXEC = cli_live.ORCHA_CLAUDE_EXEC
ORCHA_CODEX_EXEC = cli_live.ORCHA_CODEX_EXEC
_CODEX_EXEC_FALLBACKS = cli_live.CODEX_EXEC_FALLBACKS

__all__ = [
    "ORCHA_CLAUDE_EXEC",
    "ORCHA_CODEX_EXEC",
    "RUNTIME_CLAUDE",
    "RUNTIME_CODEX",
    "_CODEX_EXEC_FALLBACKS",
    "_build_live_argv",
    "_exec_live_session",
    "_executable_override",
    "_extract_claimed_task_ids",
    "_focus_from_transcript",
    "_iter_transcript_records",
    "_last_assistant_text_full",
    "_lifecycle_call",
    "_live_agent_launch",
    "_live_agent_model",
    "_live_boot_prefix",
    "_normalize_runtime",
    "_parse_self_wake_delay",
    "_read_hook_stdin",
    "_read_project_api_base",
    "_resolve_runtime_executable",
    "_rich_digest_posted_this_session",
    "_runtime_executable",
    "_self_wake_request",
    "cmd_pause",
    "cmd_resume",
    "cmd_self_wake",
    "cmd_snapshot",
    "cmd_stop",
    "cmd_task_claim_guard",
    "cmd_terminal_bridge",
    "cmd_use",
]


def _services():
    return sys.modules["orcha_cli.__main__"]


def _live_boot_prefix(api_base: str | None, agent_id: str | None) -> str | None:
    return cli_live.live_boot_prefix(api_base, agent_id, get_json=_services()._get_json)


def _normalize_runtime(runtime: str | None, model: str | None = None) -> str:
    return cli_live.normalize_runtime(runtime, model)


def _executable_override(env_var: str) -> str | None:
    return cli_live.executable_override(env_var)


def _runtime_executable(runtime: str | None) -> str:
    return cli_live.runtime_executable(runtime)


def _resolve_runtime_executable(runtime: str | None) -> str | None:
    return cli_live.resolve_runtime_executable(
        runtime, fallbacks=_services()._CODEX_EXEC_FALLBACKS
    )


def _build_live_argv(
    cold: bool,
    resume_sid: str | None,
    boot_prefix: str | None,
    model: str | None = None,
    runtime: str | None = None,
) -> list:
    return cli_live.build_live_argv(cold, resume_sid, boot_prefix, model, runtime)


def _live_agent_launch(
    api_base: str | None, agent_id: str | None
) -> tuple[str | None, str]:
    return cli_live.live_agent_launch(
        api_base, agent_id, get_json=_services()._get_json
    )


def _live_agent_model(api_base: str | None, agent_id: str | None) -> str | None:
    return _live_agent_launch(api_base, agent_id)[0]


def _exec_live_session(
    cwd: pathlib.Path, alias: str, binding_file: pathlib.Path
) -> None:
    cli_live.exec_live_session(
        cwd,
        alias,
        binding_file,
        boot_prefix=_services()._live_boot_prefix,
        agent_launch=_services()._live_agent_launch,
        build_argv=_services()._build_live_argv,
        resolve_executable=_services()._resolve_runtime_executable,
        runtime_leaf=_services()._runtime_executable,
        normalize=_services()._normalize_runtime,
    )


def cmd_use(args) -> None:
    cli_live.use_command(args, exec_session=_services()._exec_live_session)


def cmd_terminal_bridge(args) -> None:
    from .cli_bridge import terminal_bridge_command

    terminal_bridge_command(args)


def _read_hook_stdin() -> dict:
    return cli_transcript.read_hook_input(sys.stdin)


def _iter_transcript_records(transcript_path: str | None):
    yield from cli_transcript.iter_records(transcript_path)


def _rich_digest_posted_this_session(
    transcript_path: str | None, agent_id: str
) -> bool:
    return cli_transcript.rich_digest_posted(transcript_path, agent_id)


def _last_assistant_text_full(transcript_path: str | None) -> str | None:
    return cli_transcript.last_assistant_text(transcript_path)


def _focus_from_transcript(transcript_path: str | None) -> str | None:
    return cli_transcript.focus_from_transcript(transcript_path)


def _extract_claimed_task_ids(text: str | None) -> list:
    return cli_claim_guard.extract_claimed_task_ids(text)


def cmd_task_claim_guard(args) -> None:
    cli_claim_guard.task_claim_guard(args, _services())


def cmd_snapshot(args) -> None:
    cli_snapshot.snapshot_command(args, _services())


_parse_self_wake_delay = cli_lifecycle.parse_self_wake_delay
_read_project_api_base = cli_lifecycle.read_project_api_base
_self_wake_request = cli_lifecycle.self_wake_request


def cmd_self_wake(args) -> None:
    cli_lifecycle.self_wake_command(
        args,
        require_binding=_services()._require_any_binding,
        parse_delay=_services()._parse_self_wake_delay,
        read_api_base=_services()._read_project_api_base,
        request=_services()._self_wake_request,
    )


def _lifecycle_call(container_id: str | None, new_status: str, verb: str) -> None:
    cli_lifecycle.lifecycle_call(
        container_id,
        new_status,
        verb,
        resolve_human_agent_id=_services()._resolve_human_agent_id,
    )


def cmd_pause(args) -> None:
    _services()._lifecycle_call(args.container_id, "paused", "pause")


def cmd_resume(args) -> None:
    _services()._lifecycle_call(args.container_id, "active", "resume")


def cmd_stop(args) -> None:
    status = "cancelled" if args.cancel else "completed"
    _services()._lifecycle_call(args.container_id, status, "stop")
