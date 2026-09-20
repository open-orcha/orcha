"""Carry saved checkout state across project worktree-routing changes."""

from __future__ import annotations

import pathlib


def previous_checkout(
    api_base,
    agent_id,
    services,
    *,
    task_id=None,
    conversation_id=None,
    wake_kind=None,
):
    """Return the newest recorded checkout for the same logical stream of work."""
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
        checkout = run.get("worktree") or run.get("base_cwd")
        if checkout:
            return checkout
    return None


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
):
    """Move the prior file view into ``destination_cwd`` before a new run starts.

    A missing prior checkout means there is no recorded state to carry. A recorded
    path that no longer exists was already cleaned up, so it likewise contributes
    no file state. All actual two-checkout transfers use the ownership-aware
    handoff and fail closed on conflicts.
    """
    source_cwd = source_cwd or previous_checkout(
        api_base,
        agent_id,
        services,
        task_id=task_id,
        conversation_id=conversation_id,
        wake_kind=wake_kind,
    )
    if not source_cwd or not destination_cwd:
        return True
    try:
        source = pathlib.Path(source_cwd).resolve()
        destination = pathlib.Path(destination_cwd).resolve()
        if source == destination or not source.exists():
            return True
    except OSError:
        return False
    return services._handoff_worktree_changes(str(source), str(destination))
