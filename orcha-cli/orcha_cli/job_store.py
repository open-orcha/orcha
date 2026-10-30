"""Private, durable files for supervised commands, outside disposable worktrees.

These files are local evidence, never task attachments. Server ownership checks
must precede authoritative writes; this module only serializes local storage.
"""

from __future__ import annotations

import fcntl
import json
import logging
import os
import stat
import tempfile
from contextlib import ExitStack, contextmanager
from pathlib import Path
from uuid import UUID

from .sandbox import workspace_root_for

JOBS_DIRECTORY = ".orcha-jobs"
TERMINAL_STATES = frozenset({"completed", "interrupted", "exhausted"})

log = logging.getLogger("orcha.jobs")
_reported: set[tuple[str, str]] = set()


def _report_skipped(path: Path, reason: str) -> None:
    """Log each skipped entry once per process; scans repeat every few seconds."""
    if (str(path), reason) not in _reported:
        _reported.add((str(path), reason))
        log.warning("Skipping %s in managed command storage: %s", path, reason)


class JobStorageError(RuntimeError):
    """Evidence is unavailable or unsafe to change; retain the launch fence."""


def jobs_root(base_cwd: str | Path) -> Path:
    """Use the same durable, path-identical workspace mount as sandbox workers."""
    return workspace_root_for(Path(base_cwd).resolve()).resolve() / ".claude" / JOBS_DIRECTORY


def _private_directory(path: Path) -> None:
    if path.is_symlink():
        raise JobStorageError("Managed command storage must not be a symlink")
    path.mkdir(mode=0o700, exist_ok=True)
    if not path.is_dir():
        raise JobStorageError("Managed command storage is not a directory")
    os.chmod(path, 0o700)


def _open_private(path: Path, flags: int) -> int:
    fd = os.open(path, flags | os.O_NOFOLLOW, 0o600)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise JobStorageError("Managed command evidence must be a regular file")
    os.fchmod(fd, 0o600)
    return fd


def _sync_directory(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_json(path: Path, value: dict) -> None:
    """Flush a private temporary file, replace atomically, then flush its directory."""
    payload = json.dumps(value, sort_keys=True, allow_nan=False).encode("utf-8")
    fd, temporary = tempfile.mkstemp(prefix=".write-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        _sync_directory(path.parent)
    finally:
        Path(temporary).unlink(missing_ok=True)


def read_json(path: Path) -> dict:
    try:
        with os.fdopen(_open_private(path, os.O_RDONLY), "r") as stream:
            value = json.load(stream)
        if not isinstance(value, dict):
            raise ValueError("not an object")
        return value
    except (OSError, ValueError) as exc:
        # Do not echo file contents, which may contain private command output.
        raise JobStorageError("Managed command evidence is unavailable or invalid") from exc


class JobStore:
    """One shared lock protects registration and worktree teardown.

    The self-ignoring file is created before lock, record, checkpoint, or output
    files, including in newly connected repositories without Orcha ignore rules.
    Callers supply only sanitized metadata; executable argv and tokens stay in
    the supervisor's memory/pipe, never in these JSON records.
    """

    def __init__(self, base_cwd: str | Path):
        self.root = jobs_root(base_cwd)
        parent = self.root.parent
        if parent.is_symlink():
            raise JobStorageError("Managed command parent must not be a symlink")
        parent.mkdir(mode=0o700, exist_ok=True)
        _private_directory(self.root)
        ignore = self.root / ".gitignore"
        try:
            fd = _open_private(ignore, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
        except FileExistsError:
            with os.fdopen(_open_private(ignore, os.O_RDONLY), "r") as stream:
                if stream.read() != "*\n":
                    raise JobStorageError("Managed command ignore safeguard is missing")
        else:
            with os.fdopen(fd, "w") as stream:
                stream.write("*\n")
                stream.flush()
                os.fsync(stream.fileno())
            _sync_directory(self.root)

    @contextmanager
    def locked(self):
        fd = _open_private(self.root / ".lock", os.O_RDWR | os.O_CREAT)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield self
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)

    def job_directory(self, job_id: str, *, create: bool = False) -> Path:
        try:
            name = str(UUID(job_id))
        except (ValueError, TypeError, AttributeError) as exc:
            raise JobStorageError("Invalid managed command identity") from exc
        path = self.root / name
        if create:
            _private_directory(path)
        elif path.is_symlink() or not path.is_dir():
            raise JobStorageError("Managed command directory is unavailable")
        return path

    def read(self, job_id: str) -> dict:
        return read_json(self.job_directory(job_id) / "record.json")

    def entries(self):
        """Yield (job_id, record) per command directory; call under locked().

        Hidden names are Orcha's own control files. Any other name that is not a
        job id (a stray file or folder) cannot belong to a command, so it is
        logged and skipped, never read. An unreadable record under a job id
        yields None: the caller decides whom it may affect.
        """
        for path in sorted(self.root.iterdir()):
            if path.name.startswith("."):
                continue
            try:
                job_id = str(UUID(path.name))
            except ValueError:
                job_id = None
            if job_id != path.name:
                _report_skipped(path, "not a command record")
                continue
            try:
                yield job_id, self.read(job_id)
            except JobStorageError:
                _report_skipped(path, "command record is unreadable")
                yield job_id, None

    def open_output(self, job_id: str, stream: str):
        """Append raw command output only to private, ignored local files."""
        if stream not in {"stdout", "stderr"}:
            raise JobStorageError("Invalid managed command output stream")
        path = self.job_directory(job_id) / f"{stream}.log"
        fd = _open_private(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND)
        return os.fdopen(fd, "ab", buffering=0)

    def reserve(self, job_id: str, record: dict) -> dict:
        """Durably register before launch; retries never overwrite an existing job."""
        with self.locked():
            if not record.get("cwd") or not Path(record["cwd"]).is_dir():
                raise JobStorageError("Managed command working directory is unavailable")
            directory = self.job_directory(job_id, create=True)
            path = directory / "record.json"
            if path.exists() or path.is_symlink():
                return read_json(path)
            value = dict(record, job_id=str(UUID(job_id)), version=0)
            atomic_json(path, value)
            return value

    def update(self, job_id: str, expected_version: int, changes: dict) -> dict:
        with self.locked():
            record = self.read(job_id)
            if record["version"] != expected_version:
                raise JobStorageError("Managed command record changed; reload before updating")
            if "job_id" in changes or "version" in changes:
                raise JobStorageError("Managed command identity and version are immutable")
            record.update(changes)
            record["version"] += 1
            atomic_json(self.job_directory(job_id) / "record.json", record)
            return record

    def checkpoint(self, job_id: str, expected_version: int, evidence: dict) -> dict:
        """Flush a versioned checkpoint before publishing its local record pointer."""
        with self.locked():
            record = self.read(job_id)
            if record["version"] != expected_version:
                raise JobStorageError("Managed command record changed; reload before saving")
            version = expected_version + 1
            directory = self.job_directory(job_id)
            path = directory / f"checkpoint-{version}.json"
            atomic_json(path, dict(evidence, job_id=record["job_id"], version=version))
            record.update(version=version, checkpoint=str(path))
            atomic_json(directory / "record.json", record)
            return record

    def retains_worktree(self, worktree: str | Path) -> bool:
        """Call under locked(); uncertain/unreadable evidence prevents deletion."""
        worktree = str(Path(worktree).resolve())
        for _, record in self.entries():
            try:
                if record is None:
                    return True
                if not Path(record["cwd"]).resolve().is_relative_to(worktree):
                    continue
                if (record.get("status") not in TERMINAL_STATES
                        or not record.get("termination_verified")
                        or not record.get("result_saved")):
                    return True
            except (JobStorageError, KeyError, TypeError, OSError):
                return True
        return False


def command_summary(argv: list[str]) -> str:
    """Metadata, never executable recovery input; omit every argument value."""
    known = {"python", "python3", "pytest", "npm", "npx", "node", "make", "swift", "cargo",
             "go", "bash", "sh", "zsh", "git", "ruff", "mypy", "tsc", "jest", "vitest"}
    executable = Path(argv[0]).name if argv else ""
    label = executable if executable in known else "custom executable"
    return f"{label} [{max(0, len(argv) - 1)} argument values omitted]"


@contextmanager
def worktree_teardown_guard(base_cwd, worktree):
    """Hold the registration lock through deletion, or give a reason to retain it."""
    if not base_cwd or not worktree or not Path(base_cwd).is_dir():
        yield None
        return
    stack = ExitStack()
    try:
        store = JobStore(base_cwd)
        stack.enter_context(store.locked())
        retained = store.retains_worktree(worktree)
    except (OSError, JobStorageError):
        stack.close()
        yield "managed command evidence could not be checked"
        return
    with stack:
        yield ("a managed command still needs this worktree"
               if retained else None)
