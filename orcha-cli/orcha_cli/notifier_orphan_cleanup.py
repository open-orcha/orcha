"""Reconcile orphaned runs, leases, and completed-task worktrees."""

from __future__ import annotations

from typing import Optional


def reap_orphan_leases(api_base: str, cid: str, quiet: bool, services) -> None:
    """Release single-flight leases whose agents stopped heartbeating."""
    res = services._post_json(
        f"{api_base}/api/containers/{cid}/reap-orphan-leases", {}
    )
    if res and res.get("reaped") and not quiet:
        for row in res["reaped"]:
            print(
                f"[notifier] reaped ORPHAN {row.get('lease_kind')} lease for "
                f"{row.get('alias')} (no heartbeat "
                f"{float(row.get('idle_seconds') or 0):.0f}s) — lease released "
                "(ISS-60B)"
            )


def reap_orphaned_runs(
    api_base: str,
    cid: str,
    live_pids=frozenset(),
    *,
    quiet: bool = True,
    services,
) -> int:
    """Reconcile database run rows whose host processes no longer exist."""
    data = services._get_json(
        f"{api_base}/api/containers/{cid}/running-runs"
    ) or {}
    runs = data.get("runs", [])
    if not runs:
        return 0

    def alive(row):
        pid = row.get("pid")
        return (pid in live_pids) or services._run_pid_alive(pid)

    by_agent_lane: dict = {}
    for row in runs:
        key = (row.get("agent_id"), row.get("lane") or "work")
        by_agent_lane.setdefault(key, []).append(row)

    reaped = 0
    for (agent_id, lane), rows in by_agent_lane.items():
        dead = [row for row in rows if not alive(row)]
        if not dead:
            continue
        live_sibling = any(alive(row) for row in rows)
        if live_sibling:
            for row in dead:
                services._finish_run(
                    api_base, row.get("run_id"), "killed", -1, None
                )
        else:
            services._post_json(
                f"{api_base}/api/agents/{agent_id}/wake-ack",
                {
                    "kind": "orphan_run_sweep",
                    "release_lease": True,
                    "lane": lane,
                },
            )
        reaped += len(dead)
        if not quiet:
            outcome = (
                "finished orphans, kept lease (live sibling)"
                if live_sibling
                else "released lease"
            )
            print(
                f"[notifier] swept {len(dead)} dead-pid orphaned "
                f"{lane}-lane run(s) for {agent_id} ({outcome}) (#342)"
            )
    return reaped


def reap_terminal_task_worktrees(
    api_base: str,
    cid: str,
    base_cwd: Optional[str],
    live_workers: dict,
    swept_tasks: set,
    quiet: bool,
    failed_drains: Optional[dict],
    services,
) -> int:
    """Reclaim clean durable worktrees after their tasks become terminal."""
    if not base_cwd or not services._is_git_repo(base_cwd):
        return 0

    live_worktrees = {
        worker.get("worktree")
        for worker in live_workers.values()
        if worker.get("worktree")
    }
    removed = 0
    for state in services._TERMINAL_TASK_STATES:
        removed += _reap_terminal_state(
            api_base,
            cid,
            state,
            base_cwd,
            live_worktrees,
            swept_tasks,
            quiet,
            failed_drains,
            services,
        )
    return removed


def _reap_terminal_state(
    api_base: str,
    cid: str,
    state: str,
    base_cwd: str,
    live_worktrees: set,
    swept_tasks: set,
    quiet: bool,
    failed_drains: Optional[dict],
    services,
) -> int:
    """Page through one terminal state and reclaim each eligible worktree."""
    removed = 0
    offset = 0
    for _page in range(services._TERMINAL_SWEEP_MAX_PAGES):
        data = services._get_json(
            f"{api_base}/api/containers/{cid}/tasks"
            f"?status={state}&sort=time&dir=asc"
            f"&limit={services._TERMINAL_SWEEP_PAGE_SIZE}&offset={offset}"
        ) or {}
        page_tasks = data.get("tasks", [])
        for task in page_tasks:
            removed += _reap_terminal_task(
                api_base,
                task,
                state,
                base_cwd,
                live_worktrees,
                swept_tasks,
                quiet,
                failed_drains,
                services,
            )
        if not data.get("has_more") or not page_tasks:
            break
        offset += len(page_tasks)
    return removed


def _reap_terminal_task(
    api_base: str,
    task: dict,
    state: str,
    base_cwd: str,
    live_worktrees: set,
    swept_tasks: set,
    quiet: bool,
    failed_drains: Optional[dict],
    services,
) -> int:
    """Reclaim the distinct durable worktrees recorded for one terminal task."""
    task_id = task.get("id")
    if not task_id or task_id in swept_tasks:
        return 0

    runs = services._get_json(f"{api_base}/api/tasks/{task_id}/runs") or {}
    seen: set = set()
    defer_sweep = False
    removed = 0
    for run in runs.get("runs", []):
        worktree, branch = run.get("worktree"), run.get("branch")
        if (
            not worktree
            or not branch
            or not str(branch).startswith("orcha/task-")
            or worktree in seen
        ):
            continue
        seen.add(worktree)
        if worktree in live_worktrees:
            defer_sweep = True
            continue
        try:
            outcome = services._reclaim_task_worktree(
                run.get("base_cwd") or base_cwd, worktree, branch
            )
        except Exception:
            outcome = "preserved-dirty"
        if outcome == "removed":
            removed += 1
            if not quiet:
                print(
                    f"[notifier] reclaimed durable task worktree {worktree} "
                    f"(branch {branch}) — task terminal ({state}), clean tree"
                )
        elif outcome == "preserved-dirty":
            defer_sweep = True
            if not quiet:
                print(
                    f"[notifier] task {task_id} terminal but its worktree "
                    f"{worktree} has uncommitted work — PRESERVED for a human, "
                    "not reclaimed"
                )

    if failed_drains is not None:
        for key in [key for key in failed_drains if key[1] == task_id]:
            failed_drains.pop(key, None)
    if not defer_sweep:
        swept_tasks.add(task_id)
    return removed
