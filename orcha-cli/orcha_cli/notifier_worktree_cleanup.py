"""Inspect, capture, and safely retire notifier-managed Git worktrees."""

from __future__ import annotations

import hashlib
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


def _replace_patch(cwd, current: str, desired: str, services: Any) -> bool:
    """Replace one complete checkout patch with another, restoring on failure."""
    if current.strip() and not _apply_patch(cwd, current, services, reverse=True):
        return False

    desired_applied = False
    if desired.strip():
        desired_applied = _apply_patch(cwd, desired, services)
        if not desired_applied:
            if current.strip():
                _apply_patch(cwd, current, services)
            return False

    reconciled = _full_patch(cwd, services)
    if reconciled == desired:
        return True

    if desired_applied:
        _apply_patch(cwd, desired, services, reverse=True)
    if current.strip():
        _apply_patch(cwd, current, services)
    return False


def _handoff_record_path(cwd, services: Any):
    """Return a checkout-specific record stored inside Git's private metadata."""
    return_code, common_dir = services._run_git(
        ["rev-parse", "--git-common-dir"], cwd=cwd
    )
    if return_code != 0 or not common_dir.strip():
        return None
    common_path = pathlib.Path(common_dir.strip())
    if not common_path.is_absolute():
        common_path = pathlib.Path(cwd) / common_path
    checkout_key = hashlib.sha256(
        str(pathlib.Path(cwd).resolve()).encode("utf-8")
    ).hexdigest()
    return (
        common_path.resolve() / "orcha" / "handoffs" / f"{checkout_key}.patch"
    )


def _read_handoff_record(cwd, services: Any):
    """Read the exact patch previously placed in this checkout by Orcha."""
    try:
        path = _handoff_record_path(cwd, services)
        return path.read_text() if path is not None and path.is_file() else None
    except OSError:
        return None


def _write_handoff_record(cwd, patch: str, services: Any) -> bool:
    """Atomically remember only the state Orcha owns in a destination checkout."""
    temporary = None
    try:
        path = _handoff_record_path(cwd, services)
        if path is None:
            return False
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        os.close(fd)
        pathlib.Path(temporary).write_text(patch)
        os.replace(temporary, path)
        temporary = None
        return True
    except OSError:
        return False
    finally:
        if temporary:
            try:
                pathlib.Path(temporary).unlink()
            except OSError:
                pass


def _is_linked_worktree(cwd) -> bool:
    """Return whether this is a dedicated linked worktree rather than main."""
    try:
        return pathlib.Path(cwd, ".git").is_file()
    except OSError:
        return False


def _replace_managed_patch(cwd, managed: str, desired: str, services: Any) -> bool:
    """Replace only Orcha-owned state while preserving independent destination work."""
    if managed.strip() and not _apply_patch(cwd, managed, services, reverse=True):
        return False

    if desired.strip() and not _apply_patch(cwd, desired, services):
        if managed.strip():
            _apply_patch(cwd, managed, services)
        return False

    if _write_handoff_record(cwd, desired, services):
        return True

    # A record is required before this state can be safely reconciled again.
    # Restore the original destination if persisting that ownership proof fails.
    if desired.strip():
        _apply_patch(cwd, desired, services, reverse=True)
    if managed.strip():
        _apply_patch(cwd, managed, services)
    return False


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
    worker branch and uncommitted files. A complete dry run must succeed before
    each patch operation touches the destination. On any conflict or I/O error,
    the caller can stop the replacement worker while leaving the source checkout
    intact.
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

    source_managed_patch = _read_handoff_record(source_cwd, services)
    if _is_linked_worktree(source_cwd) or source_managed_patch is not None:
        # Refresh ownership while this checkout is still the active source. In
        # particular, a clean first task -> main handoff establishes an empty
        # main record; after edits there, exporting back to the task worktree
        # must update that record so a later return can replace only those edits.
        if not _write_handoff_record(source_cwd, patch, services):
            return False

    managed_patch = _read_handoff_record(destination_cwd, services)
    if destination_patch == patch:
        # An identical clean checkout is safe to claim even without a previous
        # record. Linked task worktrees and already-managed destinations are
        # likewise known to belong to this handoff. Do not claim an otherwise
        # unknown dirty main checkout merely because its contents happen to
        # match the source.
        can_manage_destination = (
            not destination_patch.strip()
            or _is_linked_worktree(destination_cwd)
            or managed_patch is not None
        )
        if can_manage_destination and not _write_handoff_record(
            destination_cwd, patch, services
        ):
            return False
        return True

    if managed_patch is None:
        # An unrecorded dirty destination may contain human or another worker's
        # work. There is no safe way to tell that apart from stale task state, so
        # stop without modifying either checkout. A clean destination is safe.
        if destination_patch.strip():
            return False
        transferred = _replace_patch(
            destination_cwd, destination_patch, patch, services
        )
        if not transferred:
            return False
        if not _write_handoff_record(destination_cwd, patch, services):
            if patch.strip():
                _apply_patch(destination_cwd, patch, services, reverse=True)
            return False
    else:
        # The checkout may have been cleaned or recreated since the last handoff.
        # A clean destination is safe regardless of a stale private record.
        if not destination_patch.strip():
            managed_patch = ""
        transferred = _replace_managed_patch(
            destination_cwd, managed_patch, patch, services
        )
        if not transferred:
            return False

    return True


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
