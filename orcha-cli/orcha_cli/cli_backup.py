"""`orcha backup` / `orcha restore` for native-runtime projects (GH #258 plan S7, PR 11).

``orcha backup`` copies the live SQLite database with ``VACUUM INTO`` through its own
connection, so it works while ``orcha serve`` is running: the copy is one consistent
snapshot, written to ``<name>.partial`` and renamed into place, then checked with
``PRAGMA integrity_check``. Backups go to ``.orcha/backups/orcha-<UTC ts>.db`` and the
newest 10 are kept (``--keep N``); ``--out PATH`` writes one file anywhere and prunes
nothing.

``orcha restore FILE`` refuses while ``orcha serve`` runs (the portal holds the file open).
It checks the backup first (integrity, and that it is not from a newer Orcha than this CLI),
moves the current database aside to ``orcha.db.before-restore-<ts>`` (with its ``-wal`` and
``-shm``, so nothing is ever lost), copies the backup into place and checks it again.

Both take ``--json`` (one JSON object per line) for the Mac app.
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import pathlib
import shutil
import sqlite3
import sys
from typing import Optional

from orcha_cli import cli_project_setup, cli_runtime_mode, cli_serve

KEEP_DEFAULT = 10
BACKUP_GLOB = "orcha-*.db"
DB_SUFFIXES = ("", "-wal", "-shm")


class BackupError(RuntimeError):
    """The command stopped; the message says why and what to do."""


def backups_dir(root: pathlib.Path) -> pathlib.Path:
    return pathlib.Path(root) / ".orcha" / "backups"


def _stamp(now: Optional[_dt.datetime] = None) -> str:
    now = now or _dt.datetime.now(_dt.timezone.utc)
    return now.strftime("%Y%m%dT%H%M%S") + f"{now.microsecond // 1000:03d}Z"


def _native_db(root: pathlib.Path) -> pathlib.Path:
    cfg = cli_runtime_mode.read_config(root)
    if not cli_runtime_mode.is_native_project(root, cfg):
        raise BackupError("backup and restore are for native projects (no Docker); "
                          "this folder is not one")
    return cli_runtime_mode.db_path(root, cfg)


def _integrity(path: pathlib.Path) -> str:
    try:
        con = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)
        try:
            return con.execute("PRAGMA integrity_check").fetchone()[0]
        finally:
            con.close()
    except sqlite3.Error as exc:
        return f"not a readable SQLite database ({exc})"


def _migration_tip(path: pathlib.Path) -> int:
    con = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)
    try:
        rows = con.execute("SELECT version FROM schema_migrations").fetchall()
    except sqlite3.Error:
        rows = []
    finally:
        con.close()
    return cli_project_setup.migration_tip_of(r[0] for r in rows)


def _cli_tip() -> int:
    return cli_project_setup.migration_tip(
        pathlib.Path(__file__).resolve().parent / "templates" / "migrations")


def backup(root: pathlib.Path, *, out: Optional[pathlib.Path] = None, keep: int = KEEP_DEFAULT,
           now: Optional[_dt.datetime] = None) -> dict:
    db = _native_db(root)
    if not db.exists():
        raise BackupError(f"there is no database yet at {db}")
    target = pathlib.Path(out) if out else backups_dir(root) / f"orcha-{_stamp(now)}.db"
    if target.exists():
        raise BackupError(f"{target} already exists; choose another --out")
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".partial")
    if partial.exists():
        partial.unlink()
    con = sqlite3.connect(str(db), timeout=30.0)
    try:
        con.execute("PRAGMA busy_timeout=30000")
        con.execute("VACUUM INTO ?", (str(partial),))
    except sqlite3.Error as exc:
        if partial.exists():
            partial.unlink()
        raise BackupError(f"the backup failed: {exc}") from exc
    finally:
        con.close()
    check = _integrity(partial)
    if check != "ok":
        partial.unlink()
        raise BackupError(f"the backup did not pass its integrity check: {check}")
    os.replace(partial, target)
    pruned = []
    if out is None and keep > 0:
        olds = sorted(backups_dir(root).glob(BACKUP_GLOB))[:-keep]
        for old in olds:
            old.unlink()
            pruned.append(str(old))
    return {"path": str(target), "bytes": target.stat().st_size, "pruned": pruned}


def restore(root: pathlib.Path, source: pathlib.Path, *,
            now: Optional[_dt.datetime] = None) -> dict:
    db = _native_db(root)
    pid = cli_serve.serve_running(root)
    if pid:
        raise BackupError(f"Orcha is running (orcha serve pid {pid}); stop it with "
                          "`orcha down`, restore, then `orcha up`")
    source = pathlib.Path(source)
    if not source.is_file():
        raise BackupError(f"no backup file at {source}")
    check = _integrity(source)
    if check != "ok":
        raise BackupError(f"{source} is damaged ({check}); nothing was changed")
    tip, cli_tip = _migration_tip(source), _cli_tip()
    if tip > cli_tip:
        raise BackupError(f"{source} comes from a newer Orcha (migrations up to {tip:03d}; this "
                          f"CLI ships {cli_tip:03d}). Update the orcha CLI first.")
    kept = None
    if db.exists():
        kept = db.with_name(f"{db.name}.before-restore-{_stamp(now)}")
        for suffix in DB_SUFFIXES:
            side = db.with_name(db.name + suffix)
            if side.exists():
                os.replace(side, kept.with_name(kept.name + suffix))
    db.parent.mkdir(parents=True, exist_ok=True)
    partial = db.with_name(db.name + ".partial")
    shutil.copyfile(source, partial)
    os.replace(partial, db)
    check = _integrity(db)
    if check != "ok":  # pragma: no cover - the source passed the same check a moment ago
        raise BackupError(f"the restored database failed its integrity check: {check}")
    return {"restored": str(db), "from": str(source), "previous_kept_at": str(kept) if kept else None}


def _emit(as_json: bool, ok: bool, payload: dict, human: str) -> None:
    if as_json:
        print(json.dumps({"event": "result" if ok else "error", "ok": ok, **payload}), flush=True)
    elif ok:
        print(human, flush=True)
    else:
        print(f"error: {human}", file=sys.stderr, flush=True)


def _root(args) -> pathlib.Path:
    return pathlib.Path(getattr(args, "project_dir", None) or pathlib.Path.cwd()).resolve()


def cmd_backup(args) -> None:
    try:
        res = backup(_root(args), out=pathlib.Path(args.out) if args.out else None, keep=args.keep)
    except BackupError as exc:
        _emit(args.json, False, {"error": str(exc)}, str(exc))
        sys.exit(1)
    extra = f" (removed {len(res['pruned'])} old backup(s))" if res["pruned"] else ""
    _emit(args.json, True, res, f"[orcha] ✓ backup saved to {res['path']}{extra}")


def cmd_restore(args) -> None:
    try:
        res = restore(_root(args), pathlib.Path(args.file))
    except BackupError as exc:
        _emit(args.json, False, {"error": str(exc)}, str(exc))
        sys.exit(1)
    kept = (f"\n        the database it replaced is kept at {res['previous_kept_at']}"
            if res["previous_kept_at"] else "")
    _emit(args.json, True, res, f"[orcha] ✓ restored {res['from']}{kept}\n"
                                "        start Orcha again with `orcha up`")
