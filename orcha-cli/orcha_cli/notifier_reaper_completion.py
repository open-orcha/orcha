"""Finalize exited, stopped, and completed notifier workers."""

from __future__ import annotations

import json

from .notifier_routing_handoff import (
    capture_stopped_checkout_diff,
    record_stopped_checkout_snapshot,
    stopped_snapshot_has_attributable_state,
    stopped_snapshot_requires_retry,
)


def _snapshot_stopped_worker(api_base, worker, aid, quiet, services):
    """Best-effort durable provenance for a stopped shared-main worker."""
    result = record_stopped_checkout_snapshot(
        worker, aid, services, api_base=api_base
    )
    if result is not None and not result.ok and not quiet:
        print(
            f"[notifier] could not record checkout provenance for {aid}: "
            f"{result.code} — {result.guidance}"
        )
    if stopped_snapshot_has_attributable_state(result):
        worker.pop("snapshot_attribution_blocked", None)
    elif result is not None:
        worker["snapshot_attribution_blocked"] = {
            "code": result.code,
            "guidance": result.guidance,
        }
    return result


def _snapshot_pending(result) -> bool:
    """A failed shared-checkout capture must remain retryable before finalization."""
    return stopped_snapshot_requires_retry(result)


def _snapshot_diff(result, worker, services):
    """Return a diff only when the stopped run owned an attributable file view."""
    return capture_stopped_checkout_diff(
        result,
        worker.get("worktree") or worker.get("base_cwd"),
        services,
    )


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
    snapshot = _snapshot_stopped_worker(api_base, worker, aid, quiet, services)
    if _snapshot_pending(snapshot):
        worker["snapshot_retry_pending"] = snapshot.code
        return
    worker.pop("snapshot_retry_pending", None)
    diff = _snapshot_diff(snapshot, worker, services)
    runtime = services._normalize_runtime(
        (worker.get("respawn_ctx") or {}).get("model_runtime")
    )
    status = "exited"
    if runtime == services.RUNTIME_CODEX:
        status = services._codex_exit_status(worker.get("log_path"), proc.returncode)
    is_task_worktree = bool(worker.get("task_worktree"))
    is_task_bound = bool(worker.get("task_bound", is_task_worktree))
    task_id = (worker.get("respawn_ctx") or {}).get("task_id")
    if is_task_bound and status in ("rate_limited", "failed"):
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
    if services._finish_run(
        api_base,
        worker.get("run_id"),
        status,
        proc.returncode,
        worker.get("log_path"),
        diff,
    ):
        services._reap_sandbox_artifacts(worker)  # I4: clean completion — reap once stamped
    if is_task_worktree:
        _save_task_result(api_base, aid, worker, diff, failed_drains, services)
        _release_worker(api_base, aid, worker, lane, "released", services, task=True)
    else:
        cleanup = (
            services._safe_teardown_worktree(
                worker.get("base_cwd"),
                worker.get("worktree"),
                worker.get("branch"),
            )
            if worker.get("worktree")
            else "noop"
        )
        _release_worker(api_base, aid, worker, lane, "released", services)
    if proc.returncode == 0:
        services._post_json(
            f"{api_base}/api/agents/{aid}/events/ack-handled",
            {"event_ids": worker.get("handled_event_ids") or []},
        )
    services._retire_headless(api_base, live_workers, aid)
    if not quiet:
        disposition = (
            "task worktree preserved"
            if is_task_worktree
            else (
                "dirty worktree preserved"
                if cleanup == "preserved-dirty"
                else "clean worktree retired"
            )
        )
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
    snapshot = _snapshot_stopped_worker(api_base, worker, aid, quiet, services)
    if _snapshot_pending(snapshot):
        worker["snapshot_retry_pending"] = snapshot.code
        return True
    worker.pop("snapshot_retry_pending", None)
    diff = _snapshot_diff(snapshot, worker, services)
    diag = {
        "run_id": str(worker.get("run_id")),
        "agent_id": aid,
        "cause": "human_stop",
        "by": renew.get("stop_requested_by"),
    }
    if services._finish_run(
        api_base,
        worker.get("run_id"),
        "killed",
        proc.returncode,
        worker.get("log_path"),
        diff,
        kill_reason=json.dumps(diag),
    ):
        # I4 (force-rm: takes a still-stopping container down with it, post-stamp)
        services._reap_sandbox_artifacts(worker)
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
