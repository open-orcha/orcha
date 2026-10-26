"""`orcha backup` / `orcha restore` for native-runtime projects (GH #258 plan S7, PR 11).

``orcha backup`` copies the live SQLite database with ``VACUUM INTO`` through its own
connection, so it works while ``orcha serve`` is running. It then copies the immutable
attachment store and writes a hash manifest. The database path remains the command's
handle, with ``.attachments`` and ``.manifest.json`` companions. Publishing the database
last means a visible new backup is always a complete verified set.

``orcha restore FILE`` refuses while ``orcha serve`` runs (the portal holds the file open).
It checks the backup first (integrity, and that it is not from a newer Orcha than this CLI),
moves the current database and attachments aside to ``*.before-restore-<ts>`` so nothing
is lost, restores the verified pair, and audits every current or accepted workflow
evidence file. Legacy database-only backups remain restorable, but their attachment store
starts empty and missing evidence is durably reported as ``missing_after_restore``.

Both take ``--json`` (one JSON object per line) for the Mac app.
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import pathlib
import shutil
import sqlite3
import sys
import uuid
from typing import Optional

from orcha_cli import cli_project_setup, cli_runtime_mode, cli_serve

KEEP_DEFAULT = 10
BACKUP_GLOB = "orcha-*.db"
DB_SUFFIXES = ("", "-wal", "-shm")
ATTACHMENTS_REL = pathlib.Path(".claude") / ".orcha-attachments"
ATTACHMENTS_SUFFIX = ".attachments"
MANIFEST_SUFFIX = ".manifest.json"
BACKUP_FORMAT = 1


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


def _attachments(root: pathlib.Path) -> pathlib.Path:
    return pathlib.Path(root) / ATTACHMENTS_REL


def _attachment_backup(path: pathlib.Path) -> pathlib.Path:
    return path.with_name(path.name + ATTACHMENTS_SUFFIX)


def _manifest_path(path: pathlib.Path) -> pathlib.Path:
    return path.with_name(path.name + MANIFEST_SUFFIX)


def _inside(path: pathlib.Path, directory: pathlib.Path) -> bool:
    try:
        path.resolve().relative_to(directory.resolve())
        return True
    except ValueError:
        return False


def _same_file(left: pathlib.Path, right: pathlib.Path) -> bool:
    """Return whether two existing paths name the same file, including symlinks."""
    try:
        return os.path.samefile(left, right)
    except (FileNotFoundError, OSError):
        return left.resolve() == right.resolve()


def _discard_path(path: pathlib.Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
    elif path.exists():
        shutil.rmtree(path)


def _discard_database_files(path: pathlib.Path) -> None:
    for suffix in DB_SUFFIXES:
        _discard_path(path.with_name(path.name + suffix))


def _sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _attachment_entries(root: pathlib.Path) -> list[dict]:
    entries = []
    if not root.exists():
        return entries
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise BackupError(f"attachment backup refuses symbolic link {path}")
        if path.is_file():
            entries.append({
                "path": path.relative_to(root).as_posix(),
                "bytes": path.stat().st_size,
                "sha256": _sha256(path),
            })
    return entries


def _copy_attachment_tree(source: pathlib.Path, target: pathlib.Path) -> list[dict]:
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)
    if source.exists():
        for path in sorted(source.rglob("*")):
            relative = path.relative_to(source)
            destination = target / relative
            if path.is_symlink():
                raise BackupError(f"attachment backup refuses symbolic link {path}")
            if path.is_dir():
                destination.mkdir(parents=True, exist_ok=True)
            elif path.is_file():
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, destination)
    return _attachment_entries(target)


def _verify_attachment_tree(root: pathlib.Path, expected: list[dict]) -> None:
    actual = _attachment_entries(root)
    if actual != expected:
        raise BackupError("the attachment snapshot does not match its hash manifest")


def _remove_backup_set(path: pathlib.Path) -> None:
    path.unlink(missing_ok=True)
    manifest = _manifest_path(path)
    manifest.unlink(missing_ok=True)
    attachments = _attachment_backup(path)
    if attachments.exists():
        shutil.rmtree(attachments)


def _load_backup_manifest(source: pathlib.Path) -> Optional[dict]:
    manifest_path = _manifest_path(source)
    attachments = _attachment_backup(source)
    if not manifest_path.exists() and not attachments.exists():
        return None
    if not manifest_path.is_file() or not attachments.is_dir():
        raise BackupError("the backup's database/attachments pair is incomplete")
    try:
        manifest = json.loads(manifest_path.read_text())
    except (OSError, ValueError) as exc:
        raise BackupError("the backup attachment manifest is unreadable") from exc
    if manifest.get("format") != BACKUP_FORMAT:
        raise BackupError("the backup attachment manifest uses an unsupported format")
    if manifest.get("database", {}).get("sha256") != _sha256(source):
        raise BackupError("the backup database does not match its hash manifest")
    expected = manifest.get("attachments")
    if not isinstance(expected, list):
        raise BackupError("the backup attachment manifest is incomplete")
    _verify_attachment_tree(attachments, expected)
    return manifest


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
    if target.resolve() == db.resolve() or _inside(target, _attachments(root)):
        raise BackupError("the backup destination cannot be the live database or attachment tree")
    target_attachments = _attachment_backup(target)
    target_manifest = _manifest_path(target)
    if target.exists() or target_attachments.exists() or target_manifest.exists():
        raise BackupError(f"{target} already exists; choose another --out")
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".partial")
    partial_attachments = target_attachments.with_name(target_attachments.name + ".partial")
    partial_manifest = target_manifest.with_name(target_manifest.name + ".partial")
    if partial.exists():
        partial.unlink()
    if partial_attachments.exists():
        shutil.rmtree(partial_attachments)
    partial_manifest.unlink(missing_ok=True)
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
    try:
        attachments = _copy_attachment_tree(_attachments(root), partial_attachments)
        manifest = {
            "format": BACKUP_FORMAT,
            "created_at": (now or _dt.datetime.now(_dt.timezone.utc)).isoformat(),
            "database": {"bytes": partial.stat().st_size, "sha256": _sha256(partial)},
            "attachments": attachments,
        }
        partial_manifest.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
        _verify_attachment_tree(partial_attachments, attachments)
        os.replace(partial_attachments, target_attachments)
        os.replace(partial_manifest, target_manifest)
        # Publish the database last: its presence means both companions are ready.
        os.replace(partial, target)
    except (OSError, BackupError) as exc:
        partial.unlink(missing_ok=True)
        partial_manifest.unlink(missing_ok=True)
        if partial_attachments.exists():
            shutil.rmtree(partial_attachments)
        _remove_backup_set(target)
        if isinstance(exc, BackupError):
            raise
        raise BackupError(f"the attachment backup failed: {exc}") from exc
    pruned = []
    if out is None and keep > 0:
        olds = sorted(backups_dir(root).glob(BACKUP_GLOB))[:-keep]
        for old in olds:
            _remove_backup_set(old)
            pruned.append(str(old))
    return {
        "path": str(target),
        "bytes": target.stat().st_size,
        "attachments_path": str(target_attachments),
        "attachment_files": len(attachments),
        "manifest_path": str(target_manifest),
        "pruned": pruned,
    }


def _restore_audit(root: pathlib.Path, db: pathlib.Path) -> dict:
    """Audit exact current/accepted evidence and persist both state and history.

    The JSON marker lets the evidence read API distinguish a file lost during a
    database-only restore from an ordinary missing file. The append-only database
    events keep a visible audit history even if a later repair makes the file readable.
    Older backups without Workflows tables legitimately produce an empty audit.
    """
    attachment_root = _attachments(root)
    restore_id = str(uuid.uuid4())
    audited_at = _dt.datetime.now(_dt.timezone.utc).isoformat()
    con = sqlite3.connect(str(db))
    con.row_factory = sqlite3.Row
    try:
        tables = {row[0] for row in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()}
        needed = {
            "workflow_evidence", "workflow_evidence_sets", "workflow_executions",
            "workflow_task_acceptances", "task_deliverable_versions", "workflows",
        }
        rows = []
        if needed <= tables:
            rows = con.execute(
                """SELECT DISTINCT e.id,e.task_id,e.deliverable_id,
                                  e.deliverable_version,e.sha256,v.stored_name,
                                  s.workflow_id,w.container_id
                     FROM workflow_evidence e
                     JOIN workflow_evidence_sets s ON s.id=e.evidence_set_id
                     JOIN workflows w ON w.id=s.workflow_id
                     JOIN task_deliverable_versions v
                       ON v.deliverable_id=e.deliverable_id
                      AND v.version=e.deliverable_version
                    WHERE s.id IN (
                        SELECT current_evidence_set_id FROM workflow_executions
                         WHERE current_evidence_set_id IS NOT NULL
                        UNION
                        SELECT evidence_set_id FROM workflow_task_acceptances
                    )
                    ORDER BY e.id"""
            ).fetchall()
        items, by_workflow = [], {}
        for row in rows:
            relative = pathlib.Path("deliverables") / str(row["task_id"]) \
                / str(row["deliverable_id"]) / row["stored_name"]
            path = attachment_root / relative
            if path.is_symlink() or not path.is_file():
                state = "missing_after_restore"
            else:
                state = "readable" if _sha256(path) == row["sha256"] else "corrupt"
            item = {
                "evidence_id": str(row["id"]),
                "path": relative.as_posix(),
                "sha256": row["sha256"],
                "storage_state": state,
                "workflow_id": str(row["workflow_id"]),
            }
            items.append(item)
            counts = by_workflow.setdefault(
                (str(row["workflow_id"]), str(row["container_id"])),
                {"readable": 0, "missing_after_restore": 0, "corrupt": 0},
            )
            counts[state] += 1

        audit_dir = attachment_root / ".restore-audits"
        audit_dir.mkdir(parents=True, exist_ok=True)
        document = {"restore_id": restore_id, "audited_at": audited_at, "items": items}
        history = audit_dir / f"{audited_at.replace(':', '').replace('+', '_')}-{restore_id}.json"
        history.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n")
        current = audit_dir / "current.json"
        current_partial = audit_dir / "current.json.partial"
        current_partial.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n")
        os.replace(current_partial, current)

        if "events" in tables:
            for (workflow_id, container_id), counts in by_workflow.items():
                detail = {
                    "restore_id": restore_id, "audited_at": audited_at, **counts,
                }
                if counts["missing_after_restore"] or counts["corrupt"]:
                    detail["warning"] = (
                        "Saved evidence is unavailable after restore; acceptance remains blocked."
                    )
                con.execute(
                    """INSERT INTO events
                         (container_id,actor_type,actor_id,entity_type,entity_id,event_type,detail)
                       VALUES (?, 'system', NULL, 'workflow', ?,
                               'workflow_evidence_restore_audited', ?)""",
                    (container_id, workflow_id, json.dumps(detail)),
                )
                if "workflow_history" in tables:
                    revision = con.execute(
                        "SELECT revision FROM workflows WHERE id=?", (workflow_id,)
                    ).fetchone()[0]
                    con.execute(
                        """INSERT INTO workflow_history
                             (id,workflow_id,task_id,actor_id,actor_kind,actor_alias,
                              event,revision,detail)
                           VALUES (?, ?, NULL, NULL, 'system', 'Orcha restore',
                                   'workflow_evidence_restore_audited', ?, ?)""",
                        (str(uuid.uuid4()), workflow_id, revision, json.dumps(detail)),
                    )
        con.commit()
    finally:
        con.close()
    counts = {"readable": 0, "missing_after_restore": 0, "corrupt": 0}
    for item in items:
        counts[item["storage_state"]] += 1
    return {"restore_id": restore_id, "audited": len(items), **counts}


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
    if _same_file(source, db):
        raise BackupError("the restore source cannot be the live database")
    if _inside(source, _attachments(root)):
        raise BackupError("move the backup outside the live attachment tree before restoring it")
    check = _integrity(source)
    if check != "ok":
        raise BackupError(f"{source} is damaged ({check}); nothing was changed")
    tip, cli_tip = _migration_tip(source), _cli_tip()
    if tip > cli_tip:
        raise BackupError(f"{source} comes from a newer Orcha (migrations up to {tip:03d}; this "
                          f"CLI ships {cli_tip:03d}). Update the orcha CLI first.")
    manifest = _load_backup_manifest(source)
    live_attachments = _attachments(root)
    stage_id = uuid.uuid4().hex
    partial = db.with_name(f".{db.name}.restore-{stage_id}.partial")
    partial_attachments = live_attachments.with_name(
        f".{live_attachments.name}.restore-{stage_id}.partial"
    )
    db.parent.mkdir(parents=True, exist_ok=True)
    live_attachments.parent.mkdir(parents=True, exist_ok=True)
    try:
        shutil.copyfile(source, partial)
        staged_check = _integrity(partial)
        if staged_check != "ok":
            raise BackupError(
                f"the staged database failed its integrity check: {staged_check}"
            )
        if (manifest is not None
                and _sha256(partial) != manifest["database"]["sha256"]):
            raise BackupError("the staged database does not match its hash manifest")
        if manifest is None:
            partial_attachments.mkdir(parents=True)
        else:
            _copy_attachment_tree(_attachment_backup(source), partial_attachments)
            _verify_attachment_tree(partial_attachments, manifest["attachments"])
    except (OSError, BackupError) as exc:
        _discard_database_files(partial)
        _discard_path(partial_attachments)
        if isinstance(exc, BackupError):
            raise
        raise BackupError(
            f"the restore could not be staged; nothing was changed: {exc}"
        ) from exc

    kept = None
    stamp = _stamp(now)
    kept_db_files: list[tuple[pathlib.Path, pathlib.Path]] = []
    if db.exists():
        kept = db.with_name(f"{db.name}.before-restore-{stamp}")
    kept_attachments = None
    if live_attachments.exists():
        kept_attachments = live_attachments.with_name(
            f"{live_attachments.name}.before-restore-{stamp}"
        )
    conflicts = []
    if kept is not None:
        conflicts.extend(
            kept.with_name(kept.name + suffix)
            for suffix in DB_SUFFIXES
            if kept.with_name(kept.name + suffix).exists()
        )
    if kept_attachments is not None and kept_attachments.exists():
        conflicts.append(kept_attachments)
    if conflicts:
        _discard_database_files(partial)
        _discard_path(partial_attachments)
        raise BackupError(
            f"restore safety copy already exists at {conflicts[0]}; nothing was changed"
        )

    attachments_moved = False
    database_installed = False
    attachments_installed = False
    try:
        if kept is not None:
            for suffix in DB_SUFFIXES:
                side = db.with_name(db.name + suffix)
                if side.exists():
                    kept_side = kept.with_name(kept.name + suffix)
                    os.replace(side, kept_side)
                    kept_db_files.append((kept_side, side))
        if kept_attachments is not None:
            os.replace(live_attachments, kept_attachments)
            attachments_moved = True

        os.replace(partial, db)
        database_installed = True
        os.replace(partial_attachments, live_attachments)
        attachments_installed = True

        restored_check = _integrity(db)
        if restored_check != "ok":  # pragma: no cover - staged copy passed moments ago
            raise BackupError(
                f"the restored database failed its integrity check: {restored_check}"
            )
        audit = _restore_audit(root, db)
    except Exception as exc:
        rollback_errors = []

        def attempt_rollback(action) -> None:
            try:
                action()
            except OSError as rollback_exc:  # pragma: no cover - double failure
                rollback_errors.append(str(rollback_exc))

        if attachments_installed:
            attempt_rollback(lambda: _discard_path(live_attachments))
        if database_installed:
            attempt_rollback(lambda: _discard_database_files(db))
        for kept_side, original_side in reversed(kept_db_files):
            if kept_side.exists():
                attempt_rollback(
                    lambda old=kept_side, live=original_side: os.replace(old, live)
                )
        if (attachments_moved and kept_attachments is not None
                and kept_attachments.exists()):
            attempt_rollback(lambda: os.replace(kept_attachments, live_attachments))
        attempt_rollback(lambda: _discard_database_files(partial))
        attempt_rollback(lambda: _discard_path(partial_attachments))
        if rollback_errors:
            kept_hint = str(kept) if kept is not None else "the restore staging area"
            raise BackupError(
                "the restore failed and automatic rollback was incomplete; "
                f"recover the previous files from {kept_hint}: {rollback_errors[0]}"
            ) from exc
        raise BackupError(
            "the restore failed; the previous database and attachments were restored: "
            f"{exc}"
        ) from exc
    finally:
        _discard_database_files(partial)
        _discard_path(partial_attachments)

    return {
        "restored": str(db),
        "from": str(source),
        "attachments_from": str(_attachment_backup(source)) if manifest else None,
        "previous_kept_at": str(kept) if kept else None,
        "previous_attachments_kept_at": str(kept_attachments) if kept_attachments else None,
        "evidence_audit": audit,
    }


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
    audit = res["evidence_audit"]
    warning = ""
    if audit["missing_after_restore"] or audit["corrupt"]:
        warning = (
            f"\n        WARNING: evidence audit found {audit['missing_after_restore']} missing "
            f"and {audit['corrupt']} corrupt file(s); acceptance remains blocked"
        )
    _emit(args.json, True, res, f"[orcha] ✓ restored {res['from']}{kept}{warning}\n"
                                "        start Orcha again with `orcha up`")
