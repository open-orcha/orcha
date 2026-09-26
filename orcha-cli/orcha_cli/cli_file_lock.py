"""Serialise same-file edits between agents that share one checkout.

When a project disables worktrees, several agents (and the human) edit the same
working tree. Claude Code's ``Edit``/``Write`` tools read, modify, and write a
file in one step; two agents doing that to the same file at the same moment
clobber each other. ``orcha file-guard`` runs as a ``PreToolUse`` hook that
takes a per-file lock before an edit tool runs and as a ``PostToolUse`` /
``SessionEnd`` hook that releases it. A waiting agent blocks in the hook until
the holder releases the file (or the lock goes stale), so the same file is
never edited by two agents at once. Unrelated files never wait on each other.

Locks live under the repository's git common dir (``.git/orcha/file-locks``)
so they never enter the working tree, a patch, or a handoff, and every linked
worktree of the repository shares one namespace keyed by resolved absolute
path. Outside a git repository the locks fall back to
``<project>/.claude/.orcha-file-locks``.

Every failure inside the guard fails OPEN: a broken lock directory must never
stop an agent from working. Only a lock held by another session past the wait
budget denies the edit, with a reason that tells the agent to retry.
"""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import subprocess
import time
from typing import Any, Callable, Optional

EDIT_TOOLS = frozenset({"Edit", "Write", "MultiEdit", "NotebookEdit"})
PATH_KEYS = ("file_path", "notebook_path", "path")
LOCK_SUBDIR = ("orcha", "file-locks")
FALLBACK_SUBDIR = (".claude", ".orcha-file-locks")
RELEASE_EVENTS = frozenset({"SessionEnd", "Stop"})

DEFAULT_WAIT_SECS = 600.0
DEFAULT_STALE_SECS = 120.0
POLL_SECS = 0.25


def enabled() -> bool:
    """Return whether the guard is active (``ORCHA_FILE_LOCK=0`` disables it)."""
    return os.environ.get("ORCHA_FILE_LOCK", "1").strip().lower() not in (
        "0",
        "false",
        "no",
        "off",
    )


def _float_env(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name, "") or default)
    except ValueError:
        return default
    return value if value >= 0 else default


def wait_secs() -> float:
    """Seconds an agent waits for another agent's lock before its edit is denied."""
    return _float_env("ORCHA_FILE_LOCK_WAIT_SECS", DEFAULT_WAIT_SECS)


def stale_secs() -> float:
    """Age after which a lock is treated as abandoned by a crashed session."""
    return _float_env("ORCHA_FILE_LOCK_STALE_SECS", DEFAULT_STALE_SECS)


def lock_root(project_cwd) -> pathlib.Path:
    """Return the lock namespace for the checkout that contains ``project_cwd``."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--git-common-dir"],
            cwd=project_cwd,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        result = None
    if result is not None and result.returncode == 0 and result.stdout.strip():
        git_dir = result.stdout.strip()
        base = (
            pathlib.Path(git_dir)
            if os.path.isabs(git_dir)
            else pathlib.Path(project_cwd, git_dir)
        )
        return base.joinpath(*LOCK_SUBDIR)
    return pathlib.Path(project_cwd).joinpath(*FALLBACK_SUBDIR)


def edited_paths(tool_name: str, tool_input: Any) -> list[str]:
    """Return the file an edit tool is about to touch (empty for other tools)."""
    if tool_name not in EDIT_TOOLS or not isinstance(tool_input, dict):
        return []
    for key in PATH_KEYS:
        value = tool_input.get(key)
        if isinstance(value, str) and value.strip():
            return [value]
    return []


def _resolve(file_path: str, project_cwd) -> str:
    absolute = pathlib.Path(file_path)
    if not absolute.is_absolute():
        absolute = pathlib.Path(project_cwd, file_path)
    try:
        return str(absolute.resolve())
    except OSError:
        return str(absolute)


def _lock_path(root: pathlib.Path, resolved: str) -> pathlib.Path:
    digest = hashlib.sha1(resolved.encode("utf-8", "surrogateescape")).hexdigest()
    return root / f"{digest}.json"


def _read(lock_path: pathlib.Path) -> Optional[dict]:
    try:
        record = json.loads(lock_path.read_text())
    except (OSError, ValueError):
        return None
    return record if isinstance(record, dict) else None


def _inode(lock_path: pathlib.Path):
    try:
        return lock_path.stat().st_ino
    except OSError:
        return None


class FileLock:
    """Per-session handle on the shared per-file lock namespace."""

    def __init__(
        self,
        root: pathlib.Path,
        owner: str,
        *,
        alias: Optional[str] = None,
        pid: Optional[int] = None,
    ) -> None:
        self.root = pathlib.Path(root)
        self.owner = owner
        self.alias = alias
        self.pid = pid

    def _record(self, resolved: str, now: float) -> dict:
        return {
            "path": resolved,
            "owner": self.owner,
            "alias": self.alias,
            "pid": self.pid,
            "acquired_at": now,
        }

    def _write(self, lock_path: pathlib.Path, record: dict) -> bool:
        """Atomically replace a lock this session already holds (refresh)."""
        temporary = lock_path.with_name(f".{lock_path.name}.{os.getpid()}.tmp")
        try:
            temporary.write_text(json.dumps(record))
            os.replace(temporary, lock_path)
            return True
        except OSError:
            try:
                temporary.unlink()
            except OSError:
                pass
            return False

    def acquire(
        self,
        file_path: str,
        project_cwd,
        *,
        wait: float,
        stale: float,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.time,
    ) -> tuple[bool, Optional[dict]]:
        """Block until this session holds ``file_path``; return (held, blocking holder)."""
        resolved = _resolve(file_path, project_cwd)
        lock_path = _lock_path(self.root, resolved)
        self.root.mkdir(parents=True, exist_ok=True)
        deadline = clock() + wait
        while True:
            now = clock()
            try:
                fd = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
            except FileExistsError:
                fd = None
            if fd is not None:
                with os.fdopen(fd, "w") as handle:
                    json.dump(self._record(resolved, now), handle)
                return True, None

            inode = _inode(lock_path)
            holder = _read(lock_path)
            if holder is not None and holder.get("owner") == self.owner:
                # Re-entrant: refresh our own lock without ever dropping it.
                self._write(lock_path, self._record(resolved, now))
                return True, None
            acquired_at = holder.get("acquired_at") if holder else None
            abandoned = (
                holder is None
                or not isinstance(acquired_at, (int, float))
                or now - acquired_at >= stale
            )
            if abandoned:
                # Only the waiter that still sees the same stale inode removes it,
                # so a lock freshly taken by another waiter is never discarded.
                if inode is not None and _inode(lock_path) == inode:
                    try:
                        lock_path.unlink()
                    except OSError:
                        pass
                continue
            if now >= deadline:
                return False, holder
            sleep(POLL_SECS)

    def release(self, file_path: str, project_cwd) -> bool:
        """Drop this session's lock on ``file_path`` (never another session's)."""
        lock_path = _lock_path(self.root, _resolve(file_path, project_cwd))
        record = _read(lock_path)
        if record is None or record.get("owner") != self.owner:
            return False
        try:
            lock_path.unlink()
        except OSError:
            return False
        return True

    def release_all(self) -> int:
        """Drop every lock this session still holds; return how many were dropped."""
        released = 0
        try:
            entries = list(self.root.glob("*.json"))
        except OSError:
            return 0
        for lock_path in entries:
            record = _read(lock_path)
            if record is None or record.get("owner") != self.owner:
                continue
            try:
                lock_path.unlink()
                released += 1
            except OSError:
                continue
        return released


def _event_name(payload: dict) -> str:
    event = payload.get("hook_event_name")
    if isinstance(event, str) and event:
        return event
    if payload.get("tool_name"):
        return "PostToolUse" if "tool_response" in payload else "PreToolUse"
    return ""


def _deny(reason: str) -> None:
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": reason,
                }
            }
        )
    )


def file_guard(services) -> None:
    """Hook entry: serialise edit tools per file across sessions of one checkout."""
    if not enabled():
        return
    try:
        payload = services._read_hook_stdin()
        event = _event_name(payload)
        if not event:
            return
        project_cwd = payload.get("cwd") or os.getcwd()
        owner = payload.get("session_id") or f"pid:{os.getppid()}"
        lock = FileLock(
            lock_root(project_cwd),
            str(owner),
            alias=os.environ.get("ORCHA_ALIAS"),
            pid=os.getppid(),
        )
        tool_name = payload.get("tool_name") or ""
        paths = edited_paths(tool_name, payload.get("tool_input"))
        if event == "PreToolUse":
            # Any new tool call by this session means its previous edit finished,
            # so leftovers from a failed edit (no PostToolUse) are dropped first.
            lock.release_all()
            for path in paths:
                held, holder = lock.acquire(
                    path, project_cwd, wait=wait_secs(), stale=stale_secs()
                )
                if not held:
                    who = (holder or {}).get("alias") or "another agent"
                    _deny(
                        f"{tool_name} on {path} is waiting on a file lock held by {who} "
                        f"for more than {int(wait_secs())}s. Work on another file and "
                        "retry this edit shortly; the lock releases when their edit "
                        "finishes."
                    )
                    return
        elif event == "PostToolUse":
            if paths:
                for path in paths:
                    lock.release(path, project_cwd)
            else:
                lock.release_all()
        elif event in RELEASE_EVENTS:
            lock.release_all()
    except Exception:
        return
