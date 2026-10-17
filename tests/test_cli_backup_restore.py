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
    res = cli_backup.backup(proj)
    path = pathlib.Path(res["path"])
    assert path.parent == proj / ".orcha" / "backups" and path.name.startswith("orcha-")
    assert path.name.endswith(".db") and not list(path.parent.glob("*.partial"))
    assert _rows(path) == _rows(proj / ".orcha" / "orcha.db") and res["bytes"] > 0
    assert res["pruned"] == []


def test_backup_rotation_keeps_the_newest(proj):
    t0 = _dt.datetime(2026, 10, 6, 12, 0, tzinfo=UTC)
    names = [pathlib.Path(cli_backup.backup(proj, keep=3, now=t0 + _dt.timedelta(minutes=i))["path"]).name
             for i in range(5)]
    kept = sorted(p.name for p in (proj / ".orcha" / "backups").glob("orcha-*.db"))
    assert kept == names[-3:]


def test_backup_out_never_overwrites_and_never_prunes(proj, tmp_path):
    out = tmp_path / "elsewhere" / "copy.db"
    assert cli_backup.backup(proj, out=out)["path"] == str(out)
    with pytest.raises(cli_backup.BackupError, match="already exists"):
        cli_backup.backup(proj, out=out)
    assert _rows(out) == _rows(proj / ".orcha" / "orcha.db")


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

    att = tmp_path / "orcha-attachments"
    att.mkdir()
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
        res = cli_backup.backup(_native_project(tmp_path / "live", pathlib.Path(TEST_DB_PATH)))
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
