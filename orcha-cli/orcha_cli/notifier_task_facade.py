"""Preserve durable task-checkpoint behavior for notifier callers."""

from __future__ import annotations

import sys


def _checkpoint_task_worktree(
    base_cwd, worktree, branch, task_id, run_id
):
    """Commit dirty durable task work locally without pushing it."""
    if not worktree:
        return None
    compat = sys.modules["orcha_cli.notifier"]
    excludes = compat._DIFF_EXCLUDES
    compat._run_git(["add", "-A", "--", *excludes], cwd=worktree)
    return_code, staged = compat._run_git(
        ["diff", "--cached", "--name-only", "--", *excludes],
        cwd=worktree,
    )
    if return_code != 0 or not staged.strip():
        return None
    message = (
        f"orcha: checkpoint task {task_id or '?'} run {run_id or '?'}"
    )
    return_code, _ = compat._run_git(
        [
            "-c",
            "user.email=orcha@localhost",
            "-c",
            "user.name=orcha",
            "commit",
            "-m",
            message,
        ],
        cwd=worktree,
    )
    if return_code != 0:
        return None
    return_code, sha = compat._run_git(
        ["rev-parse", "--short", "HEAD"], cwd=worktree
    )
    return sha.strip() if return_code == 0 and sha.strip() else None
