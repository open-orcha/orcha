"""Inspect, capture, and safely retire notifier-managed Git worktrees."""

from __future__ import annotations

import os
import pathlib
import subprocess
import tempfile
from typing import Any

DIFF_EXCLUDES = (
    ".",
    ":(exclude).claude/orcha.json",
    ":(exclude).claude/orcha-tabs",
    ":(exclude).claude/settings.json",
)


def _snapshot_ref_name(run_id) -> str | None:
    if not run_id:
        return None
    safe_run_id = "".join(
        character
        for character in str(run_id).lower()
        if character.isalnum() or character == "-"
    )
    return f"refs/orcha/run-snapshots/{safe_run_id}" if safe_run_id else None


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


def existing_snapshot_ref(worktree, run_id, services: Any) -> str | None:
    """Return a run's already-frozen snapshot without creating one."""
    ref_name = _snapshot_ref_name(run_id)
    if not worktree or not ref_name:
        return None
    return_code, output = services._run_git(
        ["rev-parse", "--verify", ref_name], cwd=worktree
    )
    snapshot_ref = output.strip()
    return (
        snapshot_ref
        if return_code == 0 and len(snapshot_ref) == 40
        else None
    )


def capture_snapshot_diff(
    worktree, snapshot_ref, services: Any, cap: int = 200_000
):
    """Return the diff represented by an immutable run snapshot."""
    if not worktree or not snapshot_ref:
        return None
    return_code, output = services._run_git(
        ["diff", "origin/main", snapshot_ref, "--", *DIFF_EXCLUDES],
        cwd=worktree,
    )
    if return_code != 0:
        return None
    if len(output) > cap:
        output = output[:cap] + "\n...[diff truncated]..."
    return output


def capture_snapshot(worktree, run_id) -> str | None:
    """Freeze the run's exact visible files in an immutable Git commit.

    The temporary index starts at ``HEAD`` and stages the working-tree contents
    without touching the worker's real index. Runtime-only Orcha files are kept
    at their committed versions, matching ``capture_diff``'s exclusions. A
    private ref keeps the otherwise-unreachable snapshot alive across ``git gc``.
    """
    if not worktree or not run_id:
        return None
    worktree_path = pathlib.Path(worktree)
    if not worktree_path.is_dir():
        return None
    ref_name = _snapshot_ref_name(run_id)
    if not ref_name:
        return None
    index_fd = None
    index_path = None
    try:
        index_fd, index_path = tempfile.mkstemp(prefix="orcha-run-index-")
        os.close(index_fd)
        index_fd = None
        os.unlink(index_path)
        env = os.environ.copy()
        env["GIT_INDEX_FILE"] = index_path

        def git(arguments):
            return subprocess.run(
                ["git", *arguments],
                cwd=str(worktree_path),
                env=env,
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )

        existing = git(["rev-parse", "--verify", ref_name])
        existing_ref = existing.stdout.strip()
        if existing.returncode == 0 and len(existing_ref) == 40:
            return existing_ref
        if git(["read-tree", "HEAD"]).returncode != 0:
            return None
        if git(["add", "-A", "--", *DIFF_EXCLUDES]).returncode != 0:
            return None
        tree = git(["write-tree"])
        tree_sha = tree.stdout.strip()
        if tree.returncode != 0 or not tree_sha:
            return None
        commit = git(
            [
                "-c",
                "user.name=Orcha",
                "-c",
                "user.email=orcha@localhost",
                "commit-tree",
                tree_sha,
                "-p",
                "HEAD",
                "-m",
                f"Orcha run snapshot {run_id}",
            ]
        )
        snapshot_ref = commit.stdout.strip()
        if commit.returncode != 0 or len(snapshot_ref) != 40:
            return None
        kept = git(
            ["update-ref", ref_name, snapshot_ref, "0" * 40]
        )
        if kept.returncode == 0:
            return snapshot_ref
        # A concurrent retry may have won the create-only update. Its commit is
        # the immutable value for this run; never replace it with ours.
        winner = git(["rev-parse", "--verify", ref_name])
        winner_ref = winner.stdout.strip()
        return winner_ref if winner.returncode == 0 and len(winner_ref) == 40 else None
    except (OSError, subprocess.SubprocessError):
        return None
    finally:
        if index_fd is not None:
            os.close(index_fd)
        if index_path:
            try:
                os.unlink(index_path)
            except OSError:
                pass


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
