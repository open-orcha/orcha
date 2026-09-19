"""Inspect, capture, and safely retire notifier-managed Git worktrees."""

from __future__ import annotations

import os
import pathlib
import tempfile
from typing import Any

DIFF_EXCLUDES = (
    ".",
    ":(exclude).claude/orcha.json",
    ":(exclude).claude/orcha-tabs",
    ":(exclude).claude/settings.json",
)


def _full_patch(cwd, services: Any):
    """Return the checkout's complete binary-safe patch from ``origin/main``."""
    add_code, _ = services._run_git(
        ["add", "-A", "-N", "--", *DIFF_EXCLUDES], cwd=cwd
    )
    if add_code != 0:
        return None
    return_code, patch = services._run_git(
        ["diff", "--binary", "--full-index", "origin/main", "--", *DIFF_EXCLUDES],
        cwd=cwd,
        timeout=60,
    )
    return patch if return_code == 0 else None


def _apply_patch(cwd, patch: str, services: Any, *, reverse: bool = False) -> bool:
    """Apply a patch only after Git confirms the complete operation is safe."""
    patch_path = None
    try:
        fd, patch_path = tempfile.mkstemp(
            prefix="orcha-checkout-handoff-", suffix=".patch"
        )
        os.close(fd)
        pathlib.Path(patch_path).write_text(patch)
        arguments = ["apply", "--check"]
        if not reverse:
            arguments.append("--3way")
        if reverse:
            arguments.append("--reverse")
        arguments.append(patch_path)
        check_code, _ = services._run_git(arguments, cwd=cwd, timeout=60)
        if check_code != 0:
            return False
        arguments.remove("--check")
        apply_code, _ = services._run_git(arguments, cwd=cwd, timeout=60)
        return apply_code == 0
    except OSError:
        return False
    finally:
        if patch_path:
            try:
                pathlib.Path(patch_path).unlink()
            except OSError:
                pass


def capture_diff(worktree, services: Any, cap: int = 200_000):
    """Return the worker's net diff from main, including untracked files."""
    if not worktree:
        return None
    services._run_git(["add", "-A", "-N", "--", *DIFF_EXCLUDES], cwd=worktree)
    return_code, output = services._run_git(
        ["diff", "origin/main", "--", *DIFF_EXCLUDES], cwd=worktree
    )
    if return_code != 0:
        return None
    if len(output) > cap:
        output = output[:cap] + "\n...[diff truncated]..."
    return output


def handoff_changes(source_cwd, destination_cwd, services: Any) -> bool:
    """Carry a worker's complete in-progress state into a newly selected checkout.

    The patch is based on ``origin/main`` so it includes both commits made on a
    worker branch and uncommitted files. A three-way dry run must succeed before
    the destination is touched. On any conflict or I/O error the caller can stop
    the replacement worker while leaving the source checkout intact.
    """
    if not source_cwd or not destination_cwd:
        return False
    try:
        source_path = pathlib.Path(source_cwd).resolve()
        destination_path = pathlib.Path(destination_cwd).resolve()
        if source_path == destination_path:
            return True
    except OSError:
        return False

    patch = _full_patch(source_cwd, services)
    if patch is None:
        return False

    # A durable task worktree can be selected again after an off -> on toggle.
    # The previous handoff may already have copied this complete file view there;
    # treat that exact state as success instead of trying to apply it twice.
    destination_patch = _full_patch(destination_cwd, services)
    if destination_patch is None:
        return False
    if destination_patch == patch:
        return True

    # If the active checkout is now clean, the worker intentionally removed all
    # prior task changes. Reverse the preserved destination patch so those stale
    # files cannot reappear when the durable task worktree is selected again.
    if not patch.strip():
        return _apply_patch(
            destination_cwd, destination_patch, services, reverse=True
        )

    return _apply_patch(destination_cwd, patch, services)


def branch_commit_count(base_cwd, branch, services: Any) -> int:
    """Count commits retained by a worker branch beyond origin/main."""
    if not branch:
        return 0
    return_code, output = services._run_git(
        ["rev-list", "--count", f"origin/main..{branch}"], cwd=base_cwd
    )
    return (
        int(output.strip())
        if return_code == 0 and output.strip().isdigit()
        else 0
    )


def teardown_worktree(base_cwd, worktree, branch, services: Any) -> None:
    """Remove a worktree while retaining any branch with committed work."""
    if not worktree:
        return
    has_commits = branch_commit_count(base_cwd, branch, services) > 0
    services._run_git(
        ["worktree", "remove", "--force", worktree], cwd=base_cwd
    )
    if branch and not has_commits:
        services._run_git(["branch", "-D", branch], cwd=base_cwd)


def is_git_repo(cwd, services: Any) -> bool:
    """Return whether a path belongs to a Git worktree."""
    return bool(cwd) and services._run_git(
        ["rev-parse", "--git-dir"], cwd=cwd
    )[0] == 0


def worktree_is_dirty(worktree, services: Any, excludes=None) -> bool:
    """Return whether a worktree has staged, unstaged, or untracked changes."""
    if not worktree:
        return False
    arguments = ["status", "--porcelain"]
    if excludes:
        arguments.extend(["--", *excludes])
    return_code, output = services._run_git(arguments, cwd=worktree)
    return return_code == 0 and bool(output.strip())


def safe_teardown_worktree(base_cwd, worktree, branch, services: Any) -> str:
    """Retire a clean worktree without ever discarding uncommitted work."""
    if not worktree:
        return "noop"
    if services._worktree_is_dirty(worktree):
        return "preserved-dirty"
    services._teardown_worktree(base_cwd, worktree, branch)
    return "removed"
