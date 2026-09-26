"""Preserve notifier task-worker, reaper, and wake-scan compatibility APIs."""

from __future__ import annotations

import sys
from typing import Optional

from . import notifier_checkpoint as _checkpoint
from . import notifier_orphan_cleanup as _orphan_cleanup
from . import notifier_reaper as _reaper
from . import notifier_run_feed as _run_feed
from . import notifier_task_continuity as _task_continuity
from . import notifier_wake_scan as _wake_scan
from . import notifier_worker_results as _worker_results


def _compat():
    return sys.modules["orcha_cli.notifier"]


def _codex_exit_status(log_path, returncode) -> str:
    compat = _compat()
    if compat._codex_tail_is_rate_limited(log_path):
        return "rate_limited"
    result_status = compat._codex_result_status(log_path)
    if result_status == "error":
        return "failed"
    if result_status is None and returncode not in (0, None):
        return "failed"
    return "exited"


def _codex_tail_is_rate_limited(log_path) -> bool:
    return _worker_results.codex_tail_is_rate_limited(log_path, _compat())


def _parse_rate_limit_reset(log_path) -> float:
    return _worker_results.parse_rate_limit_reset(log_path, _compat())


def _saved_ref(worker, checkpoint_sha, diff) -> dict:
    return _task_continuity.saved_ref(
        worker, checkpoint_sha, diff, _compat()
    )


def _saved_human_line(base_cwd, branch, sha) -> str:
    return _task_continuity.saved_human_line(
        base_cwd, branch, sha, _compat()
    )


def _reclaim_task_worktree(base_cwd, worktree, branch) -> str:
    return _task_continuity.reclaim_task_worktree(
        base_cwd, worktree, branch, _compat()
    )


def _record_task_saved_ref(
    api_base, worker, saved_ref, human_line
) -> None:
    _task_continuity.record_task_saved_ref(
        api_base, worker, saved_ref, human_line, _compat()
    )


def _synthesize_task_digest(
    api_base,
    agent_id,
    task_id,
    saved_ref,
    run_started_ts,
    human_line,
) -> None:
    _task_continuity.synthesize_task_digest(
        api_base,
        agent_id,
        task_id,
        saved_ref,
        run_started_ts,
        human_line,
        _compat(),
    )


def _is_stream_event_line(line: str) -> bool:
    return _run_feed.is_stream_event_line(line)


def _pump_one(api_base: str, aid: str, worker: dict) -> None:
    _run_feed.pump_one(api_base, worker, _compat()._post_json)


def _checkpoint_and_respawn(
    api_base: str,
    aid: str,
    worker: dict,
    live_workers: dict,
    quiet: bool,
) -> None:
    _checkpoint.checkpoint_and_respawn(
        api_base, aid, worker, live_workers, quiet, _compat()
    )


def _drain_task_failure(
    api_base: str,
    worker: dict,
    aid: str,
    task_id,
    status: str,
    returncode,
    diff,
    *,
    failed_drains: dict,
    agent_hold_until: dict,
    now: float,
    quiet: bool,
    w_lane: str,
    live_workers: dict,
    pid,
    drain_desc: str = "drained",
) -> None:
    _worker_results.drain_task_failure(
        api_base,
        worker,
        aid,
        task_id,
        status,
        returncode,
        diff,
        failed_drains=failed_drains,
        agent_hold_until=agent_hold_until,
        now=now,
        quiet=quiet,
        lane=w_lane,
        live_workers=live_workers,
        pid=pid,
        drain_desc=drain_desc,
        services=_compat(),
    )


def reap_workers(
    api_base: str,
    live_workers: dict,
    quiet: bool,
    stall_secs: float = 120.0,
    failed_drains: Optional[dict] = None,
    agent_hold_until: Optional[dict] = None,
) -> None:
    _reaper.reap_workers(
        api_base,
        live_workers,
        quiet,
        stall_secs,
        failed_drains if failed_drains is not None else {},
        agent_hold_until if agent_hold_until is not None else {},
        _compat(),
    )


def reap_orphan_leases(api_base: str, cid: str, quiet: bool) -> None:
    _orphan_cleanup.reap_orphan_leases(api_base, cid, quiet, _compat())


def live_sandbox_shield(live_workers: dict, live_residents: dict) -> frozenset:
    return _orphan_cleanup.live_sandbox_shield(live_workers, live_residents)


def reap_orphaned_runs(
    api_base: str,
    cid: str,
    live_pids=frozenset(),
    *,
    live_sandbox=frozenset(),
    quiet: bool = True,
) -> int:
    return _orphan_cleanup.reap_orphaned_runs(
        api_base,
        cid,
        live_pids,
        live_sandbox=live_sandbox,
        quiet=quiet,
        services=_compat(),
    )


def reap_terminal_task_worktrees(
    api_base: str,
    cid: str,
    base_cwd: Optional[str],
    live_workers: dict,
    swept_tasks: set,
    quiet: bool,
    failed_drains: Optional[dict] = None,
) -> int:
    return _orphan_cleanup.reap_terminal_task_worktrees(
        api_base,
        cid,
        base_cwd,
        live_workers,
        swept_tasks,
        quiet,
        failed_drains,
        _compat(),
    )


def tick(
    api_base: str,
    cid: str,
    *,
    dry_run: bool,
    cooldown: float,
    min_idle: float,
    quiet: bool,
    lease_ttl: float = 1200.0,
    live_workers: Optional[dict] = None,
    base_cwd: Optional[str] = None,
    agent_hold_until: Optional[dict] = None,
) -> dict:
    """Run one scan-and-wake pass through the focused coordinator."""
    return _wake_scan.tick(
        api_base,
        cid,
        dry_run=dry_run,
        cooldown=cooldown,
        min_idle=min_idle,
        quiet=quiet,
        lease_ttl=lease_ttl,
        live_workers=live_workers,
        base_cwd=base_cwd,
        agent_hold_until=agent_hold_until,
        services=_compat(),
    )
