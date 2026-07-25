"""Checkpoint long-running task workers and respawn them with fresh context."""

from __future__ import annotations


def checkpoint_and_respawn(
    api_base: str,
    agent_id: str,
    worker: dict,
    live_workers: dict,
    quiet: bool,
    services,
) -> None:
    """Gracefully checkpoint a progressing worker and replace its process."""
    process = worker["proc"]
    context = worker.get("respawn_ctx") or {}
    base_cwd = worker.get("base_cwd")
    worktree = worker.get("worktree")
    branch = worker.get("branch")
    respawns = worker.get("respawns", 0) + 1
    cap = worker.get("cap", services.HARD_CAP_MIN_SECS)

    services._kill_worker(process, graceful=True)
    diff = services._capture_diff(worktree)
    services._finish_run(
        api_base,
        worker.get("run_id"),
        "exited",
        0,
        worker.get("log_path"),
        diff,
    )
    task_id = _current_task_id(api_base, agent_id, worker, context, services)

    services._revoke_or_defer(api_base, worker.get("run_token"))
    new_token = services._mint_embodiment_token(
        api_base, agent_id, "work", "headless"
    )
    persona = services._build_persona(api_base, agent_id, force_fresh=True)
    log_path = _next_log_path(base_cwd, context, services)
    sent, _command, new_process = services.spawn_headless(
        worktree or base_cwd,
        context.get("prompt", ""),
        context.get("flags"),
        False,
        alias=context.get("alias"),
        system_prompt=persona,
        model=context.get("model"),
        reasoning_effort=context.get("reasoning_effort"),
        runtime=context.get("model_runtime"),
        log_path=log_path,
        run_token=new_token,
    )
    if not (sent and new_process is not None):
        _handle_spawn_failure(
            api_base,
            agent_id,
            worker,
            live_workers,
            context,
            diff,
            new_token,
            quiet,
            services,
        )
        return

    run = services._post_json(
        f"{api_base}/api/agents/{agent_id}/runs",
        {
            "wake_kind": "ephemeral",
            "wake_event": "checkpoint_respawn",
            "task_id": task_id,
            "log_path": str(log_path) if log_path else None,
            "pid": new_process.pid,
            "runtime": context.get("model_runtime"),
            "worktree": worktree,
            "branch": branch,
            "base_cwd": base_cwd,
            "lane": worker.get("lane", "work"),
            "token_id": new_token,
        },
    )
    now = services.time.time()
    live_workers[agent_id] = {
        "proc": new_process,
        "hard_deadline": now + cap,
        "last_size": 0,
        "last_progress_ts": now,
        "run_id": (run or {}).get("run_id"),
        "log_path": log_path,
        "worktree": worktree,
        "branch": branch,
        "base_cwd": base_cwd,
        "task_worktree": bool(worker.get("task_worktree")),
        "wake_ack_ts": worker.get("wake_ack_ts"),
        "wake_task_id": worker.get("wake_task_id"),
        "started_ts": worker.get("started_ts"),
        "agent_id": worker.get("agent_id") or agent_id,
        "lines_offset": 0,
        "lines_seq": 1,
        "lines_buf": b"",
        "handled_event_ids": (
            context.get("handled_event_ids")
            or worker.get("handled_event_ids")
            or []
        ),
        "cap": cap,
        "respawns": respawns,
        "respawn_ctx": context,
        "lane": worker.get("lane", "work"),
        "run_token": new_token,
    }
    services._post_json(
        f"{api_base}/api/agents/{agent_id}/wake-ack",
        {
            "kind": "worker_checkpoint_respawn",
            "release_lease": False,
            "lane": worker.get("lane", "work"),
        },
    )
    if not quiet:
        print(
            f"[notifier] worker for {agent_id} (pid {process.pid}) crossed "
            "the soft hard-cap while still progressing — checkpointed "
            f"(C1 digest) + respawned (pid {new_process.pid}, respawn "
            f"{respawns}/{services.HARD_CAP_RESPAWN_MAX}) on the same worktree"
        )


def _current_task_id(api_base, agent_id, worker, context, services):
    """Resolve task attribution from the exact run that was checkpointed."""
    run_id = worker.get("run_id")
    data = services._get_json(
        f"{api_base}/api/agents/{agent_id}/runs?limit=20"
    )
    task_id = context.get("task_id")
    if data and data.get("runs"):
        for run in data["runs"]:
            if run.get("run_id") == run_id:
                return run.get("task_id")
    return task_id


def _next_log_path(base_cwd, context, services):
    """Build the replacement worker's log path without touching the filesystem."""
    if not base_cwd:
        return None
    return (
        services.pathlib.Path(base_cwd)
        / ".claude"
        / ".orcha-wakes"
        / f"{context.get('alias', 'agent')}-{int(services.time.time())}.log"
    )


def _handle_spawn_failure(
    api_base,
    agent_id,
    worker,
    live_workers,
    context,
    diff,
    new_token,
    quiet,
    services,
) -> None:
    """Preserve durable task work when the replacement process cannot start."""
    services._revoke_or_defer(api_base, new_token)
    is_task_worktree = bool(worker.get("task_worktree"))
    if is_task_worktree:
        task_id = context.get("task_id")
        sha = services._checkpoint_task_worktree(
            worker.get("base_cwd"),
            worker.get("worktree"),
            worker.get("branch"),
            task_id,
            worker.get("run_id"),
        )
        if sha or (diff or "").strip():
            saved = services._saved_ref(worker, sha, diff)
            human = services._saved_human_line(
                worker.get("base_cwd"), worker.get("branch"), sha
            )
            services._record_task_saved_ref(api_base, worker, saved, human)
            services._synthesize_task_digest(
                api_base,
                agent_id,
                task_id,
                saved,
                worker.get("started_ts"),
                human,
            )
    else:
        services._teardown_worktree(
            worker.get("base_cwd"),
            worker.get("worktree"),
            worker.get("branch"),
        )
    services._post_json(
        f"{api_base}/api/agents/{agent_id}/wake-ack",
        {
            "kind": "worker_checkpoint_respawn_failed",
            "release_lease": True,
            "lane": worker.get("lane", "work"),
        },
    )
    worker["run_token"] = new_token
    services._retire_headless(api_base, live_workers, agent_id)
    if not quiet:
        outcome = (
            "task worktree preserved"
            if is_task_worktree
            else "worktree torn down"
        )
        print(
            f"[notifier] checkpoint-respawn for {agent_id} FAILED to spawn "
            f"a fresh worker — {outcome} + lease released"
        )
