"""`orcha portal`: run the packaged FastAPI portal in this interpreter (no container).

First step of GH #258 (run Orcha without Docker): the portal the Docker image runs
today, served as a plain host process from the installed ``orcha_cli`` package.
Postgres still comes from the project's compose ``db`` service until the SQLite
cutover, so on an existing stack ``docker compose stop portal && orcha portal``
serves the same UI on the same port.

The environment mirrors ``templates/docker-compose.yml.j2`` with host paths in place
of the container mounts. Precedence matches compose interpolation: the shell env
outranks ``.orcha/.env``, which outranks the derived defaults. Paths that name a
container mount (attachments, GitHub token files, the local repo) are always set.
"""
from __future__ import annotations

import argparse
import importlib.resources
import json
import os
import pathlib
import shutil
import sys

from . import cli_project_setup
from .cli_env import _append_env_file, _read_env_file_value, _tighten_env_file
from .cli_runtime_mode import NATIVE, db_path

LAN_BIND = "0.0.0.0"
LOOPBACK_BIND = "127.0.0.1"


def templates_dir() -> pathlib.Path:
    """The installed package's ``templates/`` directory (wheels install unpacked)."""
    return pathlib.Path(str(importlib.resources.files("orcha_cli") / "templates"))


def portal_dir() -> pathlib.Path:
    """The packaged portal: ``main.py``, ``portal_backend/`` and the built ``static/``."""
    return templates_dir() / "portal"


def read_env_file(path: pathlib.Path) -> dict[str, str]:
    """Every ``KEY=value`` line of a dotenv file (first match wins); {} if unreadable."""
    values: dict[str, str] = {}
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return values
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values.setdefault(key.strip(), value.strip())
    return values


def load_project_config(project_root: pathlib.Path) -> dict:
    """``.claude/orcha.json`` of the project; exits with a hint when it is missing."""
    cfg_path = project_root / ".claude" / "orcha.json"
    if not cfg_path.exists():
        sys.exit(
            f"error: no .claude/orcha.json in {project_root}. Run `orcha portal` from the "
            "project root (where `orcha init` was run), or pass --project-dir."
        )
    return json.loads(cfg_path.read_text())


def bind_host(cfg: dict) -> str:
    """Loopback unless the project opted into LAN access (mobile pairing)."""
    return LAN_BIND if cfg.get("bind") == "lan" else LOOPBACK_BIND


def build_portal_env(project_root: pathlib.Path, cfg: dict, base_env=None) -> dict[str, str]:
    """The portal's environment: shell > ``.orcha/.env`` > derived defaults."""
    env = dict(os.environ if base_env is None else base_env)
    for key, value in read_env_file(project_root / ".orcha" / ".env").items():
        env.setdefault(key, value)
    if cfg.get("db_port"):  # Docker Postgres until the SQLite cutover (PR 7b)
        env.setdefault(
            "DATABASE_URL", f"postgresql://orcha:orcha@localhost:{cfg['db_port']}/orcha"
        )
    if cfg.get("runtime") == NATIVE:  # the SQLite file, read by database.py after PR 7b
        env.setdefault("ORCHA_DB_PATH", str(db_path(project_root, cfg)))
        # ...with the SQLite migrations (baseline + later files). The Postgres dir set below
        # would make a fresh native portal halt on 001_init.sql's CREATE EXTENSION.
        env.setdefault("MIGRATIONS_DIR", str(templates_dir() / "migrations" / "sqlite"))
    env.setdefault("MIGRATIONS_DIR", str(templates_dir() / "migrations"))
    env.setdefault("ORCHA_TERMINAL_WS_URL", f"ws://127.0.0.1:{cfg['bridge_port']}")
    # These replace the compose bind mounts, so a stray value in .env must not win.
    env["ORCHA_ATTACHMENTS_DIR"] = str(project_root / ".claude" / ".orcha-attachments")
    env["ORCHA_GITHUB_TOKEN_FILE"] = str(project_root / ".orcha" / "github-token")
    env["ORCHA_GITHUB_TOKENS_FILE"] = str(project_root / ".orcha" / "github-tokens.json")
    env["ORCHA_LOCAL_REPO_DIR"] = str(project_root)
    env["ORCHA_LOCAL_REPO_NAME"] = str(cfg.get("project_name") or project_root.name)
    return env


def check_migration_tip(project_root: pathlib.Path, allow_downgrade: bool) -> None:
    """Refuse to run an older package's portal against a newer stack's schema."""
    package_tip = cli_project_setup.migration_tip(templates_dir() / "migrations")
    stack_tip = cli_project_setup.migration_tip(project_root / ".orcha" / "migrations")
    if stack_tip > package_tip and not allow_downgrade:
        sys.exit(
            f"error: this project's schema is at migration {stack_tip:03d} but the installed "
            f"orcha-cli only knows up to {package_tip:03d}. Update the CLI (`orcha update`) "
            "or pass --allow-downgrade to run the older portal anyway."
        )


def _prepare_host_state(project_root: pathlib.Path) -> None:
    """The same pre-start prep `orcha up` does before compose (key, pairing host, gh)."""
    orcha_dir = project_root / ".orcha"
    (project_root / ".claude" / ".orcha-attachments").mkdir(parents=True, exist_ok=True)
    cli_project_setup.ensure_secret_key(
        orcha_dir, _read_env_file_value, _append_env_file, _tighten_env_file
    )
    cli_project_setup.export_pairing_host(
        cli_project_setup.discover_pairing_host, orcha_dir
    )
    cli_project_setup.export_gh_token()


def cmd_portal(args: argparse.Namespace) -> None:
    """Serve the portal for one project in the foreground until interrupted."""
    project_root = pathlib.Path(args.project_dir or pathlib.Path.cwd()).resolve()
    cfg = load_project_config(project_root)
    check_migration_tip(project_root, args.allow_downgrade)
    try:
        import uvicorn
    except ImportError:
        sys.exit(
            "error: the portal's Python dependencies are not installed in this "
            f"interpreter ({sys.executable}). The Homebrew formula does not bundle them "
            "yet; from a source checkout, reinstall the CLI with "
            "`uv tool install --reinstall --editable ./orcha-cli`."
        )
    if not shutil.which("git"):
        print("[orcha] warning: `git` is not on PATH; Code Space browsing will be unavailable")
    _prepare_host_state(project_root)
    os.environ.update(build_portal_env(project_root, cfg))
    sys.path.insert(0, str(portal_dir()))
    host = args.host or bind_host(cfg)
    port = args.port or int(cfg["api_port"])
    print(f"[orcha] portal for {project_root.name} on http://{host}:{port} (Ctrl-C to stop)")
    # Mirrors the image's CMD, except trusted forwarding is limited to loopback:
    # the container port was compose-bound, a host process is not.
    uvicorn.run(
        "main:app",
        host=host,
        port=port,
        proxy_headers=True,
        forwarded_allow_ips=LOOPBACK_BIND,
        log_level="info",
    )
