"""Fail-closed live activity adapter for project cleanup."""
from __future__ import annotations

import subprocess

from .worktree_cleanup_scan import CleanupError


def _process_folders(output):
    """Never confuse lsof's display escapes with real filename bytes.

    Its C, caret and hex escapes are ambiguous with literal filename text.
    Refuse cleanup when a cwd cannot be identified without guessing, including
    unexpected raw control characters. Ordinary absolute paths remain usable.
    """
    folders = set()
    for line in output.split("\n"):
        if not line or line == "fcwd" or (line.startswith("p") and line[1:].isdigit()):
            continue
        if not line.startswith("n/"):
            raise CleanupError("A live process folder could not be identified; folders are retained")
        path = line[1:]
        if "\\" in path or "^" in path or any(not char.isprintable() for char in path):
            raise CleanupError("A live process folder has an ambiguous name; folders are retained")
        folders.add(path)
    if not folders:
        raise CleanupError("Live process information was empty; folders are retained")
    return folders


def provider(api, cid, post, local_busy=()):
    def read(rows):
        if not api or not cid:
            raise CleanupError("Start this project's portal to verify active work before cleanup")
        contexts, busy = {}, set(local_busy)
        # Do not silently truncate projects larger than the API's batch limit.
        for offset in range(0, max(1, len(rows)), 500):
            batch = rows[offset:offset + 500]
            reply = post(f"{api}/api/containers/{cid}/agent-worktrees/cleanup-context", {
                "paths": [r["path"] for r in batch],
                "task_refs": {r["path"]: r["task_ref"] for r in batch if r.get("task_ref")},
            })
            if not isinstance(reply, dict) or reply.get("complete") is not True:
                raise CleanupError("The portal could not verify active work; folders are retained")
            contexts.update(reply.get("items", {}))
            busy.update(reply.get("busy_worktrees", []))
        try:
            proc = subprocess.run(["lsof", "-n", "-w", "-d", "cwd", "-F", "n"],
                                  capture_output=True, text=True, errors="surrogateescape", timeout=20)
        except (OSError, subprocess.SubprocessError):
            raise CleanupError("Live processes could not be checked; folders are retained") from None
        if proc.returncode != 0:
            raise CleanupError("Live processes could not be checked; folders are retained")
        busy.update(_process_folders(proc.stdout))
        return {"complete": True, "contexts": contexts, "busy": busy}
    return read
