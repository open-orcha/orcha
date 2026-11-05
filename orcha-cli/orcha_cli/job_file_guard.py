"""Detect tracked project changes made while a command runs without its worker.

The only reason a continued command is stopped on its own is that tracked
project content changed while no worker, and no other managed command, was on
the checkout. Untracked and
ignored files never count, and neither do declared artifacts, Orcha's own job
records, or common log/cache/build/test output folders, even when tracked.

Content is identified the way Git stores it: a clean file by its index blob,
and an edited file by `git hash-object`, which applies the same line-ending
and clean-filter normalization `git add` would. Staging or committing an
unchanged file (for example an Orcha checkpoint commit) is therefore not a
change. Only files tracked when the baseline was taken are compared, so
newly created files stay out of it even once they are staged. A snapshot
combines two reads of Git's index, so it is retried when the index changes
between them (a checkpoint staging files, for example). Any Git failure, or an
index that keeps changing, is uncertainty, never evidence: the caller keeps
the command. Every Git process can be cancelled so a scan never delays a stop.
"""

from __future__ import annotations

import hashlib
import os
import signal
import stat
import subprocess
import threading
from pathlib import Path, PurePosixPath

GITLINK = '160000'
ARTIFACT_PARTS = frozenset({
    '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.cache', '.tox', '.nox',
    '.venv', 'venv', 'node_modules', '.next', '.turbo', '.parcel-cache', 'dist', 'build',
    'coverage', 'htmlcov', '.nyc_output', 'test-results', 'playwright-report', 'logs', 'log',
    'tmp', 'temp', '.tmp', 'target', 'DerivedData', '.gradle',
})
ARTIFACT_SUFFIXES = ('.log', '.pyc', '.pyo', '.tmp', '.swp')


class Cancellation:
    """Stops in-flight Git scans (and any filters they started) on request."""

    def __init__(self):
        self.lock = threading.Lock()
        self.cancelled = False
        self.processes = set()

    def cancel(self):
        with self.lock:
            self.cancelled = True
            for process in self.processes:
                _kill_group(process)


def _kill_group(process):
    # An unreaped process keeps its ID, so its group cannot belong to another program.
    if process.returncode is None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except OSError:
            pass


def _git(root, *args, timeout=30, cancellation=None):
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    env['GIT_OPTIONAL_LOCKS'] = '0'  # Read-only: never refresh or lock the index.
    lock = cancellation.lock if cancellation else threading.Lock()
    with lock:
        if cancellation and cancellation.cancelled:
            return None
        try:
            # Its own process group, so cancelling also ends clean filters it runs.
            process = subprocess.Popen(['git', '-C', str(root), *args], stdout=subprocess.PIPE,
                                       stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                                       env=env, start_new_session=True)
        except (OSError, subprocess.SubprocessError):
            return None
        if cancellation:
            cancellation.processes.add(process)
    try:
        out, _ = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        _kill_group(process)
        process.communicate()
        return None
    finally:
        if cancellation:
            with lock:
                cancellation.processes.discard(process)
    return out if process.returncode == 0 else None


def checkout_root(cwd, cancellation=None):
    out = _git(cwd, 'rev-parse', '--show-toplevel', cancellation=cancellation)
    if not out:
        return None
    root = out.decode(errors='surrogateescape').strip()
    return str(Path(root).resolve()) if root else None


def is_artifact(path, excluded=()):
    pure = PurePosixPath(path)
    if any(part in ARTIFACT_PARTS for part in pure.parts[:-1]) or pure.name.endswith(ARTIFACT_SUFFIXES):
        return True
    if pure.name.startswith('.coverage'):
        return True
    return any(path == prefix or path.startswith(prefix.rstrip('/') + '/') for prefix in excluded)


def symlink_id(path):
    """Git's blob ID for a symlink: its target text, which Git never filters."""
    data = os.readlink(path).encode(errors='surrogateescape')
    return hashlib.sha1(b'blob %d\0' % len(data) + data).hexdigest()


HASH_BATCH = 200
SNAPSHOT_ATTEMPTS = 3


class FileGuard:
    def __init__(self, cwd, artifacts=(), private_roots=(), cancellation=None):
        self.cancellation = cancellation
        self.root = checkout_root(cwd, cancellation)
        self.excluded = ()
        self.index_path = None
        if self.root:
            prefixes = []
            for base, names in ((Path(cwd), artifacts), (None, private_roots)):
                for name in names:
                    target = (base / name if base else Path(name)).resolve()
                    if target.is_relative_to(self.root):
                        prefixes.append(target.relative_to(self.root).as_posix())
            self.excluded = tuple(p for p in prefixes if p not in {'', '.'})
            index = self.git('rev-parse', '--git-path', 'index')
            if index and index.strip():
                self.index_path = Path(self.root) / index.decode(errors='surrogateescape').strip()
        self.since = None
        self.baseline = None
        self._working_cache = {}

    def git(self, *args):
        return _git(self.root, *args, cancellation=self.cancellation)

    def index_stamp(self):
        """Identifies one version of the index; Git replaces the file on every write."""
        try:
            st = os.stat(self.index_path)
        except FileNotFoundError:
            return 'absent'
        except (OSError, TypeError):
            return None
        return (st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)

    def index_reads(self):
        """The index listing and its dirty paths, both from the same index version."""
        for _ in range(SNAPSHOT_ATTEMPTS):
            before = self.index_stamp()
            listed = self.git('ls-files', '-s', '-z')
            dirty = self.git('diff-files', '--name-only', '-z')
            if before is None or listed is None or dirty is None:
                return None
            if self.index_stamp() == before:
                return listed, dirty
        return None  # The index kept changing: uncertain, never evidence.

    def snapshot(self):
        """{path: content ID} for tracked, non-artifact files; None when Git is unavailable."""
        if not self.root or not Path(self.root).is_dir():
            return None
        reads = self.index_reads()
        if reads is None:
            return None
        listed, dirty = reads
        dirty_paths = {p.decode(errors='surrogateescape') for p in dirty.split(b'\0') if p}
        indexed, edited, seen = {}, [], set()
        for entry in listed.split(b'\0'):
            if not entry:
                continue
            meta, _, raw = entry.partition(b'\t')
            fields = meta.split()
            if len(fields) != 3 or fields[0].decode() == GITLINK:
                continue
            path = raw.decode(errors='surrogateescape')
            if path in seen or is_artifact(path, self.excluded):
                continue  # Conflict stages repeat a path; the first is enough.
            seen.add(path)
            if path in dirty_paths:
                edited.append(path)
            else:
                indexed[path] = fields[1].decode()
        working = self.working_ids(edited)
        return None if working is None else {**indexed, **working}

    def working_ids(self, paths):
        """Normalized blob IDs of working files, as `git add` would store them."""
        found, regular = {}, []
        for path in paths:
            full = Path(self.root) / path
            try:
                st = full.lstat()
            except OSError:
                found[path] = 'missing'
                continue
            key = (st.st_mode, st.st_size, st.st_mtime_ns, st.st_ctime_ns, st.st_ino)
            cached = self._working_cache.get(path)
            if cached and cached[0] == key:
                found[path] = cached[1]
            elif stat.S_ISLNK(st.st_mode):
                try:
                    found[path] = symlink_id(full)
                except OSError:
                    return None
                self._working_cache[path] = (key, found[path])
            elif stat.S_ISREG(st.st_mode):
                regular.append((path, key))
            else:
                found[path] = 'missing'  # Replaced by a directory or special file.
        for offset in range(0, len(regular), HASH_BATCH):
            batch = regular[offset:offset + HASH_BATCH]
            out = self.git('hash-object', '--', *(path for path, _ in batch))
            ids = out.decode().split() if out is not None else []
            if len(ids) != len(batch):
                return None
            for (path, key), value in zip(batch, ids):
                found[path] = value
                self._working_cache[path] = (key, value)
        return found

    def rebaseline(self, since):
        """`since` is server time observed before this snapshot was taken."""
        value = self.snapshot()
        if value is not None:
            self.since, self.baseline = since, value
        return value is not None

    def changed(self):
        """True when a file tracked at the baseline now has different content, or
        is gone; False when all match; None when Git could not tell (uncertain)."""
        if self.baseline is None:
            return None
        current = self.snapshot()
        if current is None:
            return None
        untracked = [path for path in self.baseline if path not in current]
        if untracked:
            working = self.working_ids(untracked)
            if working is None:
                return None
            current = {**current, **working}
        return any(current[path] != value for path, value in self.baseline.items())
