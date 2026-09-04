"""Preserve notifier embodiment and Git-worktree compatibility entry points."""

from __future__ import annotations

import sys
from typing import Optional

from . import notifier_embodiment as _embodiment
from . import notifier_worktree_base as _worktree_base
from . import notifier_worktree_cleanup as _cleanup
from . import notifier_worktree_stable as _worktree_stable


def _compat():
    return sys.modules["orcha_cli.notifier"]


def _mint_embodiment_token(
    api_base: str, aid: str, lane: str, kind: str
) -> Optional[str]:
    return _embodiment.mint_token(
        api_base, aid, lane, kind, post_json=_compat()._post_json
    )


def _revoke_embodiment_token(api_base: str, token: Optional[str]) -> bool:
    return _embodiment.revoke_token(
        api_base, token, post_json=_compat()._post_json
    )


def _revoke_or_defer(api_base: str, token: Optional[str]) -> None:
    compat = _compat()
    if token and not compat._revoke_embodiment_token(api_base, token):
        compat.pending_revokes.append(token)


def _drain_pending_revokes(api_base: str) -> None:
    compat = _compat()
    compat.pending_revokes[:] = [
        token
        for token in compat.pending_revokes
        if not compat._revoke_embodiment_token(api_base, token)
    ]


def _retire_headless(api_base: str, live_workers: dict, aid) -> Optional[dict]:
    worker = live_workers.get(aid)
    if worker is not None:
        _compat()._revoke_or_defer(api_base, worker.get("run_token"))
    return live_workers.pop(aid, None)


def _retire_resident(
    api_base: str, live_residents: dict, conv_id
) -> Optional[dict]:
    resident = live_residents.get(conv_id)
    if resident is not None:
        _compat()._revoke_or_defer(api_base, resident.get("run_token"))
    return live_residents.pop(conv_id, None)


def _finish_run(
    api_base: str,
    run_id,
    status: str,
    exit_code,
    log_path,
    diff=None,
    kill_reason=None,
) -> bool:
    compat = _compat()
    return _embodiment.finish_run(
        api_base,
        run_id,
        status,
        exit_code,
        log_path,
        post_json=compat._post_json,
        capture_output=compat._capture_run_output,
        usage_from_log=compat._usage_from_log,
        diff=diff,
        kill_reason=kill_reason,
    )


def _reap_sandbox_artifacts(rec: dict) -> None:
    """I4: reap a finished sandbox wake's container + per-run api-config."""
    _embodiment.reap_sandbox_artifacts(rec, sandbox_mod=_compat()._sandbox)


def _run_pid_alive(pid) -> bool:
    return _embodiment.run_pid_alive(pid)


def _reap_dead_pid_resident_runs(
    api_base: str,
    aid: str,
    live_pids=frozenset(),
    *,
    quiet: bool = True,
) -> int:
    compat = _compat()
    return _embodiment.reap_dead_resident_runs(
        api_base,
        aid,
        live_pids,
        get_json=compat._get_json,
        post_json=compat._post_json,
        finish_run=compat._finish_run,
        pid_alive=compat._run_pid_alive,
        quiet=quiet,
    )


def _run_git(args, cwd=None, timeout: float = 30.0):
    return _worktree_base.run_git(args, cwd, timeout)


def _safe_ref(alias) -> str:
    return _worktree_base.safe_ref(alias)


def _ensure_worktree_exclude(base_cwd) -> None:
    _worktree_base.ensure_exclude(base_cwd, _compat())


def _provision_worktree(base_cwd, alias):
    return _worktree_base.provision_disposable(base_cwd, alias, _compat())


def _overlay_runtime_config(base, worktree):
    _worktree_base.overlay_runtime_config(base, worktree)


def _seed_tab_binding(base_cwd, alias, agent_id, container_id) -> bool:
    return _worktree_base.seed_tab_binding(
        base_cwd, alias, agent_id, container_id
    )


def _provision_resident_worktree(base_cwd, conv_id):
    return _worktree_stable.provision_resident(base_cwd, conv_id, _compat())


def _provision_live_worktree(base_cwd, alias):
    return _worktree_stable.provision_live(base_cwd, alias, _compat())


def _provision_task_worktree(base_cwd, alias, task_id):
    return _worktree_stable.provision_task(
        base_cwd, alias, task_id, _compat()
    )


def _capture_diff(worktree, cap: int = 200_000):
    return _cleanup.capture_diff(worktree, _compat(), cap)


def _branch_commit_count(base_cwd, branch) -> int:
    return _cleanup.branch_commit_count(base_cwd, branch, _compat())


def _teardown_worktree(base_cwd, worktree, branch):
    _cleanup.teardown_worktree(base_cwd, worktree, branch, _compat())


def _is_git_repo(cwd) -> bool:
    return _cleanup.is_git_repo(cwd, _compat())


def _worktree_is_dirty(worktree, excludes=None) -> bool:
    return _cleanup.worktree_is_dirty(worktree, _compat(), excludes)


def _safe_teardown_worktree(base_cwd, worktree, branch) -> str:
    return _cleanup.safe_teardown_worktree(
        base_cwd, worktree, branch, _compat()
    )
