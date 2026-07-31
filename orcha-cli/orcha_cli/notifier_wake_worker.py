"""Claim, isolate, spawn, and register notifier work-lane workers."""

from __future__ import annotations

import sys
import time


def _worktree_for(candidate, auto_tasks, live_workers, dry_run, services):
    """Provision isolation appropriate to the candidate's likely work."""
    headless_cwd = candidate.get("headless_cwd")
    noncode_events = ("request_answered", "request_closed")
    single_noncode = (
        (candidate.get("pending_events") or 0) <= 1
        and candidate.get("latest_event") in noncode_events
    )
    code_wake = (
        bool(auto_tasks)
        or bool(candidate.get("wake_task_id"))
        or bool(candidate.get("context_task_id"))
        or not single_noncode
    )
    task_id = candidate.get("context_task_id") or (
        auto_tasks[0] if auto_tasks else candidate.get("wake_task_id")
    )
    worktree = branch = None
    task_worktree = False
    if code_wake and headless_cwd and not dry_run and live_workers is not None:
        if task_id:
            worktree, branch = services._provision_task_worktree(
                headless_cwd, candidate.get("alias"), task_id
            )
            task_worktree = worktree is not None
        if worktree is None:
            worktree, branch = services._provision_worktree(
                headless_cwd, candidate.get("alias")
            )
    return worktree, branch, task_worktree


def _worker_state(
    candidate,
    *,
    process,
    run_id,
    log_path,
    worktree,
    branch,
    task_worktree,
    cap,
    event,
    run_task_id,
    token,
    prompt,
):
    """Build the daemon-owned state used by progress and completion reapers."""
    now = time.time()
    auto_tasks = candidate.get("auto_start_task_ids") or []
    handled = candidate.get("handled_event_ids") or []
    wake_ack_ts = candidate.get("ack_through_ts")
    if wake_ack_ts is None:
        wake_ack_ts = candidate.get("max_event_ts")
    respawn = {
        "prompt": prompt,
        "flags": candidate.get("headless_flags"),
        "alias": candidate.get("alias"),
        "model": candidate.get("model"),
        "reasoning_effort": candidate.get("reasoning_effort"),
        "model_runtime": candidate.get("model_runtime"),
        "task_id": run_task_id,
        "task_worktree": task_worktree,
        "handled_event_ids": handled,
        "event": event,
    }
    return {
        "proc": process,
        "hard_deadline": now + cap,
        "last_size": 0,
        "last_progress_ts": now,
        "run_id": run_id,
        "log_path": log_path,
        "worktree": worktree,
        "branch": branch,
        "base_cwd": candidate.get("headless_cwd"),
        "task_worktree": task_worktree,
        "started_ts": now,
        "agent_id": candidate["agent_id"],
        "lines_offset": 0,
        "lines_seq": 1,
        "lines_buf": b"",
        "cap": cap,
        "respawns": 0,
        "wake_event": event,
        # The server may ground a sole assignment/rework directive through
        # context_task_id even when wake_task_id is empty. Preserve that task
        # identity so every failure path withholds the directive for retry.
        "wake_task_id": run_task_id,
        "wake_ack_ts": wake_ack_ts,
        "handled_event_ids": handled,
        "respawn_ctx": respawn,
        "run_token": token,
        "lane": "work",
    }


def spawn(
    api_base,
    candidate,
    *,
    prompt,
    event,
    dry_run,
    quiet,
    lease_ttl,
    live_workers,
    services,
):
    """Claim and launch one ephemeral worker, preserving all public wake seams."""
    cap = (
        max(lease_ttl, services.HARD_CAP_MIN_SECS)
        if live_workers is not None
        else lease_ttl
    )
    claim_ttl = services.WAKE_LEASE_TTL_SECS if live_workers is not None else cap
    lane = "work"
    if not dry_run:
        claim = services._post_json(
            f"{api_base}/api/agents/{candidate['agent_id']}/wake-claim",
            {
                "lease_ttl": claim_ttl,
                "kind": "ephemeral",
                "event": event,
                "lane": lane,
            },
        )
        if not (claim and claim.get("claimed")):
            reason = (claim or {}).get("reason", "claim failed (unreachable)")
            if not quiet:
                print(
                    f"[notifier] skip {candidate['alias']} "
                    f"— single-flight: {reason}"
                )
            return None

    auto_tasks = candidate.get("auto_start_task_ids") or []
    run_task_id = candidate.get("context_task_id") or (
        auto_tasks[0] if auto_tasks else candidate.get("wake_task_id")
    )
    resume_rendered = False
    if dry_run:
        persona = None
    else:
        persona_result = services._build_persona(
            api_base,
            candidate["agent_id"],
            task_id=run_task_id,
            self_wake={
                "injected": candidate.get("self_wake_injected"),
                "task_id": candidate.get("self_wake_task_id"),
            },
            return_resume_rendered=True,
        )
        if isinstance(persona_result, tuple):
            persona, resume_rendered = persona_result
        else:
            persona = persona_result

    headless_cwd = candidate.get("headless_cwd")
    log_path = None
    if headless_cwd and not dry_run:
        log_path = (
            services.pathlib.Path(headless_cwd)
            / ".claude"
            / ".orcha-wakes"
            / f"{candidate.get('alias', 'agent')}-{int(time.time())}.log"
        )
    worktree, branch, task_worktree = _worktree_for(
        candidate, auto_tasks, live_workers, dry_run, services
    )
    run_cwd = worktree or headless_cwd
    token = (
        None
        if dry_run
        else services._mint_embodiment_token(
            api_base, candidate["agent_id"], lane, "headless"
        )
    )
    sent, command, process = services.spawn_headless(
        run_cwd,
        prompt,
        candidate.get("headless_flags"),
        dry_run,
        alias=candidate.get("alias"),
        system_prompt=persona,
        model=candidate.get("model"),
        reasoning_effort=candidate.get("reasoning_effort"),
        runtime=candidate.get("model_runtime"),
        log_path=log_path,
        run_token=token,
        conversation=False,
    )
    if sent and process is not None and live_workers is not None:
        run = services._post_json(
            f"{api_base}/api/agents/{candidate['agent_id']}/runs",
            {
                "wake_kind": "ephemeral",
                "wake_event": event,
                "task_id": run_task_id,
                "log_path": str(log_path) if log_path else None,
                "pid": getattr(process, "pid", None),
                "runtime": candidate.get("model_runtime"),
                "worktree": worktree,
                "branch": branch,
                "base_cwd": headless_cwd,
                "lane": lane,
                "token_id": token,
            },
        )
        run_id = (run or {}).get("run_id")
        if not run_id and not quiet:
            print(
                f"[notifier] WARN: worker_run NOT recorded for "
                f"{candidate.get('alias')} — POST /runs failed "
                f"(returned {run!r}); the worker is running unseen",
                file=sys.stderr,
            )
        live_workers[candidate["agent_id"]] = _worker_state(
            candidate,
            process=process,
            run_id=run_id,
            log_path=log_path,
            worktree=worktree,
            branch=branch,
            task_worktree=task_worktree,
            cap=cap,
            event=event,
            run_task_id=run_task_id,
            token=token,
            prompt=prompt,
        )
    elif worktree and not sent:
        services._teardown_worktree(headless_cwd, worktree, branch)
        services._revoke_or_defer(api_base, token)
    elif not sent and not dry_run:
        services._revoke_or_defer(api_base, token)
    return {
        "sent": sent,
        "command": command,
        "resume_rendered": resume_rendered,
        "lane": lane,
    }
