"""Detect tracked project changes made while a command runs without its worker.

The only reason a continued command is stopped on its own is that tracked
project content changed while no worker was on the checkout. Untracked and
ignored files never count, and neither do declared artifacts, Orcha's own job
records, or common log/cache/build/test output folders, even when tracked.

Content is identified the way Git identifies a blob, so staging or committing an
unchanged file (for example an Orcha checkpoint commit) is not a change. Any
Git failure is uncertainty, never evidence: the caller keeps the command.
"""

from __future__ import annotations

import hashlib
import os
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


def blob_id(path):
    """Git's blob ID for the working file, or a marker for a missing file."""
    try:
        if path.is_symlink():
            data = os.readlink(path).encode(errors='surrogateescape')
        elif path.is_file():
            data = path.read_bytes()
        else:
            return 'missing'
    except OSError:
        return 'missing'
    return hashlib.sha1(b'blob %d\0' % len(data) + data).hexdigest()


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
        self._dirty_cache = {}

    def fingerprint(self):
        """A digest of tracked, non-artifact content; None when Git is unavailable."""
        if not self.root or not Path(self.root).is_dir():
            return None
        listed = _git(self.root, 'ls-files', '-s', '-z')
        dirty = _git(self.root, 'diff-files', '--name-only', '-z')
        if listed is None or dirty is None:
            return None
        dirty_paths = {p.decode(errors='surrogateescape') for p in dirty.split(b'\0') if p}
        digest = hashlib.sha256()
        seen = set()
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
            content = fields[1].decode()
            if path in dirty_paths:
                content = self._dirty_id(path)
            digest.update(path.encode(errors='surrogateescape') + b'\0' + content.encode() + b'\0')
        return digest.hexdigest()

    def _dirty_id(self, path):
        full = Path(self.root) / path
        try:
            st = full.lstat()
            key = (st.st_size, st.st_mtime_ns, st.st_ino)
        except OSError:
            return 'missing'
        cached = self._dirty_cache.get(path)
        if cached and cached[0] == key:
            return cached[1]
        value = blob_id(full)
        self._dirty_cache[path] = (key, value)
        return value

    def rebaseline(self, since):
        """`since` is server time observed before this fingerprint was taken."""
        value = self.fingerprint()
        if value is not None:
            self.since, self.baseline = since, value
        return value is not None

    def changed(self):
        if self.baseline is None:
            return False
        value = self.fingerprint()
        return value is not None and value != self.baseline
