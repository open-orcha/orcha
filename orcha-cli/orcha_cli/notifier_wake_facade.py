"""Preserve notifier wake, persona, and transport compatibility entry points."""

from __future__ import annotations

import sys
from typing import Optional

from . import notifier_boot_context as _boot_context
from . import notifier_headless as _headless
from . import notifier_persona_cache as _persona_cache
from . import notifier_resident_spawn as _resident_spawn
from . import notifier_runtime as _runtime
from . import notifier_wake_actions as _wake_actions
from . import notifier_wake_decisions as _wake_decisions


def _compat():
    """Return the public facade so test and caller patch points remain late-bound."""
    return sys.modules["orcha_cli.notifier"]


def _cold_boot_history(turns) -> str:
    return _boot_context.cold_boot_history(turns, _compat())


def _load_master_key_from_env_file() -> None:
    _boot_context.load_master_key()


def _unseal_scan_key(scan: Optional[dict], field: str) -> Optional[str]:
    return _boot_context.unseal_scan_key(scan, field, _compat())


def _triage_wake(
    event_text: str,
    *,
    config: Optional[dict] = None,
    api_key: Optional[str] = None,
) -> dict:
    return _boot_context.triage_wake(
        event_text,
        config=config,
        api_key=api_key,
        services=_compat(),
    )


def _triage_config_from_scan(scan: dict) -> Optional[dict]:
    return _boot_context.triage_config(scan)


def decide_wake_suppression(cand, *, triage_fn=_triage_wake):
    return _wake_decisions.decide_wake_suppression(cand, triage_fn=triage_fn)


def decide_wake_tier(cand, *, triage_fn=_triage_wake):
    return _wake_decisions.decide_wake_tier(cand, triage_fn=triage_fn)


def _ack_config_from_scan(scan: dict) -> Optional[dict]:
    return _wake_actions.ack_config_from_scan(scan)


def _log_graded_wake(verdict: dict, autonomy_level, acted: bool) -> None:
    _wake_actions.log_graded_wake(verdict, autonomy_level, acted)


def _advance_wake_cursor(api_base: str, cand: dict, event) -> None:
    _wake_actions.advance_wake_cursor(
        api_base, cand, event, post_json=_compat()._post_json
    )


def _request_actionable(api_base: str, rid: str) -> Optional[bool]:
    return _wake_actions.request_actionable(
        api_base, rid, get_json=_compat()._get_json
    )


def _apply_wake_act(
    api_base: str,
    cand: dict,
    event,
    verdict: dict,
    *,
    quiet: bool,
    ack_config: Optional[dict] = None,
    ack_api_key: Optional[str] = None,
) -> bool:
    compat = _compat()
    return _wake_actions.apply_wake_act(
        api_base,
        cand,
        event,
        verdict,
        quiet=quiet,
        llm_util=compat._llm_util,
        get_json=compat._get_json,
        post_json=compat._post_json,
        ack_config=ack_config,
        ack_api_key=ack_api_key,
    )


def _suppress_wake(
    api_base: str, cand: dict, event, suppress: dict, *, quiet: bool
) -> None:
    _wake_actions.suppress_wake(
        api_base,
        cand,
        event,
        suppress,
        quiet=quiet,
        post_json=_compat()._post_json,
    )


def _resolve_runtime_executable(runtime: Optional[str]) -> Optional[str]:
    return _runtime._resolve_runtime_executable(
        runtime, fallbacks=_compat()._CODEX_EXEC_FALLBACKS
    )


def _container_vanished(api_base: str, cid: str) -> bool:
    """Return true only when the live API definitively no longer knows the container."""
    return _compat()._probe_container(api_base, cid) == "missing"


def _clear_persona_cache() -> None:
    _compat()._PERSONA_CACHE.clear()


def _persona_and_digest(
    api_base: str, agent_id: str, *, force_fresh: bool = False
) -> tuple[Optional[dict], Optional[dict]]:
    return _persona_cache.persona_and_digest(
        api_base,
        agent_id,
        force_fresh=force_fresh,
        services=_compat(),
    )


def _build_persona(
    api_base: str,
    agent_id: str,
    *,
    task_id: Optional[str] = None,
    force_fresh: bool = False,
    lane: str = "work",
    self_wake: Optional[dict] = None,
    return_resume_rendered: bool = False,
):
    return _persona_cache.build_persona(
        api_base,
        agent_id,
        task_id=task_id,
        force_fresh=force_fresh,
        lane=lane,
        self_wake=self_wake,
        return_resume_rendered=return_resume_rendered,
        services=_compat(),
    )


def spawn_headless(cwd: str, prompt: str, flags: Optional[str], dry_run: bool, **kwargs):
    """Launch a one-shot coding-agent worker through the patchable facade."""
    return _headless.spawn_headless(
        cwd,
        prompt,
        flags,
        dry_run,
        services=_compat(),
        **kwargs,
    )


def spawn_resident(cwd: str, **kwargs):
    """Launch a warm conversation worker through the patchable facade."""
    return _resident_spawn.spawn_resident(
        cwd, services=_compat(), **kwargs
    )


def select_transport(cand: dict) -> str:
    """Choose the reachable host transport for a wake candidate."""
    compat = _compat()
    if cand.get("tmux_target") and compat.tmux_pane_live(cand["tmux_target"]):
        return "tmux"
    if cand.get("headless_cwd"):
        return "ephemeral"
    return "unreachable"


def derive_wake_event(cand: dict) -> Optional[str]:
    """Derive the single wake label using the established precedence."""
    return (
        cand.get("latest_event")
        or ("auto_start" if cand.get("auto_start_task_ids") else None)
        or ("self_wake" if cand.get("self_wake_due") else None)
        or ("auto_wake" if cand.get("auto_wake_due") else None)
    )


def self_wake_ack_fields(
    cand: dict, *, kind: str, sent: bool, resume_rendered: bool
) -> dict:
    """Consume a self-wake only after its rendered headless delivery."""
    if (
        sent
        and kind == "ephemeral"
        and cand.get("self_wake_injected")
        and resume_rendered
        and cand.get("self_wake_task_id")
    ):
        return {
            "clear_self_wake": True,
            "self_wake_task_id": cand["self_wake_task_id"],
        }
    return {}
