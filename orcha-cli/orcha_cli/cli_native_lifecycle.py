"""Native-runtime branches of `orcha up/down/status` (GH #258 PR 6, plan Part 5 R2).

A native project has no compose file to drive: `orcha serve` owns the portal, notifier and
terminal bridge, so `up` starts (or finds) that one supervisor, `down` stops it, and
`status` reads its `.orcha/state.json`. When the launchd service is installed (R3, PR 10,
macOS only) `up` refreshes it and lets launchd start `serve`, and `down` unloads it;
otherwise `up` spawns `serve` detached the same way `ensure_daemon` does.
"""
from __future__ import annotations

import os
import pathlib
import signal
import sqlite3
import subprocess
import sys
import time

from orcha_cli import (
    cli_http,
    cli_project_setup,
    cli_runtime_mode,
    cli_serve,
    cli_serve_support,
    cli_service,
    cli_stacks_registry,
)

PORTAL_WAIT_SECS = 30.0
STOP_WAIT_SECS = 15.0  # serve itself gives each child up to 8 s before SIGKILL
POLL_SECS = 0.25
DB_SUFFIXES = ("", "-wal", "-shm")


def _api_base(cfg: dict) -> str:
    return cfg.get("api_base_url") or f"http://localhost:{cfg.get('api_port')}"


def _project_name(root: pathlib.Path, cfg: dict) -> str:
    return cfg.get("project_name") or root.name


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, PermissionError, OverflowError):
        return False
    return True


def _wait_until(pred, timeout: float, sleep=time.sleep, clock=time.monotonic) -> bool:
    deadline = clock() + timeout
    while clock() < deadline:
        if pred():
            return True
        sleep(POLL_SECS)
    return pred()


def up(root: pathlib.Path, *, popen=subprocess.Popen, http_ok=cli_serve_support.http_ok,
       wait_secs: float = PORTAL_WAIT_SECS) -> None:
    cfg = cli_runtime_mode.read_config(root)
    api = _api_base(cfg)
    pid = cli_serve.serve_running(root)
    res = None
    if cli_service.installed(root):
        # R3: every `up` re-installs the unit so a tool installed since (new PATH) or a
        # moved app (new python) is picked up. launchd restarts serve only when the plist
        # changed; `kickstart` (no -k) starts it when stopped and leaves a running one be.
        try:
            res = cli_service.install(root)
            cli_service.start(root)
        except cli_service.ServiceError as exc:
            print(f"[orcha] warn: background service: {exc}; starting orcha serve directly")
    if res is not None:
        if res["changed"]:
            print(f"[orcha] refreshed the background service ({res['plist']})")
        if pid and not res["changed"] and http_ok(f"{api}/"):
            print(f"[orcha] already running (orcha serve pid {pid}) — {api}/")
            return
        print("[orcha] starting Orcha through its background service (launchd) ...")
    elif pid and http_ok(f"{api}/"):
        print(f"[orcha] already running (orcha serve pid {pid}) — {api}/")
        return
    elif pid:
        print(f"[orcha] orcha serve is running (pid {pid}); waiting for the portal ...")
    else:
        log = cli_serve_support.log_path(root, "serve")
        log.parent.mkdir(parents=True, exist_ok=True)
        with open(log, "ab") as out:
            proc = popen(
                [sys.executable, "-m", "orcha_cli", "serve", "--project-dir", str(root)],
                cwd=str(root), stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        print(f"[orcha] started orcha serve (pid {proc.pid}); log: {log}")
    if _wait_until(lambda: http_ok(f"{api}/"), wait_secs):
        print(f"[orcha] ✓ portal up at {api}/")
    else:
        print(f"[orcha] warn: portal did not answer within {int(wait_secs)} s; "
              "check `orcha status` and `orcha logs portal`")


def _confirm_db_delete(db: pathlib.Path, yes: bool) -> None:
    if yes:
        return
    if not sys.stdin.isatty():
        sys.exit(f"error: `orcha down -v` deletes the database ({db}); "
                 "pass --yes to confirm when not running in a terminal.")
    answer = input(f"Delete the database {db} and all its data? [y/N] ").strip().lower()
    if answer not in ("y", "yes"):
        sys.exit("[orcha] aborted; nothing deleted.")


def down(root: pathlib.Path, *, volumes: bool = False, yes: bool = False,
         kill=os.kill, stop_secs: float = STOP_WAIT_SECS) -> None:
    cfg = cli_runtime_mode.read_config(root)
    db = cli_runtime_mode.db_path(root, cfg)
    if volumes:
        _confirm_db_delete(db, yes)  # ask before stopping anything
    if cli_service.stop(root):  # launchd stops serve; it loads again at the next login
        print("[orcha] stopped the background service (it starts again at the next login; "
              "`orcha service uninstall` removes it)")
        _wait_until(lambda: not cli_serve.serve_running(root), stop_secs)
    pid = cli_serve.serve_running(root)
    if pid:
        kill(pid, signal.SIGTERM)
        if not _wait_until(lambda: not _alive(pid), stop_secs):
            kill(pid, signal.SIGKILL)
        print(f"[orcha] stopped orcha serve (pid {pid})")
    else:
        print("[orcha] orcha serve is not running")
    cli_stacks_registry.unregister(_project_name(root, cfg))
    if volumes:
        removed = [p for p in (db.with_name(db.name + s) for s in DB_SUFFIXES) if p.exists()]
        for p in removed:
            p.unlink()
        print(f"[orcha] deleted {', '.join(str(p) for p in removed)}" if removed
              else f"[orcha] no database file at {db}")


def _size(path: pathlib.Path) -> str:
    try:
        n = float(path.stat().st_size)
    except OSError:
        return "missing"
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return ""


def status(root: pathlib.Path, cfg: dict) -> None:
    state = cli_serve_support.read_state(root)
    pid = cli_serve.serve_running(root)
    db = cli_runtime_mode.db_path(root, cfg)
    print("runtime:              native")
    print(f"bind:                 {cfg.get('bind') or state.get('bind') or 'loopback'}")
    print(f"bridge port:          {cfg.get('bridge_port', '?')}")
    print(f"orcha serve:          {f'running (pid {pid})' if pid else 'stopped'}")
    for name, child in (state.get("children") or {}).items() if pid else ():
        restarts = child.get("restarts", 0)
        print(f"  {name:<19} {child.get('status', '?')} (pid {child.get('pid') or '-'}, "
              f"restarts {restarts})")
    print(f"database:             {db} ({_size(db)})")
    print(f"logs:                 {cli_serve_support.logs_dir(root)}  (`orcha logs -f`)")


def db_migration_tip(root: pathlib.Path, cfg: dict | None = None, *,
                     get_json=None) -> int | None:
    """The database's migration tip (plan R-D1): asked of the running portal
    (``GET /api/admin/migrations``), else read straight from the SQLite file. ``None`` when
    neither answers (no database yet), which never blocks an upgrade."""
    cfg = cli_runtime_mode.read_config(root) if cfg is None else cfg
    data = (get_json or cli_http._get_json)(f"{_api_base(cfg)}/api/admin/migrations", timeout=3.0)
    if isinstance(data, dict) and isinstance(data.get("tip"), int):
        return data["tip"]
    db = cli_runtime_mode.db_path(root, cfg)
    if not db.exists():
        return None
    try:
        con = sqlite3.connect(f"{db.as_uri()}?mode=ro", uri=True)
        try:
            rows = con.execute("SELECT version FROM schema_migrations").fetchall()
        finally:
            con.close()
    except sqlite3.Error:
        return None
    return cli_project_setup.migration_tip_of(row[0] for row in rows)


def upgrade(root: pathlib.Path, services, *, allow_downgrade: bool = False,
            get_json=None) -> None:
    """Native `orcha upgrade`: nothing to re-render or rebuild (the portal is this CLI's own
    package), so refuse a downgrade, refresh skills/hooks, and restart `orcha serve`."""
    cfg = cli_runtime_mode.read_config(root)
    cli_tip = services._migration_tip(services.PKG_TEMPLATES / "migrations")
    db_tip = db_migration_tip(root, cfg, get_json=get_json)
    if db_tip is not None and cli_tip < db_tip and not allow_downgrade:
        sys.exit(
            f"error: this project's database is on a NEWER Orcha than your CLI "
            f"(database migrations reach {db_tip:03d}, this CLI ships {cli_tip:03d}).\n"
            "Running this CLI's portal against it would be a DOWNGRADE. Update the orcha CLI "
            "first (e.g. `uv tool upgrade orcha-cli`), then re-run `orcha upgrade` — or pass "
            "--allow-downgrade to roll back deliberately."
        )
    claude_commands, codex_skills = services._install_orcha_skill_templates(root)
    prefs_path = services._install_project_preferences(root)
    if prefs_path:
        print(f"[orcha] backfilled {prefs_path} (#298 loosely-hardened project rules)")
    print(f"[orcha] refreshed Claude commands: {claude_commands}")
    print(f"[orcha] refreshed Codex skills: {codex_skills}")
    if services._write_hook_config(root / ".claude"):
        print("[orcha] registered newly-shipped notification hooks / refreshed hook timeouts "
              "in .claude/settings.json")
    else:
        print("[orcha] notification hooks already up to date (.claude/settings.json)")
    print("[orcha] restarting orcha serve on this CLI's package (data preserved) ...")
    down(root)
    up(root)
    print("[orcha] ✓ upgraded. Pending migrations apply on portal startup; `orcha migrate` to force now.")
