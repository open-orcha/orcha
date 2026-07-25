"""Finalize exited, stopped, and completed notifier workers."""

from __future__ import annotations

import json


def _save_task_result(api_base, aid, worker, diff, failed_drains, services):
    task_id = (worker.get("respawn_ctx") or {}).get("task_id")
    sha = services._checkpoint_task_worktree(
        worker.get("base_cwd"),
        worker.get("worktree"),
        worker.get("branch"),
        task_id,
        worker.get("run_id"),
    )
    failed_drains.pop((aid, task_id), None)
    if sha or (diff or "").strip():
        saved = services._saved_ref(worker, sha, diff)
        human = services._saved_human_line(
            worker.get("base_cwd"), worker.get("branch"), sha
        )
        services._record_task_saved_ref(api_base, worker, saved, human)
        services._synthesize_task_digest(
            api_base, aid, task_id, saved, worker.get("started_ts"), human
        )


def _release_worker(api_base, aid, worker, lane, kind, services, *, task=False):
    body = {"kind": kind, "release_lease": True, "lane": lane}
    if task:
        body["delivered_ts"] = None
    services._post_json(
        f"{api_base}/api/agents/{aid}/wake-ack",
        body,
    )


def handle_exited(
    api_base,
    aid,
    worker,
    live_workers,
    failed_drains,
    agent_hold_until,
    now,
    quiet,
    services,
):
    """Finalize a child process which has already exited."""
    proc = worker["proc"]
    lane = worker.get("lane", "work")
    diff = services._capture_diff(worker.get("worktree"))
    runtime = services._normalize_runtime(
        (worker.get("respawn_ctx") or {}).get("model_runtime")
    )
    status = "exited"
    if runtime == services.RUNTIME_CODEX:
        status = services._codex_exit_status(worker.get("log_path"), proc.returncode)
    is_task = bool(worker.get("task_worktree"))
    task_id = (worker.get("respawn_ctx") or {}).get("task_id")
    if is_task and status in ("rate_limited", "failed"):
        services._drain_task_failure(
            api_base,
            worker,
            aid,
            task_id,
            status,
            proc.returncode,
            diff,
            failed_drains=failed_drains,
            agent_hold_until=agent_hold_until,
            now=now,
            quiet=quiet,
            w_lane=lane,
            live_workers=live_workers,
            pid=proc.pid,
            drain_desc="drained",
        )
        return
    services._finish_run(
        api_base,
        worker.get("run_id"),
        status,
        proc.returncode,
        worker.get("log_path"),
        diff,
    )
    if is_task:
        _save_task_result(api_base, aid, worker, diff, failed_drains, services)
        _release_worker(api_base, aid, worker, lane, "released", services, task=True)
    else:
        services._teardown_worktree(
            worker.get("base_cwd"), worker.get("worktree"), worker.get("branch")
        )
        _release_worker(api_base, aid, worker, lane, "released", services)
    if proc.returncode == 0:
        services._post_json(
            f"{api_base}/api/agents/{aid}/events/ack-handled",
            {"event_ids": worker.get("handled_event_ids") or []},
        )
    services._retire_headless(api_base, live_workers, aid)
    if not quiet:
        disposition = "task worktree preserved" if is_task else "worktree torn down"
        print(
            f"[notifier] worker for {aid} (pid {proc.pid}, rc={proc.returncode}) "
            f"exited ({status}) — {disposition}, lease released"
        )


def handle_human_stop(api_base, aid, worker, live_workers, renew, quiet, services):
    """Gracefully stop the exact run named by a human stop request."""
    if not (
        renew
        and renew.get("stop_requested")
        and str(renew.get("stop_run_id")) == str(worker.get("run_id"))
    ):
        return False
    proc = worker["proc"]
    lane = worker.get("lane", "work")
    services._kill_worker(proc, graceful=True)
    diff = services._capture_diff(worker.get("worktree"))
    diag = {
        "run_id": str(worker.get("run_id")),
        "agent_id": aid,
        "cause": "human_stop",
        "by": renew.get("stop_requested_by"),
    }
    services._finish_run(
        api_base,
        worker.get("run_id"),
        "killed",
        proc.returncode,
        worker.get("log_path"),
        diff,
        kill_reason=json.dumps(diag),
    )
    services._safe_teardown_worktree(
        worker.get("base_cwd"), worker.get("worktree"), worker.get("branch")
    )
    services._post_json(
        f"{api_base}/api/agents/{aid}/wake-ack",
        {"kind": "worker_human_stopped", "release_lease": True, "lane": lane},
    )
    services._retire_headless(api_base, live_workers, aid)
    if not quiet:
        actor = renew.get("stop_requested_by") or "a human"
        print(
            f"[notifier] worker for {aid} (pid {proc.pid}, run "
            f"{worker.get('run_id')}) STOPPED by {actor} — graceful kill, "
            "worktree preserved if dirty, lease released"
        )
    return True
