"""The SQLite migration files build a sound schema (GH #377).

Kept from the deleted Postgres-vs-SQLite tests/test_schema_parity.py: these checks need no
Postgres server. The file-level PG <-> SQLite twin check lives in test_migration_twins.py.
"""
import pathlib
import re
import sqlite3

import pytest

REPO = pathlib.Path(__file__).resolve().parent.parent
PG_DIR = REPO / "orcha-cli" / "orcha_cli" / "templates" / "migrations"
SQLITE_DIR = PG_DIR / "sqlite"
UUID_V4 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
ISO_UTC = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}\+00:00$")


def split_statements(text):
    """The SQLite migration splitting rule: a statement ends at a line ending in ';'."""
    stmts, buf = [], []
    for line in text.splitlines():
        if line.lstrip().startswith("--") or not line.strip():
            continue
        buf.append(line)
        if line.rstrip().endswith(";"):
            stmts.append("\n".join(buf))
            buf = []
    assert not buf, f"trailing text without ';': {buf[:3]}"
    return stmts


def apply_sqlite(conn):
    conn.execute("BEGIN IMMEDIATE")
    for f in sorted(SQLITE_DIR.glob("*.sql")):
        for stmt in split_statements(f.read_text()):
            assert sqlite3.complete_statement(stmt), f"{f.name}: incomplete statement {stmt[:80]!r}"
            conn.execute(stmt)
    conn.execute("COMMIT")


@pytest.fixture(scope="module")
def lite():
    conn = sqlite3.connect(":memory:", isolation_level=None)
    conn.execute("PRAGMA foreign_keys = ON")
    apply_sqlite(conn)
    yield conn
    conn.close()


def lite_tables(lite):
    return {r[0] for r in lite.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")} \
        - {"schema_migrations"}


def test_sqlite_version_supports_baseline():
    assert sqlite3.sqlite_version_info >= (3, 38), sqlite3.sqlite_version


def test_baseline_file_applies_cleanly(lite):
    assert lite.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert lite.execute("PRAGMA foreign_key_check").fetchall() == []
    # executescript (the sqlite3 CLI path) accepts the same text with no error.
    fresh = sqlite3.connect(":memory:")
    for f in sorted(SQLITE_DIR.glob("*.sql")):
        fresh.executescript(f.read_text())
    fresh.close()


def test_foreign_key_parents_are_unique(lite):
    """SQLite only reports a parent key that is not a PK / full UNIQUE index ("foreign key
    mismatch") when a row is written, not when the schema loads — so check every FK here."""
    def keys(table):
        pk = tuple(r[1] for r in sorted(lite.execute(f"PRAGMA table_info({table})"),
                                        key=lambda r: r[5]) if r[5])
        out = {pk} if pk else set()
        for r in lite.execute(f"PRAGMA index_list({table})"):
            cols = tuple(x[2] for x in lite.execute(f"PRAGMA index_info({r[1]})"))
            if r[2] and not r[4] and None not in cols:
                out.add(cols)
        return out
    bad = []
    for table in sorted(lite_tables(lite)):
        by_id = {}
        for r in lite.execute(f"PRAGMA foreign_key_list({table})"):
            by_id.setdefault(r[0], []).append(r)
        for rows in by_id.values():
            rows.sort(key=lambda x: x[1])
            parent, cols = rows[0][2], tuple(x[4] for x in rows)
            if cols not in keys(parent):
                bad.append((table, parent, cols))
    assert bad == []


def test_schema_migrations_stamps_every_postgres_migration(lite):
    got = [r[0] for r in lite.execute("SELECT version FROM schema_migrations ORDER BY version")]
    want = sorted([f.name for f in PG_DIR.glob("*.sql")] + [f.name for f in SQLITE_DIR.glob("*.sql")])
    assert got == want


@pytest.fixture
def scratch(lite):
    """One container + agent inside a transaction that is rolled back afterwards."""
    lite.execute("BEGIN")
    try:
        cid = lite.execute("INSERT INTO containers (name) VALUES ('parity') RETURNING id").fetchone()[0]
        aid = lite.execute("INSERT INTO agents (container_id, alias, role, kind) "
                           "VALUES (?, 'a', 'r', 'ai') RETURNING id", (cid,)).fetchone()[0]
        yield cid, aid
    finally:
        lite.execute("ROLLBACK")


def test_defaults_produce_postgres_shaped_values(lite, scratch):
    cid, aid = scratch
    uuid_, created, wakes = lite.execute(
        "SELECT id, created_at, wakes_enabled FROM containers WHERE id = ?", (cid,)).fetchone()
    assert UUID_V4.match(uuid_) and UUID_V4.match(aid)
    assert ISO_UTC.match(created), created
    assert wakes == 1


def test_worker_run_task_triggers(lite, scratch):
    cid, aid = scratch
    t1, t2 = (lite.execute("INSERT INTO tasks (container_id, title, definition_of_done) "
                           "VALUES (?, ?, 'd') RETURNING id", (cid, title)).fetchone()[0]
              for title in ("one", "two"))
    lite.execute("INSERT INTO worker_runs (run_id, agent_id, task_id) VALUES ('r1', ?, ?)",
                 (aid, t1))
    lite.execute("INSERT INTO worker_runs (run_id, agent_id) VALUES ('r2', ?)", (aid,))
    lite.execute("UPDATE worker_runs SET task_id = ? WHERE run_id = 'r1'", (t2,))
    lite.execute("UPDATE worker_runs SET task_id = ? WHERE run_id = 'r1'", (t2,))  # idempotent
    rows = sorted(lite.execute("SELECT run_id, task_id FROM worker_run_tasks"))
    assert rows == sorted([("r1", t1), ("r1", t2)])


def test_agent_config_revisions_are_immutable(lite, scratch):
    cid, aid = scratch
    lite.execute("INSERT INTO agent_config_revisions (agent_id, container_id, revision_no, kind,"
                 " source, snapshot) VALUES (?, ?, 1, 'initial', 's', '{}')", (aid, cid))
    with pytest.raises(sqlite3.IntegrityError, match="immutable"):
        lite.execute("UPDATE agent_config_revisions SET revision_no = 2")


@pytest.mark.parametrize("name,ok", [
    ("a", True), ("my-skill-2", True), ("0" * 63, True), ("0" * 64, False),
    ("-lead", False), ("Upper", False), ("under_score", False), ("", False),
])
def test_project_skill_name_check_matches_postgres_regex(lite, scratch, name, ok):
    """The one CHECK hand-translated from a Postgres regex (``~``) to GLOB."""
    assert bool(re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", name)) is ok
    cid, _ = scratch
    insert = "INSERT INTO project_skills (container_id, name, body) VALUES (?, ?, 'b')"
    if ok:
        lite.execute(insert, (cid, name))
    else:
        with pytest.raises(sqlite3.IntegrityError, match="CHECK"):
            lite.execute(insert, (cid, name))
