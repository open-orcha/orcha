"""Device lock directories: one agent drives a simulator or emulator at a time.

The machine's convention (shared with every other agent on it): before driving a device, claim
`/tmp/claude-sim-lock-<name>` with `mkdir` (atomic: exactly one claimant wins), and `rmdir` it when
done. `<name>` is the device name with spaces as `-` and anything but letters, digits, `.`, `_`, `-`
dropped ("iPhone 17 Pro" -> `iPhone-17-Pro`, "iPad Pro 13-inch (M5)" -> `iPad-Pro-13-inch-M5`).

The lock directory stays empty, so a bare `rmdir` always works. What this module knows about its own
locks sits beside it in `/tmp/claude-sim-lock-<name>.owner`: the owning process, when that process
started (a pid can come back as someone else), and which run it is, so another project can say who
it waits for. The file names the directory it belongs to, so one left behind by a bare `rmdir` says
nothing about the next lock taken there.

A lock is stale when its owner process is gone: it is taken at once. A lock with no owner file
(another tool's bare `mkdir`) keeps the old rule: older than `STALE_AFTER_S` and its device not
booted. A lock is removed by `release()`, at `end()`, and at interpreter exit for any lock held.

The line (`/tmp/claude-sim-queue/`): a run that found every device taken holds a ticket naming the
devices it wants. Older tickets go first on a device they want, across projects, since the locks are
machine-wide and no portal sees them all. A ticket whose process is gone or which stopped asking is
ignored. Tools that only `mkdir` know nothing of the line and simply win when they ask first.

Standard library only.
"""

from __future__ import annotations

import atexit
import contextlib
import json
import os
import re
import subprocess
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

LOCK_ROOT = Path("/tmp")
LOCK_PREFIX = "claude-sim-lock-"
OWNER_SUFFIX = ".owner"
QUEUE_DIR = "claude-sim-queue"
#: A lock this old on a device that is not booted is stale.
STALE_AFTER_S = 2 * 60 * 60
#: A ticket not touched for this long has stopped asking: the line goes on without it.
TICKET_FRESH_S = 3 * 60

_held: dict[str, DeviceLock] = {}
_guard = threading.Lock()
_holder: dict[str, Any] = {}
_ticket: Ticket | None = None
_own_start: str | None = None


def lock_name(device_name: str) -> str:
    """`iPhone 17 Pro` -> `iPhone-17-Pro`; `iPad Pro 13-inch (M5)` -> `iPad-Pro-13-inch-M5`."""
    dashed = re.sub(r"\s+", "-", device_name.strip())
    return re.sub(r"[^A-Za-z0-9._-]", "", dashed)


def lock_path(device_name: str, root: Path | None = None) -> Path:
    return (root or LOCK_ROOT) / f"{LOCK_PREFIX}{lock_name(device_name)}"


def owner_path(path: Path) -> Path:
    """The file beside a lock directory that says who holds it."""
    return path.with_name(path.name + OWNER_SUFFIX)


def set_holder(**fields: Any) -> None:
    """Who this process's next lock is for (`project`, `kind`, `session_id`, `task_id`)."""
    _holder.clear()
    _holder.update({k: v for k, v in fields.items() if v})


# ---------------------------------------------------------------- processes

def process_started(pid: int) -> str:
    """When `pid` started, as `ps` says it; "" when that cannot be told."""
    try:
        got = subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)], capture_output=True, text=True, timeout=5,
                             check=False, env={**os.environ, "LC_ALL": "C"})
    except (OSError, subprocess.SubprocessError):
        return ""
    return " ".join(got.stdout.split()) if got.returncode == 0 else ""


def _own_started() -> str:
    global _own_start
    if _own_start is None:
        _own_start = process_started(os.getpid())
    return _own_start


def process_gone(pid: Any, started: Any = None) -> bool:
    """That process no longer exists: no such pid, or the pid is now a process that started at
    another time. Anything that cannot be told counts as alive."""
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    except OSError:
        pass  # it exists, under another user
    if not started:
        return False
    now = process_started(pid)
    return bool(now) and now != started


# ---------------------------------------------------------------- the owner file

def _stamp(path: Path) -> list[int] | None:
    """Which directory this is: a new `mkdir` at the same path has another stamp."""
    try:
        st = path.stat()
    except OSError:
        return None
    return [st.st_ino, st.st_mtime_ns]


def _write_owner(path: Path, device_name: str) -> None:
    body = {"pid": os.getpid(), "started": _own_started(), "dir": _stamp(path), "device": device_name,
            "claimed_at": time.time(), **_holder}
    tmp = owner_path(path).with_name(f"{owner_path(path).name}.{os.getpid()}")
    try:
        tmp.write_text(json.dumps(body))
        tmp.replace(owner_path(path))
    except OSError:
        with contextlib.suppress(OSError):
            tmp.unlink()  # the lock still holds; only the 2-hour rule can free it now


def owner_of(path: Path) -> dict[str, Any] | None:
    """Who holds the lock at `path`, or None: no owner file, or one left by an earlier lock."""
    try:
        owner = json.loads(owner_path(path).read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(owner, dict) or owner.get("dir") != _stamp(path):
        return None
    return owner


def owner_gone(path: Path) -> bool:
    """The lock names an owner and that process no longer exists."""
    owner = owner_of(path)
    return owner is not None and process_gone(owner.get("pid"), owner.get("started"))


@dataclass
class DeviceLock:
    device_name: str
    path: Path
    released: bool = False

    def release(self) -> None:
        """Remove the lock directory and its owner file (idempotent; never raises). The owner file
        goes first, so it can never be taken for the next lock's. A lock someone else took over
        (a shut-down device, past the age rule) is theirs and stays."""
        if self.released:
            return
        self.released = True
        with _guard:
            if _held.get(str(self.path)) is self:
                del _held[str(self.path)]
        owner = owner_of(self.path)
        if owner is not None and owner.get("pid") != os.getpid():
            return
        _remove(self.path)


def _remove(path: Path) -> None:
    with contextlib.suppress(OSError):
        owner_path(path).unlink()
    try:
        path.rmdir()
    except FileNotFoundError:
        pass
    except OSError:
        # Someone put a file in it: still ours to remove.
        try:
            for child in path.iterdir():
                child.unlink()
            path.rmdir()
        except OSError:
            pass


@dataclass
class LockState:
    """What is known about a lock that someone else holds."""

    path: Path
    age_s: float
    stale: bool
    owner: dict[str, Any] | None = None


def inspect(device_name: str, *, is_booted: Callable[[], bool] | None = None, root: Path | None = None,
            stale_after_s: float = STALE_AFTER_S) -> LockState | None:
    """The lock on `device_name` (None when there is none). Stale: its owner process is gone, or it
    is older than `stale_after_s` and the device is not booted (`is_booted()`; a device whose state
    cannot be told counts as booted, so a lock is never taken from a device that may be in use)."""
    path = lock_path(device_name, root)
    try:
        age = time.time() - path.stat().st_mtime
    except FileNotFoundError:
        return None
    booted = True
    if age > stale_after_s:
        try:
            booted = bool(is_booted()) if is_booted is not None else True
        except Exception:  # noqa: BLE001 - unknown: treat as in use
            booted = True
    owner = owner_of(path)
    gone = owner is not None and process_gone(owner.get("pid"), owner.get("started"))
    return LockState(path=path, age_s=age, stale=gone or (age > stale_after_s and not booted), owner=owner)


def holder(device_name: str, *, root: Path | None = None) -> dict[str, Any] | None:
    """Who has the device now, for a person: `{device, project, kind, session_id, task_id, since}`
    (the last four only for a lock this module took), or None when nobody does."""
    state = inspect(device_name, root=root)
    if state is None or state.stale:
        return None
    owner = state.owner or {}
    out = {"device": device_name, "since": owner.get("claimed_at") or (time.time() - state.age_s)}
    return {**out, **{k: owner[k] for k in ("project", "kind", "session_id", "task_id") if owner.get(k)}}


def held_words(who: dict[str, Any] | None) -> str:
    """`snug-log's check run`, or what can be said of a lock with no owner file."""
    if not who or not (who.get("project") or who.get("kind")):
        return "another tool"
    run = f"{who['kind']} run" if who.get("kind") else "run"
    return f"{who['project']}'s {run}" if who.get("project") else f"another project's {run}"


@contextlib.contextmanager
def _takeover(path: Path) -> Iterator[None]:
    """One process at a time decides a lock is stale and removes it: two doing so at once could
    remove the lock the other has just taken. `flock` lets go by itself if its holder dies."""
    try:
        import fcntl
    except ImportError:
        yield
        return
    folder = path.parent / QUEUE_DIR
    folder.mkdir(exist_ok=True)
    with open(folder / f"{path.name}.takeover", "w") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        yield


def claim(device_name: str, *, is_booted: Callable[[], bool] | None = None, root: Path | None = None,
          stale_after_s: float = STALE_AFTER_S) -> DeviceLock | None:
    """Claim the device's lock with `mkdir`: the lock, or None when another agent holds it (a live
    owner, a fresh lock, or an old one on a booted device) or an older ticket in the line wants this
    device. A lock this process already holds is returned again. A stale lock is removed and claimed."""
    path = lock_path(device_name, root)
    with _guard:
        mine = _held.get(str(path))
    if mine is not None and not mine.released and path.is_dir():
        return mine
    if _line_ahead(device_name, root):
        return None
    for _ in range(2):
        try:
            os.mkdir(path)
        except FileExistsError:
            state = inspect(device_name, is_booted=is_booted, root=root, stale_after_s=stale_after_s)
            if state is None:
                continue  # released between the two calls: try again
            if not state.stale:
                return None
            with _takeover(path):
                state = inspect(device_name, is_booted=is_booted, root=root, stale_after_s=stale_after_s)
                if state is None:
                    continue
                if not state.stale:
                    return None  # someone else took it over first
                with contextlib.suppress(OSError):
                    owner_path(path).unlink()
                try:
                    path.rmdir()
                except FileNotFoundError:
                    pass
                except OSError:
                    return None  # not empty and not ours: leave it
            continue
        _write_owner(path, device_name)
        lock = DeviceLock(device_name=device_name, path=path)
        with _guard:
            _held[str(path)] = lock
        return lock
    return None


def held() -> list[DeviceLock]:
    with _guard:
        return list(_held.values())


def release_all() -> None:
    for lock in held():
        lock.release()


# ---------------------------------------------------------------- the line

@dataclass
class Ticket:
    path: Path
    key: str
    wants: list[str]


def _read_ticket(path: Path) -> dict[str, Any] | None:
    try:
        row = json.loads(path.read_text())
        return {**row, "key": path.stem, "touched": path.stat().st_mtime} if isinstance(row, dict) else None
    except (OSError, ValueError):
        return None


def line(root: Path | None = None) -> list[dict[str, Any]]:
    """The live tickets, oldest first. A ticket whose process is gone, or that stopped asking, is
    removed by whoever reads it."""
    folder = (root or LOCK_ROOT) / QUEUE_DIR
    try:
        names = sorted(p for p in folder.iterdir() if p.suffix == ".json")
    except OSError:
        return []
    out = []
    for p in names:
        row = _read_ticket(p)
        if row is None:
            continue
        if process_gone(row.get("pid"), row.get("started")) or time.time() - row["touched"] > TICKET_FRESH_S:
            with contextlib.suppress(OSError):
                p.unlink()
            continue
        out.append(row)
    return out


def _line_ahead(device_name: str, root: Path | None) -> bool:
    """An older ticket wants this device. This process's own ticket is where it stands."""
    name = lock_name(device_name)
    for row in line(root):
        if _ticket is not None and row["key"] >= _ticket.key:
            break
        if name in (row.get("wants") or []):
            return True
    return False


def join_line(devices: list[str], *, root: Path | None = None) -> Ticket:
    """This process's ticket for `devices`: taken once, so it keeps its place, and touched on each
    call. Returns the ticket."""
    global _ticket
    wants = [lock_name(d) for d in devices]
    folder = (root or LOCK_ROOT) / QUEUE_DIR
    if _ticket is None or not _ticket.path.exists():
        folder.mkdir(exist_ok=True)
        key = _ticket.key if _ticket is not None else f"{time.time_ns():020d}-{os.getpid()}"
        _ticket = Ticket(path=folder / f"{key}.json", key=key, wants=[])
    if wants != _ticket.wants:
        body = {"pid": os.getpid(), "started": _own_started(), "wants": wants, **_holder}
        tmp = _ticket.path.with_suffix(".part")
        tmp.write_text(json.dumps(body))
        tmp.replace(_ticket.path)
        _ticket.wants = wants
    else:
        os.utime(_ticket.path)
    return _ticket


def place(*, root: Path | None = None) -> int:
    """This process's place in the line (1: next), counting only the runs that want a device it
    wants too."""
    if _ticket is None:
        return 1
    wants = set(_ticket.wants)
    ahead = [r for r in line(root) if r["key"] < _ticket.key and wants & set(r.get("wants") or [])]
    return len(ahead) + 1


def leave_line() -> None:
    global _ticket
    if _ticket is not None:
        with contextlib.suppress(OSError):
            _ticket.path.unlink()
        _ticket = None


def may_claim(devices: list[str], *, root: Path | None = None) -> bool:
    """Is a claim on any of `devices` worth trying now? Only reads files, so a waiting run can ask
    every few seconds on a loaded machine."""
    for d in devices:
        state = inspect(d, root=root)
        if (state is None or state.stale) and not _line_ahead(d, root):
            return True
    return False


atexit.register(release_all)
atexit.register(leave_line)
