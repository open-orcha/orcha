"""GH #258 plan S7 (PR 11) — `orcha backup` / `orcha restore` (orcha_cli.cli_backup).

The acceptance check (SQLite leg): a backup taken while another thread keeps writing to the
live database restores into a fresh project whose API serves the same S8 parity snapshot as
the live portal did. The rest pins rotation, never-overwrite, the "serve is running" refusal,
damaged / newer-Orcha backups, and that a restore never loses the database it replaces.
"""
import datetime as _dt
import json
import pathlib
import sqlite3
import threading
import time

import pytest

import main
from conftest import BACKEND, TEST_DB_PATH
from orcha_cli import cli_backup
from test_dialect_parity import _endpoints, _run_scenario, diff_recordings, record
from test_pg_to_sqlite import _leaf_diff, _mask, _serve_from_sqlite

UTC = _dt.timezone.utc


def _native_project(root: pathlib.Path, db: pathlib.Path) -> pathlib.Path:
    (root / ".claude").mkdir(parents=True, exist_ok=True)
    (root / ".claude" / "orcha.json").write_text(json.dumps(
        {"runtime": "native", "db_path": str(db), "project_name": root.name}))
    return root


def _small_db(path: pathlib.Path, rows=3, versions=("001_baseline.sql",)) -> pathlib.Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(path))
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT)")
    con.executemany("INSERT INTO schema_migrations VALUES (?, 'x')", [(v,) for v in versions])
    con.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
    con.executemany("INSERT INTO t (v) VALUES (?)", [(f"row{i}",) for i in range(rows)])
    con.commit()
    con.close()
    return path


def _rows(path):
    con = sqlite3.connect(str(path))
    try:
        return con.execute("SELECT v FROM t ORDER BY id").fetchall()
    finally:
        con.close()


@pytest.fixture
def proj(tmp_path):
    return _native_project(tmp_path / "proj", _small_db(tmp_path / "proj" / ".orcha" / "orcha.db"))


# ---------------------------------------------------------------- backup

def test_backup_lands_in_backups_dir_and_matches(proj):
    attachment = proj / ".claude" / ".orcha-attachments" / "deliverables" / "a.txt"
    attachment.parent.mkdir(parents=True)
    attachment.write_text("saved evidence")
    res = cli_backup.backup(proj)
    path = pathlib.Path(res["path"])
    assert path.parent == proj / ".orcha" / "backups" and path.name.startswith("orcha-")
    assert path.name.endswith(".db") and not list(path.parent.glob("*.partial"))
    assert _rows(path) == _rows(proj / ".orcha" / "orcha.db") and res["bytes"] > 0
    copied = pathlib.Path(res["attachments_path"]) / "deliverables" / "a.txt"
    assert copied.read_text() == "saved evidence"
    manifest = json.loads(pathlib.Path(res["manifest_path"]).read_text())
    assert manifest["format"] == cli_backup.BACKUP_FORMAT
    assert manifest["attachments"][0]["path"] == "deliverables/a.txt"
    assert res["pruned"] == []


def test_backup_rotation_keeps_the_newest(proj):
    t0 = _dt.datetime(2026, 10, 6, 12, 0, tzinfo=UTC)
    names = [pathlib.Path(cli_backup.backup(proj, keep=3, now=t0 + _dt.timedelta(minutes=i))["path"]).name
             for i in range(5)]
    kept = sorted(p.name for p in (proj / ".orcha" / "backups").glob("orcha-*.db"))
    assert kept == names[-3:]
    assert sorted(p.name.removesuffix(cli_backup.ATTACHMENTS_SUFFIX)
                  for p in (proj / ".orcha" / "backups").glob("*.db.attachments")) == kept
    assert sorted(p.name.removesuffix(cli_backup.MANIFEST_SUFFIX)
                  for p in (proj / ".orcha" / "backups").glob("*.db.manifest.json")) == kept


def test_backup_out_never_overwrites_and_never_prunes(proj, tmp_path):
    out = tmp_path / "elsewhere" / "copy.db"
    assert cli_backup.backup(proj, out=out)["path"] == str(out)
    with pytest.raises(cli_backup.BackupError, match="already exists"):
        cli_backup.backup(proj, out=out)
    assert _rows(out) == _rows(proj / ".orcha" / "orcha.db")


def test_backup_refuses_live_database_and_attachment_destinations(proj):
    with pytest.raises(cli_backup.BackupError, match="live database or attachment tree"):
        cli_backup.backup(proj, out=proj / ".orcha" / "orcha.db")
    with pytest.raises(cli_backup.BackupError, match="live database or attachment tree"):
        cli_backup.backup(
            proj, out=proj / ".claude" / ".orcha-attachments" / "recursive.db"
        )


def test_backup_and_restore_refuse_a_docker_project(tmp_path):
    root = tmp_path / "docker"
    (root / ".claude").mkdir(parents=True)
    (root / ".orcha").mkdir()
    (root / ".orcha" / "docker-compose.yml").write_text("services: {}\n")
    (root / ".claude" / "orcha.json").write_text(json.dumps({"db_port": 5499}))
    with pytest.raises(cli_backup.BackupError, match="native"):
        cli_backup.backup(root)
    with pytest.raises(cli_backup.BackupError, match="native"):
        cli_backup.restore(root, tmp_path / "x.db")


# ---------------------------------------------------------------- restore

def test_restore_refuses_while_serve_runs(proj, monkeypatch):
    backup = pathlib.Path(cli_backup.backup(proj)["path"])
    monkeypatch.setattr(cli_backup.cli_serve, "serve_running", lambda root: 4242)
    before = (proj / ".orcha" / "orcha.db").read_bytes()
    with pytest.raises(cli_backup.BackupError, match="orcha down"):
        cli_backup.restore(proj, backup)
    assert (proj / ".orcha" / "orcha.db").read_bytes() == before


def test_restore_replaces_and_keeps_the_previous_database(proj, tmp_path):
    other = _small_db(tmp_path / "other.db", rows=7)
    live = proj / ".orcha" / "orcha.db"
    live_rows = _rows(live)
    (proj / ".orcha" / "orcha.db-wal").write_bytes(b"")  # a stale WAL must not survive
    res = cli_backup.restore(proj, other)
    assert _rows(live) == _rows(other) and len(_rows(live)) == 7
    kept = pathlib.Path(res["previous_kept_at"])
    assert kept.exists() and kept.name.startswith("orcha.db.before-restore-")
    assert (kept.parent / (kept.name + "-wal")).exists()  # moved with it (before opening it)
    assert _rows(kept) == live_rows
    assert not (proj / ".orcha" / "orcha.db-wal").exists()


def test_restore_refuses_live_database_or_symlink_as_source(proj):
    live = proj / ".orcha" / "orcha.db"
    before = live.read_bytes()
    aliases = [live, proj / "live-database-link.db"]
    aliases[1].symlink_to(live)

    for source in aliases:
        with pytest.raises(cli_backup.BackupError, match="cannot be the live database"):
            cli_backup.restore(proj, source)
        assert live.read_bytes() == before
        assert not list((proj / ".orcha").glob("orcha.db.before-restore-*"))


def test_restore_copy_failure_leaves_live_database_and_attachments(
        proj, tmp_path, monkeypatch):
    source = _small_db(tmp_path / "replacement.db", rows=7)
    live = proj / ".orcha" / "orcha.db"
    before_rows = _rows(live)
    evidence = proj / ".claude" / ".orcha-attachments" / "live.txt"
    evidence.parent.mkdir(parents=True)
    evidence.write_text("live evidence")

    def fail_copy(_source, _target):
        raise OSError("injected staging copy failure")

    monkeypatch.setattr(cli_backup.shutil, "copyfile", fail_copy)
    with pytest.raises(cli_backup.BackupError, match="nothing was changed"):
        cli_backup.restore(proj, source)

    assert _rows(live) == before_rows
    assert evidence.read_text() == "live evidence"
    assert not list((proj / ".orcha").glob("orcha.db.before-restore-*"))


def test_restore_swap_failure_rolls_back_live_pair(proj, tmp_path, monkeypatch):
    source = _small_db(tmp_path / "replacement.db", rows=7)
    live = proj / ".orcha" / "orcha.db"
    before_rows = _rows(live)
    live_attachments = proj / ".claude" / ".orcha-attachments"
    evidence = live_attachments / "live.txt"
    evidence.parent.mkdir(parents=True)
    evidence.write_text("live evidence")
    real_replace = cli_backup.os.replace
    failed = False

    def fail_attachment_install(source_path, target_path):
        nonlocal failed
        source_path = pathlib.Path(source_path)
        target_path = pathlib.Path(target_path)
        if (not failed and target_path == live_attachments
                and ".restore-" in source_path.name):
            failed = True
            raise OSError("injected attachment swap failure")
        return real_replace(source_path, target_path)

    monkeypatch.setattr(cli_backup.os, "replace", fail_attachment_install)
    with pytest.raises(
            cli_backup.BackupError,
            match="previous database and attachments were restored"):
        cli_backup.restore(proj, source)

    assert failed
    assert _rows(live) == before_rows
    assert evidence.read_text() == "live evidence"
    assert not list((proj / ".orcha").glob("orcha.db.before-restore-*"))
    assert not list((proj / ".claude").glob(".orcha-attachments.before-restore-*"))


def test_restore_audit_failure_rolls_back_live_pair(proj, tmp_path, monkeypatch):
    source = _small_db(tmp_path / "replacement.db", rows=7)
    live = proj / ".orcha" / "orcha.db"
    before_rows = _rows(live)
    evidence = proj / ".claude" / ".orcha-attachments" / "live.txt"
    evidence.parent.mkdir(parents=True)
    evidence.write_text("live evidence")

    def fail_audit(_root, _db):
        raise OSError("injected post-swap audit failure")

    monkeypatch.setattr(cli_backup, "_restore_audit", fail_audit)
    with pytest.raises(
            cli_backup.BackupError,
            match="previous database and attachments were restored"):
        cli_backup.restore(proj, source)

    assert _rows(live) == before_rows
    assert evidence.read_text() == "live evidence"
    assert not list((proj / ".orcha").glob("orcha.db.before-restore-*"))
    assert not list((proj / ".claude").glob(".orcha-attachments.before-restore-*"))


def test_restore_replaces_and_keeps_the_attachment_tree(proj):
    live_attachments = proj / ".claude" / ".orcha-attachments"
    evidence = live_attachments / "deliverables" / "task" / "file.txt"
    evidence.parent.mkdir(parents=True)
    evidence.write_text("backed up")
    backup = pathlib.Path(cli_backup.backup(proj)["path"])

    evidence.write_text("new live value")
    extra = live_attachments / "later.txt"
    extra.write_text("created later")
    result = cli_backup.restore(proj, backup)

    assert evidence.read_text() == "backed up"
    assert not extra.exists()
    kept = pathlib.Path(result["previous_attachments_kept_at"])
    assert (kept / "deliverables" / "task" / "file.txt").read_text() == "new live value"
    assert (kept / "later.txt").read_text() == "created later"
    assert result["attachments_from"] == str(cli_backup._attachment_backup(backup))


def test_database_only_restore_audits_missing_current_and_accepted_evidence(
        proj, tmp_path):
    source = _small_db(tmp_path / "legacy-workflow.db")
    con = sqlite3.connect(source)
    con.executescript("""
        CREATE TABLE workflows (
            id TEXT PRIMARY KEY, container_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE workflow_evidence_sets (
            id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL
        );
        CREATE TABLE workflow_evidence (
            id TEXT PRIMARY KEY, evidence_set_id TEXT NOT NULL, task_id TEXT NOT NULL,
            deliverable_id TEXT NOT NULL, deliverable_version INTEGER NOT NULL,
            sha256 TEXT NOT NULL
        );
        CREATE TABLE workflow_executions (current_evidence_set_id TEXT);
        CREATE TABLE workflow_task_acceptances (evidence_set_id TEXT);
        CREATE TABLE task_deliverable_versions (
            deliverable_id TEXT, version INTEGER, stored_name TEXT
        );
        CREATE TABLE events (
            id INTEGER PRIMARY KEY AUTOINCREMENT, container_id TEXT, actor_type TEXT,
            actor_id TEXT, entity_type TEXT, entity_id TEXT, event_type TEXT,
            detail TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE workflow_history (
            id TEXT PRIMARY KEY, workflow_id TEXT, task_id TEXT, actor_id TEXT,
            actor_kind TEXT, actor_alias TEXT, event TEXT, revision INTEGER,
            detail TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO workflows VALUES ('workflow-1', 'container-1', 7);
        INSERT INTO workflow_evidence_sets VALUES ('set-1', 'workflow-1');
        INSERT INTO workflow_evidence_sets VALUES ('set-accepted', 'workflow-1');
        INSERT INTO workflow_evidence VALUES (
            'evidence-1', 'set-1', 'task-1', 'deliverable-1', 1, 'abc'
        );
        INSERT INTO workflow_evidence VALUES (
            'evidence-accepted', 'set-accepted', 'task-accepted',
            'deliverable-accepted', 1, 'def'
        );
        INSERT INTO workflow_executions VALUES ('set-1');
        INSERT INTO workflow_task_acceptances VALUES ('set-accepted');
        INSERT INTO task_deliverable_versions VALUES ('deliverable-1', 1, 'v1.txt');
        INSERT INTO task_deliverable_versions VALUES ('deliverable-accepted', 1, 'v1.txt');
    """)
    con.commit()
    con.close()

    result = cli_backup.restore(proj, source)
    audit = result["evidence_audit"]
    assert audit["audited"] == 2 and audit["missing_after_restore"] == 2
    marker = proj / ".claude" / ".orcha-attachments" / ".restore-audits" / "current.json"
    current = json.loads(marker.read_text())
    assert {item["evidence_id"] for item in current["items"]} == {
        "evidence-1", "evidence-accepted",
    }
    assert {item["storage_state"] for item in current["items"]} == {
        "missing_after_restore",
    }
    con = sqlite3.connect(proj / ".orcha" / "orcha.db")
    event = con.execute(
        "SELECT event_type,detail FROM events WHERE entity_id='workflow-1'"
    ).fetchone()
    con.close()
    assert event[0] == "workflow_evidence_restore_audited"
    assert json.loads(event[1])["missing_after_restore"] == 2
    con = sqlite3.connect(proj / ".orcha" / "orcha.db")
    history = con.execute(
        "SELECT actor_alias,event,revision,detail FROM workflow_history"
    ).fetchone()
    con.close()
    assert history[:3] == ("Orcha restore", "workflow_evidence_restore_audited", 7)
    assert "acceptance remains blocked" in json.loads(history[3])["warning"]


def test_restore_refuses_a_damaged_file(proj, tmp_path):
    bad = tmp_path / "bad.db"
    bad.write_bytes(b"this is not a database" * 100)
    before = (proj / ".orcha" / "orcha.db").read_bytes()
    with pytest.raises(cli_backup.BackupError, match="damaged"):
        cli_backup.restore(proj, bad)
    assert (proj / ".orcha" / "orcha.db").read_bytes() == before
    assert not list((proj / ".orcha").glob("orcha.db.before-restore-*"))


def test_restore_refuses_a_backup_from_a_newer_orcha(proj, tmp_path):
    newer = _small_db(tmp_path / "newer.db", versions=("001_baseline.sql", "999_future.sql"))
    with pytest.raises(cli_backup.BackupError, match="newer Orcha"):
        cli_backup.restore(proj, newer)


def test_restore_into_an_empty_project(tmp_path):
    root = _native_project(tmp_path / "fresh", tmp_path / "fresh" / ".orcha" / "orcha.db")
    src = _small_db(tmp_path / "src.db", rows=2)
    res = cli_backup.restore(root, src)
    assert res["previous_kept_at"] is None and len(_rows(root / ".orcha" / "orcha.db")) == 2


def test_cli_json_mode(proj, monkeypatch, capsys):
    from orcha_cli.__main__ import build_parser

    args = build_parser().parse_args(["backup", "--json", "--project-dir", str(proj)])
    args.func(args)
    out = json.loads(capsys.readouterr().out)
    assert out["event"] == "result" and out["ok"] and pathlib.Path(out["path"]).exists()
    monkeypatch.setattr(cli_backup.cli_serve, "serve_running", lambda root: 99)
    args = build_parser().parse_args(["restore", out["path"], "--json", "--project-dir", str(proj)])
    with pytest.raises(SystemExit) as exc:
        args.func(args)
    assert exc.value.code == 1
    err = json.loads(capsys.readouterr().out)
    assert err["event"] == "error" and "orcha down" in err["error"]


# ---------------------------------------------------------------- acceptance: under traffic

@pytest.mark.skipif(BACKEND != "sqlite", reason="backs up the live SQLite test database")
async def test_backup_under_traffic_restores_to_identical_parity_snapshot(
        client, container, make_agent, make_task, make_request, work_headers, tmp_path,
        monkeypatch, db):
    from portal_backend import database

    live_root = tmp_path / "live"
    att = live_root / ".claude" / ".orcha-attachments"
    att.mkdir(parents=True)
    monkeypatch.setattr(main, "ATTACHMENTS_DIR", att)
    ids = await _run_scenario(client, container, make_agent, make_task, make_request,
                              work_headers)
    requests = _endpoints(ids)
    live = {}
    for label, path, params in requests:
        r = await client.get(path, params=params)
        assert r.status_code == 200, f"{label}: {r.status_code} {r.text[:300]}"
        live[label] = r.json()

    db.execute("CREATE TABLE IF NOT EXISTS t_traffic (id INTEGER PRIMARY KEY, v TEXT)")
    stop, written = threading.Event(), [0]

    def traffic():
        while not stop.is_set():
            with database.db_cursor() as (_conn, cur):
                cur.execute("INSERT INTO t_traffic (v) VALUES (%s)", ("x" * 500,))
            written[0] += 1

    def wait_for(n):
        deadline = time.monotonic() + 10
        while written[0] < n and time.monotonic() < deadline:
            time.sleep(0.005)
        assert written[0] >= n

    worker = threading.Thread(target=traffic, daemon=True)
    worker.start()
    try:
        wait_for(50)
        started_at = written[0]
        res = cli_backup.backup(_native_project(live_root, pathlib.Path(TEST_DB_PATH)))
        ended_at = written[0]
        wait_for(ended_at + 50)  # still writing after the backup finished
    finally:
        stop.set()
        worker.join(5)
    try:
        con = sqlite3.connect(res["path"])
        in_backup = con.execute("SELECT count(*) FROM t_traffic").fetchone()[0]
        con.close()
        assert started_at <= in_backup <= ended_at + 1  # one consistent snapshot mid-traffic

        fresh = tmp_path / "restored"
        target = fresh / ".orcha" / "orcha.db"
        cli_backup.restore(_native_project(fresh, target), pathlib.Path(res["path"]))
        served = _serve_from_sqlite(target, [[label, path, params] for label, path, params in requests])
    finally:
        db.execute("DROP TABLE IF EXISTS t_traffic")
    bad = [f"{label}: HTTP {v['status']}" for label, v in served.items() if v["status"] != 200]
    assert not bad, bad
    restored = {label: v["body"] for label, v in served.items()}
    shape = diff_recordings({k: record(v) for k, v in live.items()},
                            {k: record(v) for k, v in restored.items()})
    assert not shape, "parity snapshot differs after restore:\n" + "\n".join(shape)
    differing = [f"  {label} {p}: live {a!r} != restored {b!r}"
                 for label in live for p, a, b in _leaf_diff(_mask(live[label]), _mask(restored[label]))]
    assert not differing, "values differ after restore:\n" + "\n".join(differing[:40])
