"""Preserve task-worker branches and publish resumable continuity pointers."""

from __future__ import annotations


def saved_ref(worker, checkpoint_sha, diff, services) -> dict:
    """Describe the durable branch and worktree that contain a worker's work."""
    branch = worker.get("branch")
    commit_count = services._branch_commit_count(worker.get("base_cwd"), branch)
    return {
        "branch": branch,
        "worktree": worker.get("worktree"),
        "checkpoint_sha": checkpoint_sha,
        "has_commits": bool(checkpoint_sha) or commit_count > 0,
        "patch_captured": bool((diff or "").strip()),
    }


def saved_human_line(base_cwd, branch, sha, services) -> str:
    """Explain where work was saved without exposing implementation identifiers."""
    if sha:
        return f"work saved on branch {branch} (checkpoint {sha})"
    if services._branch_commit_count(base_cwd, branch) > 0:
        return f"work saved on branch {branch} (committed on the branch, preserved)"
    return f"work saved on branch {branch} (uncommitted, preserved)"


def reclaim_task_worktree(base_cwd, worktree, branch, services) -> str:
    """Remove a clean terminal-task worktree while preserving dirty work."""
    if not worktree:
        return "noop"
    if services._worktree_is_dirty(worktree, excludes=services._DIFF_EXCLUDES):
        return "preserved-dirty"
    services._teardown_worktree(base_cwd, worktree, branch)
    return "removed"


def record_task_saved_ref(api_base, worker, saved, human_line, services) -> None:
    """Post a plain-language saved-work pointer to the task thread."""
    task_id = (worker.get("respawn_ctx") or {}).get("task_id")
    agent_id = worker.get("agent_id")
    if not (task_id and agent_id and human_line):
        return
    services._post_json(
        f"{api_base}/api/tasks/{task_id}/messages",
        {"author_agent_id": agent_id, "body": human_line},
    )


def synthesize_task_digest(
    api_base,
    agent_id,
    task_id,
    saved,
    run_started_ts,
    human_line,
    services,
) -> None:
    """Publish resume context unless the agent already wrote a newer digest."""
    if not (agent_id and task_id):
        return
    existing = services._get_json(f"{api_base}/api/agents/{agent_id}/digest")
    digest = (existing or {}).get("digest")
    if digest and run_started_ts and (digest.get("snapshot_ts") or 0) > run_started_ts:
        return
    branch = saved.get("branch")
    focus = (human_line or "work in progress on the current task")[:400]
    services._post_json(
        f"{api_base}/api/agents/{agent_id}/digest",
        {
            "current_focus": focus,
            "open_threads": [
                {
                    "text": (
                        f"Resume task {task_id}: work is saved on branch "
                        f"{branch or '(none)'}; reuse that worktree/branch "
                        "instead of starting fresh from origin/main."
                    )
                }
            ],
        },
    )
