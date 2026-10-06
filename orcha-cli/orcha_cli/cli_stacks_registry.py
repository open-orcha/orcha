"""Machine-wide registry of native Orcha stacks: ``~/.orcha/stacks.json`` (GH #258 R2).

``orcha serve`` adds its project on start and ``orcha down`` removes it. Every write is
read-modify-write under an exclusive ``flock`` on ``~/.orcha/stacks.lock`` and lands via
``os.replace``, so two projects starting at once cannot drop each other's entry.

``orcha ls`` and ``orcha connect`` read it through :func:`discover_all`, which keeps only
entries whose ``.orcha/state.json`` was refreshed in the last 90 s *and* whose portal
answers ``GET /api/containers``, prunes the rest, and merges the Docker stacks only when a
``docker`` binary is on PATH.
"""

from __future__ import annotations

import contextlib
import datetime
import json
import os
import pathlib
import shutil
import sys
import time
from collections.abc import Callable
from typing import Optional

try:
    import fcntl
except ImportError:  # pragma: no cover - native runtime is macOS/Linux only
    fcntl = None

STATE_FRESH_SECS = 90.0


def registry_dir() -> pathlib.Path:
    return pathlib.Path.home() / ".orcha"


def registry_path() -> pathlib.Path:
    return registry_dir() / "stacks.json"


def lock_path() -> pathlib.Path:
    return registry_dir() / "stacks.lock"


@contextlib.contextmanager
def _locked():
    registry_dir().mkdir(parents=True, exist_ok=True)
    with open(lock_path(), "a") as fh:
        if fcntl is not None:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            if fcntl is not None:
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


def _read() -> dict:
    try:
        data = json.loads(registry_path().read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write(data: dict) -> None:
    path = registry_path()
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
    os.replace(tmp, path)


def read_registry() -> dict:
    """``{project_name: entry}``; ``{}`` when absent or unreadable."""
    with _locked():
        return _read()


def register(name: str, *, path, api_port, bridge_port, cli_version: str) -> dict:
    """Add or refresh ``name``'s entry (called by ``orcha serve`` on start)."""
    entry = {
        "path": str(pathlib.Path(path).resolve()),
        "api_port": api_port,
        "bridge_port": bridge_port,
        "runtime": "native",
        "cli_version": cli_version,
        "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    with _locked():
        data = _read()
        data[name] = entry
        _write(data)
    return entry


def unregister(name: str) -> bool:
    """Drop ``name``'s entry (called by ``orcha down``); True when one was removed."""
    with _locked():
        data = _read()
        if name not in data:
            return False
        del data[name]
        _write(data)
        return True


def _state_fresh(project_path: str, now: float) -> bool:
    try:
        mtime = (pathlib.Path(project_path) / ".orcha" / "state.json").stat().st_mtime
    except OSError:
        return False
    return now - mtime < STATE_FRESH_SECS


def live_native_stacks(*, get_json: Callable, now: Optional[float] = None) -> list[dict]:
    """Registered native stacks that are up, in ``discover_stacks`` row shape.

    Entries failing the freshness or portal check are pruned from the file.
    """
    now = time.time() if now is None else now
    with _locked():
        data = _read()
        live, dead = [], []
        for name, entry in sorted(data.items()):
            port = entry.get("api_port") if isinstance(entry, dict) else None
            if (port and _state_fresh(entry.get("path") or "", now)
                    and get_json(f"http://localhost:{port}/api/containers") is not None):
                live.append(_row(name, entry))
            else:
                dead.append(name)
        if dead:
            for name in dead:
                del data[name]
            _write(data)
    return live


def _row(name: str, entry: dict) -> dict:
    return {
        "project": f"orcha-{name}",
        "project_short": name,
        "api_port": entry.get("api_port"),
        "db_port": None,
        "portal_status": "Up (native)",
        "runtime": "native",
        "folder": entry.get("path"),
    }


def discover_all(*, docker_stacks: Callable[[], list[dict]], get_json: Callable,
                 which: Optional[Callable[[str], Optional[str]]] = None) -> list[dict]:
    """Native stacks from the registry, plus Docker stacks when ``docker`` exists.

    A failing ``docker ps`` (daemon stopped) degrades to the native list with a warning
    instead of exiting. A name present in both keeps the native row.
    """
    stacks = live_native_stacks(get_json=get_json)
    if (which or shutil.which)("docker"):
        try:
            docker = docker_stacks()
        except SystemExit:
            print("[orcha] warn: `docker ps` failed; listing native stacks only.", file=sys.stderr)
            docker = []
        seen = {s["project_short"] for s in stacks}
        stacks += [dict(s, runtime="docker") for s in docker if s["project_short"] not in seen]
    return sorted(stacks, key=lambda s: s["project_short"])
