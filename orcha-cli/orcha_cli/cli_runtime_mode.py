"""Which runtime a project folder uses: Docker compose or native (GH #258, plan R-D4).

``runtime`` is read from ``.claude/orcha.json``. When the key is absent, a folder with
``.orcha/docker-compose.yml`` is a Docker project (every stack created before the native
runtime existed); otherwise the answer is native. Every "is this folder an Orcha
project?" gate goes through :func:`is_project`, so the Docker half has one place to
delete in the cleanup PR.

A native project is only ever recognised by an explicit ``"runtime": "native"`` key
(written by ``orcha init --runtime native``). A folder with ``orcha.json`` but no compose
file and no key is a client-only workspace from ``orcha connect`` (``"connected": true``)
or a half-initialised folder; neither owns a stack, so neither is a project.
"""
from __future__ import annotations

import json
import pathlib
import sys

DOCKER = "docker"
NATIVE = "native"
RUNTIMES = (DOCKER, NATIVE)
DEFAULT_DB_PATH = pathlib.Path(".orcha") / "orcha.db"


def config_path(project_root) -> pathlib.Path:
    return pathlib.Path(project_root) / ".claude" / "orcha.json"


def compose_path(project_root) -> pathlib.Path:
    return pathlib.Path(project_root) / ".orcha" / "docker-compose.yml"


def read_config(project_root) -> dict:
    """``.claude/orcha.json`` as a dict; ``{}`` when it is missing or unreadable."""
    try:
        data = json.loads(config_path(project_root).read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def detect_runtime(project_root, cfg: dict | None = None) -> str:
    """``"native"`` or ``"docker"``: the ``runtime`` key wins, else the compose file decides."""
    cfg = read_config(project_root) if cfg is None else cfg
    runtime = cfg.get("runtime")
    if runtime is not None:
        if runtime not in RUNTIMES:
            raise ValueError(
                f"unknown runtime {runtime!r} in {config_path(project_root)} "
                f"(expected one of: {', '.join(RUNTIMES)})"
            )
        return runtime
    return DOCKER if compose_path(project_root).exists() else NATIVE


def is_docker_project(project_root, cfg: dict | None = None) -> bool:
    """The pre-#258 gate, unchanged: the compose file exists (and no native override)."""
    cfg = read_config(project_root) if cfg is None else cfg
    return compose_path(project_root).exists() and cfg.get("runtime") in (None, DOCKER)


def is_native_project(project_root, cfg: dict | None = None) -> bool:
    """``orcha.json`` says ``"runtime": "native"`` and the folder is not a connect client."""
    cfg = read_config(project_root) if cfg is None else cfg
    return cfg.get("runtime") == NATIVE and not cfg.get("connected")


def is_project(project_root, cfg: dict | None = None) -> bool:
    """This folder owns an Orcha stack (Docker or native) that up/down/status can manage."""
    cfg = read_config(project_root) if cfg is None else cfg
    return is_native_project(project_root, cfg) or is_docker_project(project_root, cfg)


def require_project(project_root, missing_message: str) -> str:
    """The runtime of the stack this folder owns; exits with ``missing_message`` when it
    owns none, and with the reason when ``orcha.json`` names an unknown runtime."""
    cfg = read_config(project_root)
    try:
        runtime = detect_runtime(project_root, cfg)
    except ValueError as e:
        sys.exit(f"error: {e}")
    if not is_project(project_root, cfg):
        sys.exit(missing_message)
    return runtime


def db_path(project_root, cfg: dict | None = None) -> pathlib.Path:
    """The native SQLite file: ``db_path`` from ``orcha.json`` (relative to the project
    root when not absolute), else ``<project>/.orcha/orcha.db`` (owner default Q-A)."""
    cfg = read_config(project_root) if cfg is None else cfg
    raw = cfg.get("db_path")
    path = pathlib.Path(raw).expanduser() if raw else DEFAULT_DB_PATH
    return path if path.is_absolute() else pathlib.Path(project_root) / path
