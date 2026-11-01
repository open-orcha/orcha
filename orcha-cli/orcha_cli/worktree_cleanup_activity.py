"""Fail-closed live activity adapter for project cleanup."""
from __future__ import annotations

import subprocess

from .worktree_cleanup_scan import CleanupError


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
                                  capture_output=True, text=True, timeout=20)
        except (OSError, subprocess.SubprocessError):
            raise CleanupError("Live processes could not be checked; folders are retained") from None
        if proc.returncode != 0:
            raise CleanupError("Live processes could not be checked; folders are retained")
        busy.update(line[1:] for line in proc.stdout.splitlines() if line.startswith("n/"))
        return {"complete": True, "contexts": contexts, "busy": busy}
    return read
