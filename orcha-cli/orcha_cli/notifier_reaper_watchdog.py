"""Handle terminal-result grace periods and notifier watchdog kills."""

from __future__ import annotations

import json

from .notifier_reaper_completion import _save_task_result


def handle_terminal_result(
    api_base,
    aid,
    worker,
    live_workers,
    failed_drains,
    agent_hold_until,
    now,
    quiet,
    runtime,
    services,
):
    """Wait for a clean exit after a terminal event, then reap a lingerer."""
    status = services._terminal_status(worker.get("log_path"), runtime=runtime)
    if status is None:
        return False
    proc = worker["proc"]
    seen = worker.get("result_seen_ts")
    if seen is None:
        worker["result_seen_ts"] = now
        if not quiet:
            print(
                f"[notifier] worker for {aid} (pid {proc.pid}) completed "
                f"(result={status}) — awaiting clean exit so SessionEnd can run"
            )
        return True
    if now - seen <= services.GRACEFUL_EXIT_SECS:
        return True
    services._kill_worker(proc, graceful=True)
    diff = services._capture_diff(worker.get("worktree"))
    drain_status = "exited"
    if runtime == services.RUNTIME_CODEX:
        drain_status = services._codex_exit_status(
            worker.get("log_path"), proc.returncode
        )
    lane = worker.get("lane", "work")
    if worker.get("task_worktree") and drain_status in ("rate_limited", "failed"):
        services._drain_task_failure(
            api_base,
            worker,
            aid,
            (worker.get("respawn_ctx") or {}).get("task_id"),
            drain_status,
            proc.returncode,
            diff,
            failed_drains=failed_drains,
            agent_hold_until=agent_hold_until,
            now=now,
            quiet=quiet,
            w_lane=lane,
            live_workers=live_workers,
            pid=proc.pid,
            drain_desc="completed-but-lingered, drained",
        )
        return True
    exit_code = 0 if status == "success" else proc.returncode
    services._finish_run(
        api_base,
        worker.get("run_id"),
        drain_status,
        exit_code,
        worker.get("log_path"),
        diff,
    )
    if worker.get("task_worktree"):
        _save_task_result(api_base, aid, worker, diff, failed_drains, services)
    else:
        services._teardown_worktree(
            worker.get("base_cwd"), worker.get("worktree"), worker.get("branch")
        )
    ack = {
        "kind": "worker_completed_reaped",
        "release_lease": True,
        "lane": lane,
    }
    if worker.get("task_worktree"):
        ack["delivered_ts"] = None
    services._post_json(f"{api_base}/api/agents/{aid}/wake-ack", ack)
    if exit_code == 0:
        services._post_json(
            f"{api_base}/api/agents/{aid}/events/ack-handled",
            {"event_ids": worker.get("handled_event_ids") or []},
        )
    services._retire_headless(api_base, live_workers, aid)
    if not quiet:
        print(
            f"[notifier] worker for {aid} (pid {proc.pid}) completed but lingered "
            f">{services.GRACEFUL_EXIT_SECS:.0f}s after result — reaped as exited"
        )
    return True


def kill_stalled(
    api_base,
    aid,
    worker,
    live_workers,
    stall_secs,
    now,
    stalled,
    over_cap,
    is_live,
    runtime,
    services,
):
    """Kill a stalled or over-budget worker and preserve any dirty worktree."""
    proc = worker["proc"]
    log_path = worker.get("log_path")
    progress_ts = worker.get("last_progress_ts")
    diag = {
        "run_id": str(worker.get("run_id")) if worker.get("run_id") else None,
        "agent_id": aid,
        "cause": "stalled" if (stalled and not over_cap) else "hard_cap",
        "stall_secs": round(now - progress_ts, 1) if progress_ts else None,
        "stall_threshold": stall_secs,
        "last_progress_ts": progress_ts,
        "over_cap": over_cap,
        "worker_is_live": is_live,
        "runtime": runtime,
        "last_event_type": services._last_event_type(log_path),
    }
    services._kill_worker(proc, graceful=True)
    diff = services._capture_diff(worker.get("worktree"))
    services._finish_run(
        api_base,
        worker.get("run_id"),
        "killed",
        proc.returncode,
        log_path,
        diff,
        kill_reason=json.dumps(diag),
    )
    disposition = services._safe_teardown_worktree(
        worker.get("base_cwd"), worker.get("worktree"), worker.get("branch")
    )
    kind = (
        "worker_stalled_killed"
        if (stalled and not over_cap)
        else "worker_timeout_killed"
    )
    ack = {"kind": kind, "release_lease": True, "lane": worker.get("lane", "work")}
    if (
        not worker.get("wake_task_id")
        and not (diff or "").strip()
        and worker.get("wake_ack_ts") is not None
    ):
        ack["delivered_ts"] = worker.get("wake_ack_ts")
    services._post_json(f"{api_base}/api/agents/{aid}/wake-ack", ack)
    services._retire_headless(api_base, live_workers, aid)
    print(
        f"[notifier] WATCHDOG KILL {aid} (pid {proc.pid}) — gracefully KILLED "
        f"(SIGTERM→SIGKILL): {json.dumps(diag)}"
    )
    if disposition == "preserved-dirty":
        print(
            f"[notifier] preserved dirty worktree of killed worker {aid}: "
            f"{worker.get('worktree')}"
        )
