"""Serialize checkout provisioning with confirmed project cleanup on the host."""
from __future__ import annotations

from contextlib import contextmanager
import fcntl
import functools
import hashlib
import os
from pathlib import Path
import time

from .job_store import JobStore, atomic_json, read_json, _private_directory, _sync_directory
from .worktree_cleanup_scan import CleanupError, checked_git, common_dir, identity


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


def record_provisioned(root, path, branch=None):
    """Reserve a checkout until its caller can publish live activity. Hold locked()."""
    atomic_json(lease_path(root, path), {"at": time.time(), "path": path})
    try:
        known = read_json(root / "known.json") if (root / "known.json").exists() else {}
        known[path] = {"identity": identity(path), "branch": branch,
                       "head": checked_git(path, "rev-parse", "HEAD")}
        atomic_json(root / "known.json", known)
    except (OSError, CleanupError):
        # Missing history prevents orphan cleanup, never provisioning.
        pass


def checkout_available(base, path):
    """Called under the lifecycle lock, before provisioning writes to this path."""
    store = JobStore(base)
    with store.locked():
        return not store.cleanup_retains(path)


@contextmanager
def cleanup_claim(base, path, owner):
    """Reserve only this checkout; slow I/O never holds either project-wide lock.

    A process crash leaves the durable claim. Only the same plan, holding its
    exclusive operation lock, can resume it. No age-based expiry permits reuse.
    """
    store = JobStore(base)
    claim = store.root / ('.cleanup-' + hashlib.sha256(str(Path(path).resolve()).encode()).hexdigest() + '.json')
    with locked(base), store.locked():
        if store.cleanup_retains(path, owner=owner) or store.retains_worktree(path):
            raise CleanupError("Another cleanup or managed command still needs this checkout")
        atomic_json(claim, {"path": str(Path(path).resolve()), "owner": owner})
    try:
        yield
    except BaseException as exc:
        if not isinstance(exc, Exception):
            raise  # Preserve the fence on interruption; the same plan recovers it.
        with store.locked():
            claim.unlink()
            _sync_directory(store.root)
        raise
    else:
        with store.locked():
            claim.unlink()
            _sync_directory(store.root)


def provisioning(fn):
    """Also reserve reused paths until the worker/session can publish its run."""
    @functools.wraps(fn)
    def wrapped(base_cwd, *args, **kwargs):
        if not base_cwd:
            return fn(base_cwd, *args, **kwargs)
        # Non-Git projects still use the original provisioning fallback.
        try:
            common_dir(base_cwd)
        except CleanupError:
            return fn(base_cwd, *args, **kwargs)
        with locked(base_cwd) as root:
            result = fn(base_cwd, *args, **kwargs)
            if result[0]:
                record_provisioned(root, result[0], result[1])
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
