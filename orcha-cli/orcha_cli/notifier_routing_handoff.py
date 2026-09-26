"""Carry saved checkout state across project worktree-routing changes."""

from __future__ import annotations

import pathlib


def previous_run(
    api_base,
    agent_id,
    services,
    *,
    task_id=None,
    conversation_id=None,
    wake_kind=None,
    lane=None,
    require_taskless=False,
):
    """Return the newest run for the same logical stream of work."""
    data = services._get_json(f"{api_base}/api/agents/{agent_id}/runs?limit=200")
    if not isinstance(data, dict):
        return None
    for run in data.get("runs") or []:
        if task_id and run.get("task_id") != task_id:
            continue
        if conversation_id and run.get("conversation_id") != conversation_id:
            continue
        if wake_kind and run.get("wake_kind") != wake_kind:
            continue
        if lane and run.get("lane") != lane:
            continue
        if require_taskless and (
            run.get("task_id") is not None or run.get("conversation_id") is not None
        ):
            continue
        if run.get("worktree") or run.get("base_cwd"):
            return run
    return None


def previous_checkout(api_base, agent_id, services, **filters):
    """Return the newest recorded checkout for the same logical stream of work."""
    run = previous_run(api_base, agent_id, services, **filters)
    return (run.get("worktree") or run.get("base_cwd")) if run else None


def checkout_owner_key(
    agent_id,
    *,
    task_id=None,
    conversation_id=None,
    wake_kind=None,
    lane=None,
):
    """Name the logical stream allowed to reconcile a checkout's saved patch."""
    if task_id:
        return f"task:{task_id}"
    if conversation_id:
        return f"conversation:{conversation_id}"
    if wake_kind == "live":
        return f"terminal:{agent_id}"
    return f"{lane or 'work'}:{agent_id}:taskless"


def retained_branch_exists(services, base_cwd, branch):
    """Return whether a recorded worker branch still exists, or None when unknowable."""
    run_git = getattr(services, "_run_git", None)
    if run_git is None or not branch or not base_cwd:
        return None
    try:
        return_code, _ = run_git(
            ["show-ref", "--verify", "--quiet", f"refs/heads/{branch}"],
            cwd=base_cwd,
        )
    except (OSError, TypeError, ValueError):
        return None
    return return_code == 0


def carry_previous_checkout(
    api_base,
    agent_id,
    destination_cwd,
    services,
    *,
    source_cwd=None,
    task_id=None,
    conversation_id=None,
    wake_kind=None,
    lane=None,
    require_taskless=False,
):
    """Move the prior file view into ``destination_cwd`` before a new run starts.

    A missing prior run means there is no recorded state to carry. If a recorded
    worktree was retired, committed state is recovered from its retained branch;
    a routing change fails closed when no recoverable source remains. All actual
    transfers use the ownership-aware handoff and fail closed on conflicts.
    """
    prior_run = previous_run(
        api_base,
        agent_id,
        services,
        task_id=task_id,
        conversation_id=conversation_id,
        wake_kind=wake_kind,
        lane=lane,
        require_taskless=require_taskless,
    )
    recorded_source_cwd = (
        prior_run.get("worktree") or prior_run.get("base_cwd")
        if prior_run
        else None
    )
    if source_cwd is None:
        source_cwd = recorded_source_cwd
    if not source_cwd or not destination_cwd:
        return True
    try:
        source = pathlib.Path(source_cwd).resolve()
        destination = pathlib.Path(destination_cwd).resolve()
        if source == destination:
            return True
        source_owner_verified = bool(
            recorded_source_cwd
            and source == pathlib.Path(recorded_source_cwd).resolve()
        )
        if not source.exists():
            branch = prior_run.get("branch") if prior_run else None
            base_cwd = prior_run.get("base_cwd") if prior_run else None
            handoff_branch = getattr(services, "_handoff_branch_changes", None)
            if branch and base_cwd and handoff_branch is not None:
                if retained_branch_exists(services, base_cwd, branch) is False:
                    # The run row still names the branch, but Orcha already
                    # deleted it: a worker branch is only dropped once it holds
                    # no commits beyond origin/main, and a worktree is only
                    # retired once it is clean (or its uncommitted files were
                    # already forcibly discarded). Either way nothing recoverable
                    # remains, so a fresh run must start instead of failing the
                    # wake forever on a stale record.
                    return True
                return handoff_branch(
                    base_cwd,
                    branch,
                    str(destination),
                    owner_key=checkout_owner_key(
                        agent_id,
                        task_id=task_id,
                        conversation_id=conversation_id,
                        wake_kind=wake_kind,
                        lane=lane,
                    ),
                )
            # Disposable worktrees with no retained branch are expected to
            # disappear between ordinary same-mode wakes. Crossing from that
            # missing source into main is different: the prior file view cannot
            # be proven, so stop instead of silently dropping it.
            if prior_run and prior_run.get("worktree") and base_cwd:
                try:
                    return destination != pathlib.Path(base_cwd).resolve()
                except OSError:
                    return False
            return False
    except OSError:
        return False
    return services._handoff_worktree_changes(
        str(source),
        str(destination),
        owner_key=checkout_owner_key(
            agent_id,
            task_id=task_id,
            conversation_id=conversation_id,
            wake_kind=wake_kind,
            lane=lane,
        ),
        source_owner_verified=source_owner_verified,
    )
