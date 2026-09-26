"""File-state and embodiment guards shared by the background inbox watcher."""
from __future__ import annotations

import json
import os
import pathlib

def watch_state_path(cwd: pathlib.Path, alias: str) -> pathlib.Path:
    return cwd / ".claude" / f".orcha-watch-state-{alias}.json"


def watch_pid_path(cwd: pathlib.Path, alias: str) -> pathlib.Path:
    return cwd / ".claude" / f".orcha-watch-{alias}.pid"


def read_watch_state(cwd: pathlib.Path, alias: str, services) -> dict:
    """Returns {seen_ids: list[str], queued: list[dict]}; defaults if file is absent/corrupt."""
    p = services._watch_state_path(cwd, alias)
    if not p.exists():
        return {"seen_ids": [], "queued": []}
    try:
        data = json.loads(p.read_text())
        if not isinstance(data, dict):
            return {"seen_ids": [], "queued": []}
        data.setdefault("seen_ids", [])
        data.setdefault("queued", [])
        return data
    except Exception:
        return {"seen_ids": [], "queued": []}


def atomic_write_json(path: pathlib.Path, data: dict) -> None:
    """Write JSON atomically — write to a sibling tmp file, then rename."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data) + "\n")
    tmp.replace(path)


def skip_managed_embodiment_hook(hook: str) -> bool:
    """ISS-21 + R1/S3: the interactive SessionStart hooks must NOT run inside an Orcha-managed
    embodiment — a headless wake worker (ORCHA_HEADLESS_WORKER, set by the notifier on every
    worker it spawns) OR an S3 live terminal session (ORCHA_LIVE, set by the PTY bridge).

    Both boot AS the agent with persona+digest+history already injected at spawn
    (`--append-system-prompt`, or in-session on a warm `--resume`). Re-running `rehydrate`
    would DOUBLE-inject that brief — and re-inject on a warm resume, breaking R1's cache-safe
    "no re-injection" contract. `watch` would wedge a one-shot worker / add poller noise to a
    live session, and `reachability` / `notifier --ensure` are the daemon's job, not the
    embodiment's. Interactive human tabs (neither flag) are unaffected.

    ORCHA_LIVE is only READ here, never unset, so cmd_snapshot's SessionEnd gate still fires.
    Returns True if we no-op."""
    marker = ("headless worker" if os.environ.get("ORCHA_HEADLESS_WORKER")
              else "live terminal session" if os.environ.get("ORCHA_LIVE") else None)
    if marker:
        print(f"[orcha] {marker} — skipping interactive SessionStart hook '{hook}'")
        return True
    return False
