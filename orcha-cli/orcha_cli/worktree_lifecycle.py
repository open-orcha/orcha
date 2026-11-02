"""Serialize checkout provisioning with confirmed project cleanup on the host."""
from __future__ import annotations

from contextlib import contextmanager
import fcntl
import functools
import hashlib
import os
from pathlib import Path
import time

from .job_store import atomic_json, read_json, _private_directory
from .worktree_cleanup_scan import common_dir, identity


@contextmanager
def locked(base):
    root = common_dir(base) / "orcha" / "worktree-cleanup"
    _private_directory(root.parent)
    _private_directory(root)
    fd = os.open(root / "lifecycle.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield root
    finally:
        os.close(fd)


def lease_path(root, path):
    return root / ("lease-" + hashlib.sha256(str(Path(path).resolve()).encode()).hexdigest() + ".json")


def recently_provisioned(root, path):
    p = lease_path(root, path)
    if not p.exists():
        return False
    try:
        lease = read_json(p)
        return time.time() - lease["at"] < 900
    except (OSError, ValueError, KeyError):
        return True


def provisioning(fn):
    """Also reserve reused paths until the worker/session can publish its run."""
    @functools.wraps(fn)
    def wrapped(base_cwd, *args, **kwargs):
        if not base_cwd:
            return fn(base_cwd, *args, **kwargs)
        # Non-Git projects still use the original provisioning fallback.
        from .worktree_cleanup_scan import CleanupError
        try:
            common_dir(base_cwd)
        except CleanupError:
            return fn(base_cwd, *args, **kwargs)
        with locked(base_cwd) as root:
            result = fn(base_cwd, *args, **kwargs)
            if result[0]:
                atomic_json(lease_path(root, result[0]), {"at": time.time(), "path": result[0]})
                try:
                    known = read_json(root / "known.json") if (root / "known.json").exists() else {}
                    from .worktree_cleanup_scan import checked_git
                    known[result[0]] = {"identity": identity(result[0]), "branch": result[1],
                                       "head": checked_git(result[0], "rev-parse", "HEAD")}
                    atomic_json(root / "known.json", known)
                except (OSError, CleanupError):
                    # Missing history prevents orphan cleanup, never provisioning.
                    pass
            return result
    return wrapped


@contextmanager
def operation(base, plan_id):
    """One writer per operation; status reads atomic snapshots without waiting."""
    from uuid import UUID
    from .worktree_cleanup_scan import CleanupError
    with locked(base) as root:
        fd = os.open(root / (str(UUID(plan_id)) + ".lock"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise CleanupError("This cleanup operation is already running; check its status") from None
        yield
    finally:
        os.close(fd)
