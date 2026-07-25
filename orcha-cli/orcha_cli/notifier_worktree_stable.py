"""Provision stable resident, live-terminal, and per-task Git worktrees."""

from __future__ import annotations

import pathlib
from typing import Any


def _stable_worktree(base_cwd, key, kind: str, services: Any):
    """Create or reuse a stable worktree, including a surviving local branch."""
    if (
        not base_cwd
        or services._run_git(["rev-parse", "--git-dir"], cwd=base_cwd)[0] != 0
    ):
        return None, None
    base = pathlib.Path(base_cwd)
    services._ensure_worktree_exclude(base_cwd)
    slug = services._safe_ref(key)
    branch = f"orcha/{kind}-{slug}"
    worktree = base / ".orcha-worktrees" / f"{kind}-{slug}"
    if worktree.exists():
        return str(worktree), branch
    services._run_git(["fetch", "origin", "main"], cwd=base_cwd, timeout=60)
    return_code, _ = services._run_git(
        ["worktree", "add", "-b", branch, str(worktree), "origin/main"],
        cwd=base_cwd,
        timeout=60,
    )
    if return_code != 0:
        return_code, _ = services._run_git(
            ["worktree", "add", str(worktree), branch],
            cwd=base_cwd,
            timeout=60,
        )
        if return_code != 0:
            return None, None
    services._overlay_runtime_config(base, worktree)
    return str(worktree), branch


def provision_resident(base_cwd, conversation_id, services: Any):
    """Create or reuse the stable worktree required by session resume."""
    return _stable_worktree(base_cwd, conversation_id, "resident", services)


def provision_live(base_cwd, alias, services: Any):
    """Create or reuse a live-terminal worktree so reconnects retain edits."""
    return _stable_worktree(base_cwd, alias, "live", services)


def provision_task(base_cwd, alias, task_id, services: Any):
    """Create or reattach the durable branch for one agent and task."""
    if (
        not base_cwd
        or not task_id
        or services._run_git(["rev-parse", "--git-dir"], cwd=base_cwd)[0] != 0
    ):
        return None, None
    base = pathlib.Path(base_cwd)
    services._ensure_worktree_exclude(base_cwd)
    slug = f"{services._safe_ref(alias)}-{services._safe_ref(task_id)[:12]}"
    branch = f"orcha/task-{slug}"
    worktree = base / ".orcha-worktrees" / f"task-{slug}"
    if worktree.exists():
        return_code, _ = services._run_git(
            ["-C", str(worktree), "rev-parse", "--git-dir"], cwd=base_cwd
        )
        if return_code == 0:
            return str(worktree), branch
    services._run_git(["worktree", "prune"], cwd=base_cwd)
    local_code, _ = services._run_git(
        ["rev-parse", "--verify", "--quiet", f"refs/heads/{branch}"],
        cwd=base_cwd,
    )
    remote_code, _ = services._run_git(
        [
            "rev-parse",
            "--verify",
            "--quiet",
            f"refs/remotes/origin/{branch}",
        ],
        cwd=base_cwd,
    )
    if local_code == 0:
        return_code, _ = services._run_git(
            ["worktree", "add", str(worktree), branch],
            cwd=base_cwd,
            timeout=60,
        )
    elif remote_code == 0:
        return_code, _ = services._run_git(
            [
                "worktree",
                "add",
                "-b",
                branch,
                str(worktree),
                f"origin/{branch}",
            ],
            cwd=base_cwd,
            timeout=60,
        )
    else:
        services._run_git(["fetch", "origin", "main"], cwd=base_cwd, timeout=60)
        return_code, _ = services._run_git(
            [
                "worktree",
                "add",
                "-b",
                branch,
                str(worktree),
                "origin/main",
            ],
            cwd=base_cwd,
            timeout=60,
        )
    if return_code != 0:
        return None, None
    services._overlay_runtime_config(base, worktree)
    return str(worktree), branch
