"""Inspect, capture, and safely retire notifier-managed Git worktrees."""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import tempfile
from typing import Any

DIFF_EXCLUDES = (
    ".",
    ":(exclude).claude/orcha.json",
    ":(exclude).claude/orcha-tabs",
    ":(exclude).claude/settings.json",
    ":(exclude).claude/commands/orcha-*.md",
    ":(exclude).agents/skills/orcha-*",
)


def _full_patch(cwd, services: Any, *, include_ignored: bool = False):
    """Return the complete binary-safe patch without changing the checkout index."""
    return_code, tracked = services._run_git(
        ["diff", "--binary", "--full-index", "origin/main", "--", *DIFF_EXCLUDES],
        cwd=cwd,
        timeout=60,
    )
    if return_code != 0:
        return None

    # ``git diff`` deliberately omits ordinary untracked files.  Diff each one
    # against /dev/null rather than using ``git add -N``: intent-to-add mutates
    # the real index and made even a rejected handoff observably change a human
    # checkout.  NUL separation preserves unusual but valid path names.
    untracked_commands = [
        ["ls-files", "--others", "--exclude-standard", "-z", "--", *DIFF_EXCLUDES]
    ]
    if include_ignored:
        untracked_commands.append(
            [
                "ls-files",
                "--others",
                "--ignored",
                "--exclude-standard",
                "-z",
                "--",
                *DIFF_EXCLUDES,
            ]
        )

    patches = [tracked]
    untracked_paths = []
    seen_paths = set()
    for command in untracked_commands:
        untracked_code, untracked = services._run_git(
            command, cwd=cwd, timeout=60
        )
        if untracked_code != 0:
            return None
        for relative_path in filter(None, untracked.split("\0")):
            if relative_path not in seen_paths:
                seen_paths.add(relative_path)
                untracked_paths.append(relative_path)

    for relative_path in untracked_paths:
        file_code, file_patch = services._run_git(
            [
                "diff",
                "--no-index",
                "--binary",
                "--full-index",
                "--",
                "/dev/null",
                relative_path,
            ],
            cwd=cwd,
            timeout=60,
        )
        # --no-index uses 1 for the expected "files differ" result.
        if file_code not in (0, 1):
            return None
        patches.append(file_patch)
    return "".join(patches)


def _branch_patch(base_cwd, branch: str, services: Any):
    """Return committed branch state relative to main without a checked-out tree."""
    if not branch or not branch.startswith("orcha/"):
        return None
    ref = f"refs/heads/{branch}"
    verify_code, _ = services._run_git(
        ["show-ref", "--verify", "--quiet", ref], cwd=base_cwd, timeout=60
    )
    if verify_code != 0:
        return None
    return_code, patch = services._run_git(
        [
            "diff",
            "--binary",
            "--full-index",
            "origin/main",
            ref,
            "--",
            *DIFF_EXCLUDES,
        ],
        cwd=base_cwd,
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

    reconciled = _full_patch(cwd, services, include_ignored=True)
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
    """Read the stream owner and exact patch previously placed by Orcha."""
    try:
        path = _handoff_record_path(cwd, services)
        if path is None or not path.is_file():
            return None
        raw = path.read_text()
        try:
            record = json.loads(raw)
        except json.JSONDecodeError:
            # Records written before ownership scoping contained only a patch.
            # Treat them as unowned so dirty state fails closed instead of being
            # attributed to whichever stream happens to arrive next.
            return {"owner_key": None, "patch": raw}
        if not isinstance(record, dict) or not isinstance(record.get("patch"), str):
            return None
        return {
            "owner_key": record.get("owner_key"),
            "patch": record["patch"],
        }
    except (OSError, UnicodeError):
        return None


def _write_handoff_record(cwd, owner_key: str, patch: str, services: Any) -> bool:
    """Atomically remember the stream and state Orcha owns in a checkout."""
    temporary = None
    try:
        path = _handoff_record_path(cwd, services)
        if path is None:
            return False
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        os.close(fd)
        pathlib.Path(temporary).write_text(
            json.dumps(
                {"version": 2, "owner_key": owner_key, "patch": patch},
                separators=(",", ":"),
            )
        )
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


def _replace_managed_patch(
    cwd, managed: str, desired: str, owner_key: str, services: Any
) -> bool:
    """Replace only Orcha-owned state while preserving independent destination work."""
    if managed.strip() and not _apply_patch(cwd, managed, services, reverse=True):
        return False

    if desired.strip() and not _apply_patch(cwd, desired, services):
        if managed.strip():
            _apply_patch(cwd, managed, services)
        return False

    if _write_handoff_record(cwd, owner_key, desired, services):
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
    output = _full_patch(worktree, services)
    if output is None:
        return None
    if len(output) > cap:
        output = output[:cap] + "\n...[diff truncated]..."
    return output


def _place_handoff_patch(
    destination_cwd, patch: str, owner_key: str, services: Any
) -> bool:
    """Safely reconcile one known stream's patch into its destination checkout."""
    destination_patch = _full_patch(
        destination_cwd, services, include_ignored=True
    )
    if destination_patch is None:
        return False

    destination_record = _read_handoff_record(destination_cwd, services)
    if (
        destination_record is not None
        and destination_record.get("owner_key") != owner_key
        and destination_patch.strip()
    ):
        return False
    managed_patch = (
        destination_record.get("patch")
        if destination_record is not None
        and destination_record.get("owner_key") == owner_key
        else None
    )
    if destination_patch == patch:
        can_manage_destination = (
            not destination_patch.strip()
            or _is_linked_worktree(destination_cwd)
            or managed_patch is not None
        )
        return not can_manage_destination or _write_handoff_record(
            destination_cwd, owner_key, patch, services
        )

    if managed_patch is None:
        if destination_patch.strip():
            return False
        transferred = _replace_patch(
            destination_cwd, destination_patch, patch, services
        )
        if not transferred:
            return False
        if not _write_handoff_record(destination_cwd, owner_key, patch, services):
            if patch.strip():
                _apply_patch(destination_cwd, patch, services, reverse=True)
            return False
    else:
        if not destination_patch.strip():
            managed_patch = ""
        if not _replace_managed_patch(
            destination_cwd, managed_patch, patch, owner_key, services
        ):
            return False
    return True


def handoff_changes(
    source_cwd, destination_cwd, services: Any, *, owner_key: str | None = None
) -> bool:
    """Carry a worker's complete in-progress state into a newly selected checkout.

    The patch is based on ``origin/main`` so it includes both commits made on a
    worker branch and uncommitted files. A complete dry run must succeed before
    each patch operation touches the destination. On any conflict or I/O error,
    the caller can stop the replacement worker while leaving the source checkout
    intact.
    """
    if not source_cwd or not destination_cwd:
        return False
    owner_key = owner_key or "legacy-unscoped"
    try:
        source_path = pathlib.Path(source_cwd).resolve()
        destination_path = pathlib.Path(destination_cwd).resolve()
        if source_path == destination_path:
            return True
    except OSError:
        return False

    patch = _full_patch(source_cwd, services, include_ignored=True)
    if patch is None:
        return False

    # A durable task worktree can be selected again after an off -> on toggle.
    # The previous handoff may already have copied this complete file view there;
    # treat that exact state as success instead of trying to apply it twice.
    source_record = _read_handoff_record(source_cwd, services)
    if source_record is not None and source_record.get("owner_key") != owner_key:
        # A shared checkout still belongs to another task/conversation/terminal.
        # Never relabel and export its state as though the arriving stream made it.
        return False
    if (
        _is_linked_worktree(source_cwd) or source_record is not None
    ) and not _write_handoff_record(source_cwd, owner_key, patch, services):
        # Refresh ownership while this checkout is still the active source. In
        # particular, a clean first task -> main handoff establishes an empty
        # main record; after edits there, exporting back to the task worktree
        # must update that record so a later return can replace only those edits.
        return False

    return _place_handoff_patch(destination_cwd, patch, owner_key, services)


def handoff_branch_changes(
    base_cwd,
    branch,
    destination_cwd,
    services: Any,
    *,
    owner_key: str | None = None,
) -> bool:
    """Carry committed state from a retained worker branch after its worktree is gone."""
    if not base_cwd or not branch or not destination_cwd:
        return False
    patch = _branch_patch(base_cwd, branch, services)
    if patch is None:
        return False
    return _place_handoff_patch(
        destination_cwd, patch, owner_key or "legacy-unscoped", services
    )


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
    """Return whether a worktree has changes or cannot be inspected safely."""
    if not worktree:
        return False
    arguments = ["status", "--porcelain", "--ignored", "--untracked-files=all"]
    if excludes:
        arguments.extend(["--", *excludes])
    return_code, output = services._run_git(arguments, cwd=worktree)
    return return_code != 0 or bool(output.strip())


def safe_teardown_worktree(base_cwd, worktree, branch, services: Any) -> str:
    """Retire a clean worktree without ever discarding uncommitted work."""
    if not worktree:
        return "noop"
    if services._worktree_is_dirty(worktree, excludes=DIFF_EXCLUDES):
        return "preserved-dirty"
    services._teardown_worktree(base_cwd, worktree, branch)
    return "removed"
