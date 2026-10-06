"""GH #258 plan PR 7a (D10) — the SQLite baseline must describe the same schema as the Postgres
migrations. Transition-only: it lives while both dialects ship.

Postgres side: a scratch database built from every ``templates/migrations/*.sql`` (the same way
``run_migrations()`` builds a live one). SQLite side: an in-memory database built from every
``templates/migrations/sqlite/*.sql``, statement by statement inside one transaction (the
splitting rule the SQLite ``run_migrations()`` uses: ``;`` at end of line, ``--`` comments
ignored). Compared after normalising types: tables, columns (order, declared type, NOT NULL,
defaults), primary keys, UNIQUE constraints, indexes (unique / partial / keys / DESC), foreign
keys (columns, target, ON DELETE), CHECK constraint names, triggers, and the migration names
stamped into ``schema_migrations``.

It fails when a Postgres migration lands without its SQLite twin — add the twin (or, before
the cutover, regenerate the baseline with ``tools/db/gen_sqlite_baseline.py``) to fix it.
"""
import os
import pathlib
import re
import sqlite3

import psycopg
import pytest

from conftest import ADMIN_URL, TEST_DB

REPO = pathlib.Path(__file__).resolve().parent.parent
PG_DIR = REPO / "orcha-cli" / "orcha_cli" / "templates" / "migrations"
SQLITE_DIR = PG_DIR / "sqlite"
PARITY_DB = f"{TEST_DB}_schema_parity"

# Declared SQLite type expected for each Postgres data_type (plan S3 type map).
EXPECTED_TYPE = {
    "uuid": "UUID", "timestamp with time zone": "TIMESTAMPTZ", "jsonb": "JSONB",
    "boolean": "BOOLEAN", "text": "TEXT", "smallint": "INTEGER", "integer": "INTEGER",
    "bigint": "INTEGER", "double precision": "REAL", "numeric": "REAL",
}
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
def pg():
    with psycopg.connect(ADMIN_URL, autocommit=True) as admin:
        admin.execute(f'DROP DATABASE IF EXISTS "{PARITY_DB}" WITH (FORCE)')
        admin.execute(f'CREATE DATABASE "{PARITY_DB}"')
    conn = psycopg.connect(ADMIN_URL.rsplit("/", 1)[0] + f"/{PARITY_DB}")
    for f in sorted(PG_DIR.glob("*.sql")):
        conn.execute(f.read_text())
    conn.commit()
    yield conn
    conn.close()
    with psycopg.connect(ADMIN_URL, autocommit=True) as admin:
        admin.execute(f'DROP DATABASE IF EXISTS "{PARITY_DB}" WITH (FORCE)')


@pytest.fixture(scope="module")
def lite():
    conn = sqlite3.connect(":memory:", isolation_level=None)
    conn.execute("PRAGMA foreign_keys = ON")
    apply_sqlite(conn)
    yield conn
    conn.close()


# ---------- Postgres catalog ----------

def pg_rows(pg, sql):
    return pg.execute(sql).fetchall()


def pg_tables(pg):
    return {r[0] for r in pg_rows(pg, """
        SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'""")} - {"schema_migrations"}


def pg_columns(pg, table):
    return [(name, EXPECTED_TYPE.get(dtype, f"?{dtype}"), nullable == "NO", default)
            for name, dtype, nullable, default in pg_rows(pg, f"""
        SELECT column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = '{table}' ORDER BY ordinal_position""")]


def pg_constraints(pg, table, kind):
    return pg_rows(pg, f"""
        SELECT c.conname,
               ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(n, i)
                       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n
                      ORDER BY k.i)::text[],
               c.confrelid::regclass::text,
               ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(n, i)
                       JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n
                      ORDER BY k.i)::text[],
               c.confdeltype::text
          FROM pg_constraint c
         WHERE c.conrelid = 'public.{table}'::regclass AND c.contype = '{kind}'""")


def pg_indexes(pg):
    """Indexes created by CREATE INDEX (not the ones backing a PK/UNIQUE constraint):
    name -> (table, unique, partial, ((key column or '<expr>', desc), ...))."""
    out = {}
    for name, table, unique, partial, keys, options in pg_rows(pg, """
        SELECT ic.relname, tc.relname, i.indisunique, i.indpred IS NOT NULL,
               i.indkey::int2[]::int[], i.indoption::int2[]::int[]
          FROM pg_index i
          JOIN pg_class ic ON ic.oid = i.indexrelid
          JOIN pg_class tc ON tc.oid = i.indrelid
         WHERE tc.relnamespace = 'public'::regnamespace AND tc.relname <> 'schema_migrations'
           AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)"""):
        names = dict(pg_rows(pg, f"""SELECT attnum, attname FROM pg_attribute
                                       WHERE attrelid = 'public.{table}'::regclass"""))
        cols = tuple((names[k] if k else "<expr>", bool(o & 1)) for k, o in zip(keys, options))
        out[name] = (table, unique, partial, cols)
    return out


# ---------- SQLite catalog ----------

def lite_tables(lite):
    return {r[0] for r in lite.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")} \
        - {"schema_migrations"}


def lite_indexes(lite):
    out = {}
    for name, table in lite.execute(
            "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL"):
        if table == "schema_migrations":
            continue
        unique, partial = next((r[2], r[4]) for r in lite.execute(f"PRAGMA index_list({table})")
                               if r[1] == name)
        cols = tuple((r[2] if r[1] >= 0 else "<expr>", bool(r[3]))
                     for r in lite.execute(f"PRAGMA index_xinfo({name})") if r[5])
        out[name] = (table, bool(unique), bool(partial), cols)
    return out


def lite_table_sql(lite, table):
    return lite.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
                        (table,)).fetchone()[0]


# ---------- the comparisons ----------

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


def test_tables_match(pg, lite):
    assert lite_tables(lite) == pg_tables(pg)


def test_columns_match(pg, lite):
    diffs = []
    for table in sorted(pg_tables(pg)):
        want = [(n, t, notnull) for n, t, notnull, _ in pg_columns(pg, table)]
        got = [(r[1], r[2], bool(r[3]) or bool(r[5]))
               for r in lite.execute(f"PRAGMA table_info({table})")]
        if got != want:
            diffs.append((table, sorted(set(want) ^ set(got)) or "column order"))
    assert diffs == []


def test_defaults_match(pg, lite):
    """Same columns carry a default; literal defaults keep their value."""
    diffs = []
    for table in sorted(pg_tables(pg)):
        got = {r[1]: r[4] for r in lite.execute(f"PRAGMA table_info({table})")}
        got.update({n: "<missing>" for n, *_ in pg_columns(pg, table) if n not in got})
        for name, _, _, default in pg_columns(pg, table):
            if default is None or default.startswith("nextval("):
                expect_present = False if default is None else None
            else:
                expect_present = True
            if expect_present is not None and (got[name] is not None) != expect_present:
                diffs.append((table, name, default, got[name]))
            literal = re.fullmatch(r"'((?:[^']|'')*)'::(?:text|jsonb)|(-?\d+)", default or "")
            if literal and got[name] not in (f"'{literal.group(1)}'", literal.group(2)):
                diffs.append((table, name, default, got[name]))
            if default in ("true", "false") and got[name] != ("1" if default == "true" else "0"):
                diffs.append((table, name, default, got[name]))
    assert diffs == []


def test_primary_keys_match(pg, lite):
    for table in sorted(pg_tables(pg)):
        want = [tuple(r[1]) for r in pg_constraints(pg, table, "p")]
        rows = sorted((r[5], r[1]) for r in lite.execute(f"PRAGMA table_info({table})") if r[5])
        assert [tuple(n for _, n in rows)] == want, table


def test_unique_constraints_match(pg, lite):
    for table in sorted(pg_tables(pg)):
        want = {tuple(r[1]) for r in pg_constraints(pg, table, "u")}
        got = set()
        for r in lite.execute(f"PRAGMA index_list({table})"):
            if r[3] == "u":
                got.add(tuple(x[2] for x in lite.execute(f"PRAGMA index_info({r[1]})")))
        assert got == want, table


def test_indexes_match(pg, lite):
    assert lite_indexes(lite) == pg_indexes(pg)


def test_foreign_keys_match(pg, lite):
    actions = {"a": "NO ACTION", "c": "CASCADE", "n": "SET NULL", "r": "RESTRICT", "d": "SET DEFAULT"}
    for table in sorted(pg_tables(pg)):
        want = {(tuple(r[1]), r[2], tuple(r[3]), actions[r[4]])
                for r in pg_constraints(pg, table, "f")}
        by_id = {}
        for r in lite.execute(f"PRAGMA foreign_key_list({table})"):
            by_id.setdefault(r[0], []).append(r)
        got = {(tuple(x[3] for x in rows), rows[0][2], tuple(x[4] for x in rows), rows[0][6])
               for rows in (sorted(v, key=lambda x: x[1]) for v in by_id.values())}
        assert got == want, table


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


def test_check_constraints_match(pg, lite):
    for table in sorted(pg_tables(pg)):
        want = {r[0] for r in pg_rows(pg, f"""SELECT conname FROM pg_constraint
                   WHERE conrelid = 'public.{table}'::regclass AND contype = 'c'""")}
        got = set(re.findall(r"CONSTRAINT (\w+) CHECK", lite_table_sql(lite, table)))
        assert got == want, table


def test_triggers_ported(pg, lite):
    assert {r[0] for r in pg_rows(pg, """SELECT tgname FROM pg_trigger t
             JOIN pg_class c ON c.oid = t.tgrelid
            WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace""")} \
        == {"worker_run_task_sync", "agent_config_revisions_no_update"}
    assert {r[0] for r in lite.execute("SELECT name FROM sqlite_master WHERE type = 'trigger'")} \
        == {"worker_run_task_sync_ins", "worker_run_task_sync_upd",
            "agent_config_revisions_no_update"}


def test_schema_migrations_stamps_every_postgres_migration(lite):
    got = [r[0] for r in lite.execute("SELECT version FROM schema_migrations ORDER BY version")]
    want = sorted([f.name for f in PG_DIR.glob("*.sql")] + [f.name for f in SQLITE_DIR.glob("*.sql")])
    assert got == want


# ---------- the hand-ported behaviour actually behaves ----------

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
