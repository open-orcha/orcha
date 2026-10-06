"""Pieces `orcha serve` is built from: the state file, per-child logs, health probes and
the three child specs (GH #258 PR 6, plan Part 5 R2).

Kept apart from the supervisor loop in ``cli_serve`` so each can be tested alone and
both stay under the repo's 250-line ceiling.
"""
from __future__ import annotations

import dataclasses
import json
import logging
import logging.handlers
import os
import pathlib
import socket
import sys
import tempfile
import threading
import time
import urllib.request
from typing import Callable, Optional

from . import notifier_daemon_registry
from .cli_runtime_mode import read_config

LOG_MAX_BYTES = 10 * 2**20  # owner default Q-G: 5 x 10 MB per child
LOG_BACKUPS = 5
HEARTBEAT_STALE_SECS = notifier_daemon_registry.HEARTBEAT_STALE_SECS


def orcha_dir(root: pathlib.Path) -> pathlib.Path:
    return pathlib.Path(root) / ".orcha"


def state_path(root: pathlib.Path) -> pathlib.Path:
    return orcha_dir(root) / "state.json"


def logs_dir(root: pathlib.Path) -> pathlib.Path:
    return orcha_dir(root) / "logs"


def log_path(root: pathlib.Path, name: str) -> pathlib.Path:
    return logs_dir(root) / f"{name}.log"


def read_state(root: pathlib.Path) -> dict:
    """``.orcha/state.json``; ``{}`` when absent or half-written."""
    try:
        data = json.loads(state_path(root).read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def write_state(root: pathlib.Path, state: dict) -> None:
    """Atomic replace (temp file in the same directory + ``os.replace``), so a reader
    never sees a torn file; the mtime doubles as serve's liveness stamp."""
    path = state_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".state.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(state, fh, indent=2, sort_keys=True)
            fh.write("\n")
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def rotating_logger(root: pathlib.Path, name: str) -> logging.Logger:
    """A logger writing ``.orcha/logs/<name>.log``, rotated at 10 MB, five backups kept."""
    logs_dir(root).mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger(f"orcha.serve.{pathlib.Path(root).resolve()}.{name}")
    logger.setLevel(logging.INFO)
    logger.propagate = False
    target = str(log_path(root, name))
    if not any(getattr(h, "baseFilename", None) == target for h in logger.handlers):
        handler = logging.handlers.RotatingFileHandler(
            target, maxBytes=LOG_MAX_BYTES, backupCount=LOG_BACKUPS
        )
        handler.setFormatter(logging.Formatter("%(message)s"))
        logger.addHandler(handler)
    return logger


def pump(stream, logger: logging.Logger) -> threading.Thread:
    """Drain a child's merged stdout/stderr into its log on a daemon thread."""

    def _run() -> None:
        try:
            for raw in iter(stream.readline, b""):
                logger.info(raw.decode("utf-8", "replace").rstrip("\n"))
        except (OSError, ValueError):
            pass
        finally:
            try:
                stream.close()
            except OSError:
                pass

    thread = threading.Thread(target=_run, name=f"{logger.name}-pump", daemon=True)
    thread.start()
    return thread


# --- health probes ----------------------------------------------------------------


def http_ok(url: str, timeout: float = 2.0) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout):
            return True
    except Exception:
        return False


def tcp_open(port: int, host: str = "127.0.0.1", timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection((host, int(port)), timeout=timeout):
            return True
    except OSError:
        return False


def heartbeat_fresh(root: pathlib.Path, now: Optional[float] = None) -> bool:
    """The notifier re-stamps ``.claude/.orcha-notifier.hb`` every loop pass."""
    try:
        _pid, ts = (pathlib.Path(root) / ".claude" / ".orcha-notifier.hb").read_text().split()
        return ((now or time.time()) - float(ts)) < HEARTBEAT_STALE_SECS
    except (OSError, ValueError):
        return False


# --- children -----------------------------------------------------------------------


@dataclasses.dataclass
class ChildSpec:
    """One supervised process. ``argv`` is rebuilt at every (re)start from the current
    ``orcha.json`` and may return ``None`` while the child cannot start yet (e.g. the
    notifier before ``orcha init`` has created the container)."""

    name: str
    argv: Callable[[], Optional[list]]
    healthy: Callable[[], bool]


def _module_argv(*args: str) -> list:
    # R-D2: the interpreter running `serve` is the right one (the desktop sidecar's
    # `orcha` is not on PATH), so children never go through shutil.which("orcha").
    return [sys.executable, "-m", "orcha_cli", *args]


def child_specs(root: pathlib.Path, *, no_bridge: bool = False) -> list:
    """portal first (the others are gated on it), then notifier and bridge."""
    root = pathlib.Path(root)

    def cfg() -> dict:
        return read_config(root)

    def portal_argv() -> list:
        return _module_argv("portal", "--project-dir", str(root))

    def notifier_argv() -> Optional[list]:
        cid = cfg().get("current_container_id")
        return _module_argv("notifier", "--quiet", "--container", cid) if cid else None

    def bridge_argv() -> Optional[list]:
        port = cfg().get("bridge_port")
        return _module_argv("terminal-bridge", "--quiet", "--port", str(port)) if port else None

    specs = [
        ChildSpec("portal", portal_argv, lambda: http_ok(f"http://127.0.0.1:{cfg().get('api_port')}/")),
        ChildSpec("notifier", notifier_argv, lambda: heartbeat_fresh(root)),
    ]
    if not no_bridge:
        specs.append(ChildSpec("bridge", bridge_argv, lambda: tcp_open(cfg().get("bridge_port") or 0)))
    return specs
