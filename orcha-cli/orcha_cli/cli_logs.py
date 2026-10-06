"""`orcha logs [-f] [-n N] [serve|portal|notifier|bridge]` for native-runtime projects
(GH #258 PR 6, R2). Reads the rotating files `orcha serve` writes under
``.orcha/logs/``; a Docker project gets the compose command that does the same."""
from __future__ import annotations

import argparse
import collections
import os
import pathlib
import sys
import time

from .cli_runtime_mode import DOCKER, compose_path, require_project
from .cli_serve_support import log_path

CHILDREN = ("serve", "portal", "notifier", "bridge")
FOLLOW_POLL_SECS = 0.5


def tail_lines(path: pathlib.Path, n: int) -> list:
    try:
        with open(path, "r", errors="replace") as fh:
            return list(collections.deque(fh, maxlen=n)) if n > 0 else []
    except OSError:
        return []


def _emit(name: str, line: str, prefix: bool) -> None:
    sys.stdout.write(f"{name:<8}| {line}" if prefix else line)
    if not line.endswith("\n"):
        sys.stdout.write("\n")


def follow(paths: dict, *, sleep=time.sleep, stop=lambda: False) -> None:
    """Print lines appended to each file; reopens a file that rotated or was truncated."""
    prefix = len(paths) > 1
    cursors = {}
    for name, path in paths.items():
        try:
            st = os.stat(path)
            cursors[name] = (st.st_ino, st.st_size)
        except OSError:
            cursors[name] = (None, 0)
    while not stop():
        for name, path in paths.items():
            inode, pos = cursors[name]
            try:
                st = os.stat(path)
            except OSError:
                continue
            if st.st_ino != inode or st.st_size < pos:
                inode, pos = st.st_ino, 0
            if st.st_size > pos:
                with open(path, "r", errors="replace") as fh:
                    fh.seek(pos)
                    for line in fh:
                        _emit(name, line, prefix)
                    pos = fh.tell()
            cursors[name] = (inode, pos)
        sys.stdout.flush()
        sleep(FOLLOW_POLL_SECS)


def cmd_logs(args: argparse.Namespace) -> None:
    root = pathlib.Path(args.project_dir or pathlib.Path.cwd()).resolve()
    runtime = require_project(root, f"error: no Orcha project in {root} — run `orcha init` first.")
    if runtime == DOCKER:
        sys.exit(f"this project runs on Docker; use: docker compose -f {compose_path(root)} logs -f")
    names = [args.child] if args.child else [c for c in CHILDREN if log_path(root, c).exists()]
    if not names:
        sys.exit(f"no logs yet in {log_path(root, 'serve').parent} — is `orcha serve` running? (`orcha up`)")
    prefix = len(names) > 1
    for name in names:
        for line in tail_lines(log_path(root, name), args.lines):
            _emit(name, line, prefix)
    if args.follow:
        try:
            follow({name: log_path(root, name) for name in names})
        except KeyboardInterrupt:
            pass
