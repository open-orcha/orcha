"""Folders detection never reads: Orcha's own (agents' worktrees hold whole copies of the repo, so
reading them would cite and count everything twice) and whatever git ignores.

`matcher(root)` answers for directories under `root`. Git's list is read once per repository and
kept for a short while: one scan asks many walkers, and a later scan must see a changed
`.gitignore`. Outside a repository, or without git, only the names below are skipped.
"""

from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path
from typing import Callable

ORCHA_DIRS = frozenset({".orcha-worktrees", ".orcha", ".claude"})
TTL_S = 30.0
GIT_TIMEOUT_S = 10.0

_cache: dict[str, tuple[float, frozenset[str]]] = {}


def _git(root: str, *args: str) -> str:
    try:
        got = subprocess.run(["git", "-C", root, *args], capture_output=True, text=True, timeout=GIT_TIMEOUT_S, check=False)
    except (OSError, subprocess.SubprocessError):
        return ""
    return got.stdout if got.returncode == 0 else ""


def ignored_dirs(root: str) -> frozenset[str]:
    """The real paths of the folders git ignores under `root`."""
    real = os.path.realpath(root)
    now = time.monotonic()
    hit = _cache.get(real)
    if hit and now - hit[0] < TTL_S:
        return hit[1]
    listed = _git(real, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory")
    out = frozenset(os.path.join(real, line.rstrip("/")) for line in listed.splitlines() if line.endswith("/"))
    _cache[real] = (now, out)
    return out


def matcher(root: "str | Path") -> Callable[["str | Path"], bool]:
    """Whether a directory under `root` is one detection never reads."""
    base, real = str(root), os.path.realpath(root)
    ignored = ignored_dirs(base)

    def skip(path: "str | Path") -> bool:
        p = str(path)
        if os.path.basename(p) in ORCHA_DIRS:
            return True
        return bool(ignored) and os.path.join(real, os.path.relpath(p, base)) in ignored

    return skip
