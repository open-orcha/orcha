"""GH #258 PR 7b (plan S3, 12.1 "DB layer"): the SQLite engine behind portal_backend.database.

Nested scopes join the outer transaction; a write after a mid-scope commit() re-begins; a
failing migration leaves schema_migrations untouched; a readonly scope rejects writes under
ORCHA_DB_ASSERT_READONLY=1; psycopg placeholders (%s, %(name)s, %%) translate; the now() UDF
returns canonical text; expression columns come back typed like psycopg returned them.
"""
import datetime as dt
import re
import sqlite3
import threading

import pytest

from conftest import BACKEND
from portal_backend import database, sql

pytestmark = pytest.mark.skipif(BACKEND != "sqlite", reason="SQLite engine only")


@pytest.fixture
def scratch(db):
    db.execute("CREATE TABLE IF NOT EXISTS t_scratch (id INTEGER PRIMARY KEY, v TEXT)")
    db.execute("DELETE FROM t_scratch")
    yield
    db.execute("DROP TABLE IF EXISTS t_scratch")


def _count(db):
    return db.execute("SELECT count(*) AS n FROM t_scratch")[0]["n"]


def test_backend_is_sqlite_and_dialect_follows():
    assert database.BACKEND == "sqlite"
    assert sql.DIALECT == "sqlite"


def test_nested_scope_joins_the_outer_transaction(db, scratch):
    with pytest.raises(RuntimeError):
        with database.db_cursor() as (_c, cur):
            cur.execute("INSERT INTO t_scratch(v) VALUES (%s)", ("outer",))
            with database.db_cursor() as (_c2, cur2):
                cur2.execute("INSERT INTO t_scratch(v) VALUES (%s)", ("inner",))
            raise RuntimeError("roll the whole thing back")
    assert _count(db) == 0  # the inner insert was part of the outer transaction


def test_failed_inner_scope_undoes_only_its_own_writes(db, scratch):
    with database.db_cursor() as (_c, cur):
        cur.execute("INSERT INTO t_scratch(v) VALUES (%s)", ("outer",))
        with pytest.raises(LookupError):
            with database.db_cursor() as (_c2, cur2):
                cur2.execute("INSERT INTO t_scratch(v) VALUES (%s)", ("inner",))
                raise LookupError
        with database.db_cursor() as (_c3, cur3):
            cur3.execute("INSERT INTO t_scratch(v) VALUES (%s)", ("sibling",))
    assert sorted(r["v"] for r in db.execute("SELECT v FROM t_scratch")) == ["outer", "sibling"]


def test_inner_scope_sees_outer_uncommitted_write(scratch):
    with database.db_cursor() as (_c, cur):
        cur.execute("INSERT INTO t_scratch(v) VALUES (%s)", ("x",))
        with database.db_cursor() as (_c2, cur2):
            assert cur2.execute("SELECT count(*) AS n FROM t_scratch").fetchone()["n"] == 1


def test_commit_then_write_re_begins(db, scratch):
    with pytest.raises(RuntimeError):
        with database.db_cursor() as (conn, cur):
            cur.execute("INSERT INTO t_scratch(v) VALUES (%s)", ("kept",))
            conn.commit()
            cur.execute("INSERT INTO t_scratch(v) VALUES (%s)", ("rolled back",))
            assert database._scope.get().raw.in_transaction  # a new transaction was opened
            raise RuntimeError("boom")
    assert [r["v"] for r in db.execute("SELECT v FROM t_scratch")] == ["kept"]


def test_clean_exit_commits_and_exception_rolls_back(db, scratch):
    with database.db_cursor() as (_c, cur):
        cur.execute("INSERT INTO t_scratch(v) VALUES (%s)", ("a",))
    with pytest.raises(ValueError):
        with database.db_cursor() as (_c, cur):
            cur.execute("INSERT INTO t_scratch(v) VALUES (%s)", ("b",))
            raise ValueError
    assert [r["v"] for r in db.execute("SELECT v FROM t_scratch")] == ["a"]


def test_after_commit_runs_once_after_the_write_lock_is_released(db, scratch):
    seen = []

    def hook():
        # Another thread's writer gets in at once: the outer scope has committed and released.
        errors = []

        def other():
            try:
                db.execute("INSERT INTO t_scratch(v) VALUES (%s)", ("other",))
            except Exception as exc:  # pragma: no cover - only on a regression
                errors.append(exc)

        t = threading.Thread(target=other)
        t.start()
        t.join(timeout=2)
        seen.append((t.is_alive(), errors, _count(db)))

    with database.db_cursor() as (_c, cur):
        cur.execute("INSERT INTO t_scratch(v) VALUES (%s)", ("a",))
        with database.db_cursor() as (_c2, _cur2):
            database.after_commit(hook)  # queued from a nested scope
        assert seen == []  # never inside the transaction
    assert seen == [(False, [], 2)]  # ran once, after commit, and the other writer was not blocked


def test_after_commit_is_dropped_on_rollback_and_runs_now_outside_a_scope(scratch):
    seen = []
    with pytest.raises(ValueError):
        with database.db_cursor():
            database.after_commit(lambda: seen.append("rolled back"))
            raise ValueError
    assert seen == []
    database.after_commit(lambda: seen.append("no scope"))
    assert seen == ["no scope"]


def test_concurrent_writers_are_serialised_not_lost(db, scratch):
    def work(i):
        for j in range(20):
            with database.db_cursor() as (_c, cur):
                n = cur.execute("SELECT count(*) AS n FROM t_scratch").fetchone()["n"]
                cur.execute("INSERT INTO t_scratch(v) VALUES (%s)", (f"{i}-{j}-{n}",))

    threads = [threading.Thread(target=work, args=(i,)) for i in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert _count(db) == 120


def test_half_read_cursor_does_not_pin_a_stale_snapshot(db, scratch):
    # A cursor left mid-SELECT (here kept alive the way a retained traceback keeps one) must
    # not hand its pooled connection a stale read snapshot: after another connection writes,
    # the next scope on that connection could never BEGIN IMMEDIATE ("database is locked").
    for v in ("a", "b", "c"):
        db.execute("INSERT INTO t_scratch(v) VALUES (%s)", (v,))
    with database.db_cursor() as (_c, cur):
        cur.execute("SELECT v FROM t_scratch ORDER BY id")
        assert cur.fetchone()["v"] == "a"
        kept = cur  # noqa: F841 — still referenced after the scope ends
    other = sqlite3.connect(database.DB, isolation_level=None, timeout=1)
    try:
        other.execute("INSERT INTO t_scratch(v) VALUES ('from-another-connection')")
    finally:
        other.close()
    with database.db_cursor() as (_c, cur):
        cur.execute("INSERT INTO t_scratch(v) VALUES (%s)", ("after",))
    assert _count(db) == 5


def test_readonly_scope_rejects_writes(monkeypatch, scratch):
    monkeypatch.setenv("ORCHA_DB_ASSERT_READONLY", "1")
    with pytest.raises(AssertionError, match="readonly"):
        with database.db_cursor(readonly=True) as (_c, cur):
            cur.execute("INSERT INTO t_scratch(v) VALUES (%s)", ("nope",))
    with pytest.raises(AssertionError, match="readonly"):
        with database.db_cursor(readonly=True):
            with database.db_cursor():
                pass
    with database.db_cursor(readonly=True) as (_c, cur):  # reads are fine
        assert cur.execute("SELECT 1 AS one").fetchone() == {"one": 1}


def test_placeholder_translation():
    assert database._translate("a=%s AND b=%s") == "a=? AND b=?"
    assert database._translate("a=%(x)s OR b=%(y_2)s") == "a=:x OR b=:y_2"
    assert database._translate("v LIKE 'x%%' AND w=%s") == "v LIKE 'x%' AND w=?"
    with database.db_cursor(readonly=True) as (_c, cur):
        row = cur.execute("SELECT %(a)s AS a, 'p%%' AS b", {"a": 7}).fetchone()
        assert row == {"a": 7, "b": "p%"}
        # no params: the text runs as written (psycopg does not interpolate either)
        assert cur.execute("SELECT 'p%%' AS b").fetchone() == {"b": "p%%"}


def test_now_udf_returns_canonical_text():
    raw = sqlite3.connect(":memory:")
    try:
        raw.create_function("now", 0, database._now_text, deterministic=False)
        text = raw.execute("SELECT now()").fetchone()[0]
    finally:
        raw.close()
    # the canonical stored shape (sql.ts): microseconds and an explicit +00:00
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}\+00:00", text), text
    with database.db_cursor(readonly=True) as (_c, cur):
        value = cur.execute("SELECT now() AS n").fetchone()["n"]
    assert isinstance(value, dt.datetime) and value.utcoffset() == dt.timedelta(0)
    assert abs((dt.datetime.now(dt.timezone.utc) - value).total_seconds()) < 5


def test_typed_columns_round_trip(make_agent, container):
    with database.db_cursor(readonly=True) as (_c, cur):
        row = cur.execute(
            "SELECT id, created_at, wakes_enabled, max(created_at) AS latest, "
            "(created_at IS NOT NULL) AS raw_predicate FROM containers WHERE id=%s",
            (container["id"],)).fetchone()
    assert isinstance(row["id"], str)
    assert isinstance(row["created_at"], dt.datetime) and row["created_at"].tzinfo is not None
    assert row["wakes_enabled"] is True
    assert row["latest"] == row["created_at"]  # an aggregate loses the declared type; text -> datetime
    assert row["raw_predicate"] == 1  # a bare predicate is an int: wrap it (sql.json_bool) for JSON


def test_datetime_and_json_params_bind_canonically(db, scratch):
    when = dt.datetime(2026, 10, 5, 12, 0, 0, 5, tzinfo=dt.timezone.utc)
    db.execute("INSERT INTO t_scratch(v) VALUES (%s)", (when,))
    assert db.execute("SELECT v FROM t_scratch")[0]["v"] == when  # canonical text reads back typed
    raw = sqlite3.connect(database.DB)
    try:
        assert raw.execute("SELECT v FROM t_scratch").fetchone()[0] == "2026-10-05T12:00:00.000005+00:00"
    finally:
        raw.close()


def test_split_statements_keeps_trigger_bodies_whole():
    script = """-- header; not a statement
CREATE TABLE a (x INTEGER); -- trailing comment
CREATE TRIGGER a_t AFTER INSERT ON a BEGIN
  INSERT INTO a(x) SELECT NEW.x WHERE 0;
END;
INSERT INTO a(x) VALUES (1);
"""
    stmts = database.split_statements(script)
    assert len(stmts) == 3
    assert stmts[1].strip().startswith("CREATE TRIGGER") and stmts[1].rstrip().endswith("END;")
    with pytest.raises(ValueError, match="unterminated"):
        database.split_statements("CREATE TABLE b (x INTEGER)\n")


@pytest.fixture
def fresh_db(tmp_path, monkeypatch):
    """Point the engine at an empty file (and a fresh idle pool) for runner tests."""
    monkeypatch.setattr(database, "DB", str(tmp_path / "fresh.db"))
    monkeypatch.setattr(database, "_idle", [])
    yield tmp_path
    for raw in database._idle:
        raw.close()


def test_failed_migration_leaves_schema_migrations_untouched(fresh_db):
    mdir = fresh_db / "migrations"
    mdir.mkdir()
    (mdir / "001_ok.sql").write_text("CREATE TABLE ok_t (x INTEGER);\n")
    assert database.run_migrations(mdir) == ["001_ok.sql"]
    (mdir / "002_bad.sql").write_text(
        "CREATE TABLE half_t (x INTEGER);\nINSERT INTO no_such_table VALUES (1);\n")
    with pytest.raises(RuntimeError, match="002_bad.sql"):
        database.run_migrations(mdir)
    raw = sqlite3.connect(database.DB)
    try:
        versions = [r[0] for r in raw.execute("SELECT version FROM schema_migrations ORDER BY 1")]
        tables = {r[0] for r in raw.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    finally:
        raw.close()
    assert versions == ["001_ok.sql"]
    assert "ok_t" in tables and "half_t" not in tables  # the failed file left nothing behind


def test_baseline_stamps_every_folded_postgres_migration(fresh_db):
    """The baseline's own INSERT OR IGNORE names every Postgres file it folds in (so a fresh
    SQLite DB and one converted from Postgres report the same history and migration tip).
    The runner creates schema_migrations first; without the applied_at DEFAULT the NOT NULL
    made SQLite skip those rows silently, leaving only 001_baseline (tip 1)."""
    import pathlib

    from orcha_cli import cli_project_setup

    database.run_migrations()  # the shipped templates/migrations/sqlite
    raw = sqlite3.connect(database.DB)
    try:
        rows = raw.execute("SELECT version, applied_at FROM schema_migrations").fetchall()
    finally:
        raw.close()
    versions = {v for v, _ in rows}
    pg_dir = pathlib.Path(database.__file__).resolve().parents[2] / "migrations"
    assert versions == {p.name for p in pg_dir.glob("*.sql")} | {"001_baseline.sql"}
    assert all(re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}\+00:00", a) for _, a in rows)
    assert cli_project_setup.migration_tip_of(versions) == cli_project_setup.migration_tip(pg_dir)
