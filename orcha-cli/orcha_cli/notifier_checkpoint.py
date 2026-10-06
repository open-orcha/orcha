"""Checkpoint long-running task workers and respawn them with fresh context."""

from __future__ import annotations

from .notifier_routing_handoff import (
    capture_stopped_checkout_diff,
    checkout_live_guard,
    checkout_owner_key,
    record_stopped_checkout_snapshot,
    reserve_checkout_start,
    stopped_snapshot_requires_retry,
)
from .notifier_wake_worker import _stop_unregistered_worker


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
    current_run = _current_run(api_base, agent_id, worker, services)

    services._kill_worker(process, graceful=True)
    source_cwd = worktree or base_cwd
    snapshot = record_stopped_checkout_snapshot(
        worker, agent_id, services, api_base=api_base
    )
    if snapshot is not None and not snapshot.ok and not quiet:
        print(
            f"[notifier] checkpoint provenance capture for {agent_id} failed: "
            f"{snapshot.code} — {snapshot.guidance}"
        )
    if stopped_snapshot_requires_retry(snapshot):
        # Keep the open run and lease as durable retry state. The normal reaper
        # sees the now-stopped process and retries capture on its next pass.
        worker["snapshot_retry_pending"] = snapshot.code
        return
    worker.pop("snapshot_retry_pending", None)
    diff = capture_stopped_checkout_diff(snapshot, source_cwd, services)
    if services._finish_run(
        api_base,
        worker.get("run_id"),
        "exited",
        0,
        worker.get("log_path"),
        diff,
    ):
        # I4: the OLD wake's container, once stamped
        services._reap_sandbox_artifacts(worker)
    task_id = (
        current_run.get("task_id")
        if current_run is not None
        else context.get("task_id")
    )
    source_owner_verified = _run_records_checkout(current_run, source_cwd, services)
    worktree, branch, task_worktree, worktrees_disabled = _respawn_routing(
        api_base,
        agent_id,
        worker,
        context,
        task_id,
        services,
    )
    destination_cwd = worktree or base_cwd
    checkout_activity = None
    git_checker = getattr(services, "_is_git_repo", None)
    shared_git_checkout = False
    if not worktree and destination_cwd and callable(git_checker):
        try:
            shared_git_checkout = bool(git_checker(destination_cwd))
        except (OSError, TypeError, ValueError):
            shared_git_checkout = False
    if shared_git_checkout:
        checkout_activity = reserve_checkout_start(
            api_base,
            destination_cwd,
            checkout_owner_key(agent_id, task_id=task_id, lane="work"),
            services,
            container_id=worker.get("container_id")
            or context.get("container_id"),
            local_workers=live_workers,
        )
        if not checkout_activity:
            _handle_handoff_failure(
                api_base,
                agent_id,
                worker,
                live_workers,
                task_id,
                diff,
                quiet,
                services,
                handoff=checkout_activity,
            )
            return
    handoff_call = getattr(services, "_handoff_worktree_changes_result", None)
    handoff_kwargs = {
        "owner_key": checkout_owner_key(
            agent_id,
            task_id=task_id,
            lane="work",
        ),
        "source_owner_verified": source_owner_verified,
        "snapshot_run_id": worker.get("run_id"),
        "checkout_guard": checkout_live_guard(
            api_base,
            services,
            container_id=worker.get("container_id") or context.get("container_id"),
            ignore_activity_id=getattr(
                checkout_activity, "reservation_id", None
            ),
        ),
    }
    if handoff_call is not None:
        handoff = handoff_call(source_cwd, destination_cwd, **handoff_kwargs)
    else:
        handoff = services._handoff_worktree_changes(
            source_cwd, destination_cwd, **handoff_kwargs
        )
    if not handoff:
        if checkout_activity is not None:
            released = services._release_checkout_activity(
                destination_cwd, activity=checkout_activity
            )
            if released is not None and not released:
                handoff = released
        _handle_handoff_failure(
            api_base,
            agent_id,
            worker,
            live_workers,
            task_id,
            diff,
            quiet,
            services,
            handoff=handoff,
        )
        return
    if checkout_activity is not None:
        marker = getattr(services, "_mark_checkout_activity_routed", None)
        try:
            marked = bool(
                marker(
                    checkout_activity,
                    source=source_cwd,
                    patch_sha256=getattr(handoff, "patch_sha256", None),
                )
            ) if callable(marker) else False
        except (OSError, TypeError, ValueError):
            marked = False
        if not marked:
            services._release_checkout_activity(
                destination_cwd, activity=checkout_activity
            )
            _handle_handoff_failure(
                api_base,
                agent_id,
                worker,
                live_workers,
                task_id,
                diff,
                quiet,
                services,
                handoff=None,
            )
            return

    services._revoke_or_defer(api_base, worker.get("run_token"))
    new_token = services._mint_embodiment_token(
        api_base, agent_id, "work", "headless"
    )
    persona = services._build_persona(api_base, agent_id, force_fresh=True)
    log_path = _next_log_path(base_cwd, context, services)
    _spawn_info: dict = {}
    try:
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
            spawn_info=_spawn_info,
            checkout_activity=checkout_activity,
        )
    except Exception:
        # The transport may have created a child before raising. Keep the
        # reservation as a fail-closed recovery marker when no process handle
        # was returned.
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
        raise
    if not (sent and new_process is not None):
        if checkout_activity is not None:
            services._release_checkout_activity(
                destination_cwd, activity=checkout_activity
            )
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

    if checkout_activity is not None:
        try:
            activity_bound = services._bind_checkout_activity(
                checkout_activity,
                pid=new_process.pid,
                sandbox_container_id=_spawn_info.get("sandbox_container_id"),
            )
        except Exception:
            activity_bound = False
        if not activity_bound:
            evidence = _stop_unregistered_worker(
                api_base,
                {
                    "agent_id": agent_id,
                    "alias": context.get("alias"),
                    "headless_cwd": base_cwd,
                },
                process=new_process,
                token=new_token,
                worktree=worktree,
                branch=branch,
                task_worktree=task_worktree,
                run_task_id=task_id,
                log_path=log_path,
                sandbox_container_id=_spawn_info.get("sandbox_container_id"),
                services=services,
            )
            if evidence is not None and bool(evidence):
                services._release_checkout_activity(
                    destination_cwd, activity=checkout_activity
                )
            services._retire_headless(api_base, live_workers, agent_id)
            return

    _run_payload = {
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
    }
    # Remote-runner §3.3c: a sandbox wake stamps its container name on the run row (and its
    # wake_kind) so a restarted daemon re-adopts the live container by label instead of
    # orphaning it, and metering can attribute container runtime to the run.
    if _spawn_info.get("sandbox_container_id"):
        _run_payload["sandbox_container_id"] = _spawn_info["sandbox_container_id"]
        _run_payload["wake_kind"] = "sandbox"
    try:
        run = services._post_json(
            f"{api_base}/api/agents/{agent_id}/runs", _run_payload
        )
    except Exception:
        run = None
    run_id = (run or {}).get("run_id")
    if not run_id:
        evidence = _stop_unregistered_worker(
            api_base,
            {
                "agent_id": agent_id,
                "alias": context.get("alias"),
                "headless_cwd": base_cwd,
            },
            process=new_process,
            token=new_token,
            worktree=worktree,
            branch=branch,
            task_worktree=task_worktree,
            run_task_id=task_id,
            log_path=log_path,
            sandbox_container_id=_spawn_info.get("sandbox_container_id"),
            services=services,
        )
        if (
            checkout_activity is not None
            and evidence is not None
            and bool(evidence)
        ):
            services._release_checkout_activity(
                destination_cwd, activity=checkout_activity
            )
        services._retire_headless(api_base, live_workers, agent_id)
        return
    activity_bound = True
    if checkout_activity is not None:
        try:
            activity_bound = services._bind_checkout_activity(
                checkout_activity,
                run_id=run_id,
                pid=new_process.pid,
                sandbox_container_id=_spawn_info.get("sandbox_container_id"),
            )
        except Exception:
            activity_bound = False
    if not activity_bound:
        services._kill_worker(new_process, graceful=True)
    now = services.time.time()
    live_workers[agent_id] = {
        "proc": new_process,
        "hard_deadline": now + cap,
        "last_size": 0,
        "last_progress_ts": now,
        "run_id": run_id,
        "log_path": log_path,
        "worktree": worktree,
        "branch": branch,
        "base_cwd": base_cwd,
        "task_bound": bool(worker.get("task_bound", bool(worker.get("task_worktree")))),
        "task_worktree": task_worktree,
        "wake_ack_ts": worker.get("wake_ack_ts"),
        "wake_task_id": worker.get("wake_task_id"),
        "started_ts": worker.get("started_ts"),
        "agent_id": worker.get("agent_id") or agent_id,
        "lines_offset": 0,
        "lines_seq": 1,
        "lines_buf": b"",
        "handled_event_ids": (
            context.get("handled_event_ids") or worker.get("handled_event_ids") or []
        ),
        "cap": cap,
        "respawns": respawns,
        "respawn_ctx": context,
        "lane": worker.get("lane", "work"),
        "worktrees_disabled": worktrees_disabled,
        "api_base": api_base,
        "container_id": worker.get("container_id")
        or context.get("container_id"),
        # I4: the NEW wake's sandbox container rides the record so every
        # Popen-completion path can reap it (container + api-config) after stamping.
        "sandbox_container_id": _spawn_info.get("sandbox_container_id"),
        "run_token": new_token,
        "checkout_activity": checkout_activity,
    }
    if not activity_bound:
        # The stopped replacement remains registered under its real run id so
        # the normal reaper can snapshot and release the fail-closed barrier.
        return
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
            f"{respawns}/{services.HARD_CAP_RESPAWN_MAX}) in the selected project checkout"
        )


def _respawn_routing(api_base, agent_id, worker, context, task_id, services):
    """Apply the latest project routing preference to a checkpoint continuation.

    A checkpoint replacement is a new worker run, so a setting changed while the old process was
    alive must take effect here too.  The previous checkout is only detached from the new worker;
    it is never removed or reset as a side effect of routing changes.
    """
    previous_disabled = bool(
        worker.get("worktrees_disabled", context.get("worktrees_disabled", False))
    )
    desired_disabled = previous_disabled
    project = services._get_json(f"{api_base}/api/agents/{agent_id}/persona")
    if isinstance(project, dict) and "worktrees_disabled" in project:
        desired_disabled = bool(project["worktrees_disabled"])

    if desired_disabled:
        return None, None, False, True

    worktree = worker.get("worktree")
    branch = worker.get("branch")
    task_worktree = bool(worker.get("task_worktree"))
    if previous_disabled:
        worktree = branch = None
        task_worktree = False
        base_cwd = worker.get("base_cwd")
        if task_id:
            worktree, branch = services._provision_task_worktree(
                base_cwd, context.get("alias"), task_id
            )
            task_worktree = worktree is not None
        if worktree is None:
            worktree, branch = services._provision_worktree(
                base_cwd, context.get("alias")
            )
    return worktree, branch, task_worktree, False


def _current_run(api_base, agent_id, worker, services):
    """Return the persisted run record for the worker being checkpointed."""
    run_id = worker.get("run_id")
    data = services._get_json(f"{api_base}/api/agents/{agent_id}/runs?limit=20")
    if data and data.get("runs"):
        for run in data["runs"]:
            if run.get("run_id") == run_id:
                merged = dict(run)
                context = worker.get("respawn_ctx") or {}
                for key, value in (
                    ("worktree", worker.get("worktree")),
                    ("base_cwd", worker.get("base_cwd")),
                    ("branch", worker.get("branch")),
                    ("task_id", context.get("task_id")),
                ):
                    if merged.get(key) is None and value is not None:
                        merged[key] = value
                return merged
    return None


def _run_records_checkout(run, source_cwd, services):
    """Prove the stopped run owned the exact checkout being handed off."""
    if not run or not source_cwd:
        return False
    recorded_cwd = run.get("worktree") or run.get("base_cwd")
    if not recorded_cwd:
        return False
    try:
        return (
            services.pathlib.Path(recorded_cwd).resolve()
            == services.pathlib.Path(source_cwd).resolve()
        )
    except OSError:
        return False


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
        services._safe_teardown_worktree(
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
            "task worktree preserved" if is_task_worktree else "worktree torn down"
        )
        print(
            f"[notifier] checkpoint-respawn for {agent_id} FAILED to spawn "
            f"a fresh worker — {outcome} + lease released"
        )


def _handle_handoff_failure(
    api_base,
    agent_id,
    worker,
    live_workers,
    task_id,
    diff,
    quiet,
    services,
    *,
    handoff=None,
) -> None:
    """Stop visibly when a checkout switch cannot preserve the worker's file view."""
    if worker.get("task_worktree"):
        sha = services._checkpoint_task_worktree(
            worker.get("base_cwd"),
            worker.get("worktree"),
            worker.get("branch"),
            task_id,
            worker.get("run_id"),
        )
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

    if task_id:
        guidance = getattr(handoff, "guidance", "")
        reason = getattr(handoff, "code", "handoff_failed")
        services._post_json(
            f"{api_base}/api/tasks/{task_id}/messages",
            {
                "author_agent_id": worker.get("agent_id") or agent_id,
                "body": (
                    "Checkpoint replacement paused because Orcha could not safely carry "
                    "the in-progress files into the checkout selected by the project setting. "
                    "The existing files remain preserved, and no replacement worker was started. "
                    f"Reason: {reason}. {guidance}".rstrip()
                ),
            },
        )
    services._post_json(
        f"{api_base}/api/agents/{agent_id}/wake-ack",
        {
            "kind": "worker_checkpoint_handoff_failed",
            "release_lease": True,
            "lane": worker.get("lane", "work"),
        },
    )
    services._retire_headless(api_base, live_workers, agent_id)
    if not quiet:
        print(
            f"[notifier] checkpoint-respawn for {agent_id} paused: in-progress files "
            "could not be carried into the selected checkout; source preserved"
        )
