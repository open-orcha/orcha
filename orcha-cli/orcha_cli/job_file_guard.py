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
newly created files stay out of it even once they are staged. Any Git failure
is uncertainty, never evidence: the caller keeps the command.
"""

from __future__ import annotations

import hashlib
import os
import stat
import subprocess
from pathlib import Path, PurePosixPath

GITLINK = '160000'
ARTIFACT_PARTS = frozenset({
    '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.cache', '.tox', '.nox',
    '.venv', 'venv', 'node_modules', '.next', '.turbo', '.parcel-cache', 'dist', 'build',
    'coverage', 'htmlcov', '.nyc_output', 'test-results', 'playwright-report', 'logs', 'log',
    'tmp', 'temp', '.tmp', 'target', 'DerivedData', '.gradle',
})
ARTIFACT_SUFFIXES = ('.log', '.pyc', '.pyo', '.tmp', '.swp')


def _git(root, *args, timeout=30):
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    env['GIT_OPTIONAL_LOCKS'] = '0'  # Read-only: never refresh or lock the index.
    try:
        done = subprocess.run(['git', '-C', str(root), *args], capture_output=True, env=env,
                              stdin=subprocess.DEVNULL, timeout=timeout, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return done.stdout if done.returncode == 0 else None


def checkout_root(cwd):
    out = _git(cwd, 'rev-parse', '--show-toplevel')
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


class FileGuard:
    def __init__(self, cwd, artifacts=(), private_roots=()):
        self.root = checkout_root(cwd)
        self.excluded = ()
        if self.root:
            prefixes = []
            for base, names in ((Path(cwd), artifacts), (None, private_roots)):
                for name in names:
                    target = (base / name if base else Path(name)).resolve()
                    if target.is_relative_to(self.root):
                        prefixes.append(target.relative_to(self.root).as_posix())
            self.excluded = tuple(p for p in prefixes if p not in {'', '.'})
        self.since = None
        self.baseline = None
        self._working_cache = {}

    def snapshot(self):
        """{path: content ID} for tracked, non-artifact files; None when Git is unavailable."""
        if not self.root or not Path(self.root).is_dir():
            return None
        listed = _git(self.root, 'ls-files', '-s', '-z')
        dirty = _git(self.root, 'diff-files', '--name-only', '-z')
        if listed is None or dirty is None:
            return None
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
            out = _git(self.root, 'hash-object', '--', *(path for path, _ in batch))
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
        """A file tracked at the baseline now has different content, or is gone."""
        if self.baseline is None:
            return False
        current = self.snapshot()
        if current is None:
            return False
        untracked = [path for path in self.baseline if path not in current]
        if untracked:
            working = self.working_ids(untracked)
            if working is None:
                return False
            current = {**current, **working}
        return any(current[path] != value for path, value in self.baseline.items())
