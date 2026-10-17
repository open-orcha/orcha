"""`orcha migrate-runtime`: move a Docker/Postgres project onto the native runtime
(GH #258 plan Part 6 M2, PR 8).

Forward (default): check the Docker database is up, stop everything that writes (notifier,
terminal bridge, the portal container), copy Postgres into ``.orcha/orcha.db.partial`` with
``orcha_cli.db_convert`` (verified), ``os.replace`` it to ``orcha.db``, ``docker compose stop``
(never ``down``, never ``-v``: the containers and the Postgres volume stay as the rollback),
switch ``.claude/orcha.json`` to ``runtime: native`` (the previous file is kept byte for byte
in ``.orcha/orcha.json.docker``), refresh hooks, and start the native stack.

``--rollback`` puts the Docker stack back exactly as it was (the SQLite file is renamed,
never deleted). ``--purge-docker`` deletes the old containers, image and Postgres volume,
only once the native portal answers, after a y/N (``--yes`` for scripts).

``--json`` prints one JSON object per line (``progress`` events, then ``result`` or
``error``) for the desktop app, which drives this command instead of a terminal.
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import pathlib
import shutil
import sys
from dataclasses import dataclass
from typing import Callable, Optional

from orcha_cli import cli_runtime_mode, db_convert

START_DOCKER_ONCE = ("Your project's data is still inside Docker. Start Docker once, run "
                     "`orcha up`, then run this command again.")
CONFIG_BACKUP = pathlib.Path(".orcha") / "orcha.json.docker"
PARTIAL_SUFFIX = ".partial"
DOCKER_LEFTOVERS = ("docker-compose.yml", "portal", "migrations")


class MigrateError(RuntimeError):
    """The migration stopped; the message says what the user can do next."""


@dataclass
class Deps:
    """Everything with a side effect outside the project folder (tests swap these)."""
    compose: Callable  # (orcha_dir, *args, check=True, capture=False) -> CompletedProcess
    stop_daemon: Callable
    stop_bridge: Callable
    ensure_daemon: Callable
    ensure_bridge: Callable
    convert: Callable  # db_convert.convert
    native_up: Callable
    native_down: Callable
    write_hooks: Callable  # (claude_dir) -> bool
    http_ok: Callable  # (url) -> bool
    get_json: Callable  # (url, timeout=...) -> dict | None
    confirm: Callable  # (question) -> bool
    service_install: Optional[Callable] = None  # (root) -> dict | None; launchd, macOS only
    service_uninstall: Optional[Callable] = None  # (root) -> dict; rollback removes the unit


def default_deps(services) -> Deps:
    from orcha_cli import cli_native_lifecycle, cli_serve_support, cli_service, terminal_bridge

    def confirm(question: str) -> bool:
        if not sys.stdin.isatty():
            return False
        return input(f"{question} [y/N] ").strip().lower() in ("y", "yes")

    return Deps(
        compose=services._compose,
        stop_daemon=lambda root: services.stop_daemon(root, quiet=True),
        stop_bridge=lambda root: terminal_bridge.stop_bridge(root, quiet=True),
        ensure_daemon=services.ensure_daemon,
        ensure_bridge=terminal_bridge.ensure_bridge,
        convert=db_convert.convert,
        native_up=cli_native_lifecycle.up,
        native_down=cli_native_lifecycle.down,
        write_hooks=services._write_hook_config,
        http_ok=cli_serve_support.http_ok,
        get_json=services._get_json,
        confirm=confirm,
        service_install=cli_service.install_if_supported,
        service_uninstall=lambda root: cli_service.uninstall(root) if cli_service.supported() else None,
    )


class Output:
    """Human lines, or one JSON object per line with ``--json``."""

    def __init__(self, as_json: bool, stream=None):
        self.as_json = as_json
        self.stream = stream or sys.stdout

    def _write(self, obj: dict) -> None:
        print(json.dumps(obj), file=self.stream, flush=True)

    def step(self, stage: str, message: str, **extra) -> None:
        if self.as_json:
            self._write({"event": "progress", "stage": stage, "message": message, **extra})
        else:
            print(f"[orcha] {message}", file=self.stream, flush=True)

    def result(self, message: str, **extra) -> None:
        if self.as_json:
            self._write({"event": "result", "ok": True, "message": message, **extra})
        else:
            print(message, file=self.stream, flush=True)

    def error(self, message: str) -> None:
        if self.as_json:
            self._write({"event": "error", "ok": False, "error": message})
        else:
            print(f"error: {message}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------- helpers

def _api_base(cfg: dict) -> str:
    return cfg.get("api_base_url") or f"http://localhost:{cfg.get('api_port')}"


def _pg_url(cfg: dict, override: Optional[str]) -> str:
    if override:
        return override
    port = cfg.get("db_port")
    if not port:
        raise MigrateError("orcha.json has no db_port; pass --pg-url postgresql://... explicitly")
    return f"postgresql://orcha:orcha@localhost:{port}/orcha"


def _write_config(root: pathlib.Path, cfg: dict) -> None:
    path = cli_runtime_mode.config_path(root)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(cfg, indent=2) + "\n")
    os.replace(tmp, path)


def _db_files(db: pathlib.Path) -> list:
    return [db.with_name(db.name + s) for s in ("", "-wal", "-shm")]


def _db_running(root: pathlib.Path, deps: Deps) -> bool:
    try:
        proc = deps.compose(root / ".orcha", "ps", "--status", "running", "--services",
                            check=False, capture=True)
    except OSError:  # no docker binary at all
        return False
    return proc.returncode == 0 and "db" in (proc.stdout or "").split()


def _convert_message(event: dict) -> str:
    if event.get("stage") == "copy":
        return f"copying {event.get('table')} ({event.get('index')}/{event.get('total')})"
    return {"schema": "creating the SQLite schema", "verify": "verifying the copy",
            "done": "copy verified"}.get(event.get("stage"), str(event.get("stage")))


def _restart_docker_writers(root: pathlib.Path, deps: Deps) -> None:
    """Undo the quiesce step after a failed copy: the Docker stack is back as it was."""
    deps.compose(root / ".orcha", "start", "portal", check=False)
    for start in (deps.ensure_daemon, deps.ensure_bridge):
        try:
            start(root)
        except Exception:
            pass


# ---------------------------------------------------------------- forward

def forward(root: pathlib.Path, deps: Deps, out: Output, *, pg_url: Optional[str] = None,
            no_service: bool = False, keep_docker_running: bool = False) -> dict:
    cfg = cli_runtime_mode.read_config(root)
    if not cli_runtime_mode.is_project(root, cfg):
        raise MigrateError("no Orcha project here — run this in the folder where you ran `orcha init`")
    if cli_runtime_mode.detect_runtime(root, cfg) == cli_runtime_mode.NATIVE:
        raise MigrateError("this project already runs natively (no Docker); nothing to migrate")
    url = _pg_url(cfg, pg_url)
    if not (db_convert.sqlite_migrations_dir() / "001_baseline.sql").exists():
        raise MigrateError("this orcha CLI does not ship the SQLite schema; update the CLI first")
    db = root / cli_runtime_mode.DEFAULT_DB_PATH
    existing = [p for p in _db_files(db) if p.exists()]
    if existing:
        raise MigrateError(
            f"{existing[0]} already exists, so this project may already have been migrated. "
            "Nothing was changed. Move that file away yourself if you want to migrate again.")
    if not _db_running(root, deps):
        raise MigrateError(START_DOCKER_ONCE)

    out.step("quiesce", "stopping the notifier, terminal bridge and portal (the database stays up)")
    for stop in (deps.stop_daemon, deps.stop_bridge):
        try:
            stop(root)
        except Exception:
            pass
    deps.compose(root / ".orcha", "stop", "portal")

    partial = db.with_name(db.name + PARTIAL_SUFFIX)
    for stale in _db_files(partial):  # a crashed earlier run's half-copy is ours to clear
        if stale.exists():
            stale.unlink()
    out.step("convert", f"copying the Postgres database into {db}")
    try:
        report = deps.convert(url, partial,
                              progress=lambda e: out.step("convert", _convert_message(e), detail=e))
    except Exception as exc:
        for half in _db_files(partial):
            if half.exists():
                half.unlink()
        _restart_docker_writers(root, deps)
        raise MigrateError(f"the copy failed and nothing was changed (Docker is running as "
                           f"before): {exc}") from exc
    os.replace(partial, db)

    if not keep_docker_running:
        out.step("stop-docker", "stopping the Docker containers (kept, with their data, for --rollback)")
        deps.compose(root / ".orcha", "stop")

    backup = root / CONFIG_BACKUP
    config_file = cli_runtime_mode.config_path(root)
    shutil.copy2(config_file, backup)
    native_cfg = dict(cfg)
    native_cfg.update(runtime=cli_runtime_mode.NATIVE,
                      db_path=str(cli_runtime_mode.DEFAULT_DB_PATH), bind="loopback")
    if "db_port" in native_cfg:
        native_cfg["legacy_db_port"] = native_cfg.pop("db_port")
    _write_config(root, native_cfg)
    deps.write_hooks(root / ".claude")
    if deps.service_install is not None and not no_service:
        out.step("service", "installing the background service")
        try:
            deps.service_install(root)
        except Exception as exc:  # not fatal: `up` below starts serve directly instead
            try:
                if deps.service_uninstall is not None:
                    deps.service_uninstall(root)  # no half-installed unit for `up` to trip on
            except Exception:
                pass
            out.step("service", f"warning: the background service was not installed ({exc}); "
                                "run `orcha service install` later so Orcha starts at login")

    out.step("start", "starting Orcha natively")
    deps.native_up(root)
    cid = cfg.get("current_container_id")
    listed = deps.get_json(f"{_api_base(native_cfg)}/api/containers", timeout=5.0) or {}
    ids = {c.get("id") for c in listed.get("containers", [])} if isinstance(listed, dict) else set()
    if cid and cid not in ids:
        raise MigrateError(
            "the native portal started but does not list this project's container. "
            "Run `orcha migrate-runtime --rollback` to go back to Docker.")
    counts = {t.table: t.rows for t in report.tables}
    out.result(
        f"[orcha] ✓ migrated: your data now lives in {db}.\n"
        "        The old Docker copy is still there, untouched.\n"
        "        Go back:        orcha migrate-runtime --rollback\n"
        "        Delete Docker:  orcha migrate-runtime --purge-docker",
        db_path=str(db), tables=len(counts), rows=report.total_rows, counts=counts,
    )
    return report.as_dict()


# ---------------------------------------------------------------- rollback

def rollback(root: pathlib.Path, deps: Deps, out: Output) -> None:
    cfg = cli_runtime_mode.read_config(root)
    backup = root / CONFIG_BACKUP
    if cfg.get("runtime") != cli_runtime_mode.NATIVE or not backup.exists():
        raise MigrateError("nothing to roll back: this project was not moved by "
                           "`orcha migrate-runtime` (or was already rolled back)")
    if not cli_runtime_mode.compose_path(root).exists():
        raise MigrateError("the Docker files were purged (--purge-docker), so there is "
                           "nothing to roll back to")
    out.step("stop-native", "stopping the native stack")
    deps.native_down(root)
    if deps.service_uninstall is not None:
        deps.service_uninstall(root)  # a Docker project must not start `orcha serve` at login
    db = cli_runtime_mode.db_path(root, cfg)
    stamp = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    kept = db.with_name(f"{db.name}.rolled-back-{stamp}")
    for src in _db_files(db):
        if src.exists():
            os.replace(src, kept.with_name(kept.name + src.name[len(db.name):]))
    os.replace(backup, cli_runtime_mode.config_path(root))
    out.step("start-docker", "starting the Docker stack again")
    deps.compose(root / ".orcha", "up", "-d")
    for start in (deps.ensure_daemon, deps.ensure_bridge):
        try:
            start(root)
        except Exception:
            pass
    out.result(f"[orcha] ✓ rolled back to Docker. The SQLite copy is kept at {kept}.",
               kept_db=str(kept))


# ---------------------------------------------------------------- purge

def purge_docker(root: pathlib.Path, deps: Deps, out: Output, *, yes: bool = False) -> None:
    cfg = cli_runtime_mode.read_config(root)
    if cfg.get("runtime") != cli_runtime_mode.NATIVE:
        raise MigrateError("this project still runs on Docker; migrate it first")
    if not deps.http_ok(f"{_api_base(cfg)}/"):
        raise MigrateError("the native portal is not answering, so the Docker copy is kept. "
                           "Start it with `orcha up` and try again.")
    if not yes and not deps.confirm(
            "Delete the old Docker containers, image and Postgres data for this project? "
            "This cannot be undone."):
        raise MigrateError("not confirmed; nothing deleted (pass --yes to skip the question)")
    orcha_dir = root / ".orcha"
    if cli_runtime_mode.compose_path(root).exists():
        out.step("purge", "removing the Docker containers, image and volume")
        deps.compose(orcha_dir, "down", "-v", "--rmi", "local")
    for name in DOCKER_LEFTOVERS:
        path = orcha_dir / name
        if path.is_dir():
            shutil.rmtree(path)
        elif path.exists():
            path.unlink()
    backup = root / CONFIG_BACKUP
    if backup.exists():
        backup.unlink()
    cfg.pop("legacy_db_port", None)
    _write_config(root, cfg)
    out.result("[orcha] ✓ the old Docker copy is deleted; this project is native only.")


# ---------------------------------------------------------------- command

def run(args, deps: Deps, out: Output) -> int:
    root = pathlib.Path(getattr(args, "project_dir", None) or pathlib.Path.cwd()).resolve()
    try:
        if args.rollback:
            rollback(root, deps, out)
        elif args.purge_docker:
            purge_docker(root, deps, out, yes=args.yes)
        else:
            forward(root, deps, out, pg_url=args.pg_url, no_service=args.no_service,
                    keep_docker_running=args.keep_docker_running)
    except MigrateError as exc:
        out.error(str(exc))
        return 1
    return 0


def cmd_migrate_runtime(args, services=None) -> None:
    if services is None:
        from orcha_cli import __main__ as services
    if args.rollback and args.purge_docker:
        sys.exit("error: --rollback and --purge-docker cannot be combined")
    sys.exit(run(args, default_deps(services), Output(args.json)))


def docker_nudge() -> str:
    """The one line `orcha up` / `orcha update` print on a Docker-runtime project."""
    return ("[orcha] tip: this project still runs Postgres in Docker. "
            "`orcha migrate-runtime` moves it to the native runtime (no Docker needed); "
            "the Docker copy is kept until you delete it.")
