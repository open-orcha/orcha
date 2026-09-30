"""portal_backend/sql.py dialect helpers (GH #258, plan S1): every helper on BOTH dialects.

Emitted text is asserted, then executed: SQLite on `:memory:` (with the D4 `now()` user
function and `%s` -> `?`, as the S3 adapter will do), Postgres on the suite's test DB.
"""
import datetime as dt
import importlib.util
import json
import sqlite3
import sys
import uuid

import psycopg
import pytest

from conftest import TEST_URL
from portal_backend import sql

T0 = dt.datetime(2026, 9, 29, 12, 0, 0, 123456, tzinfo=dt.timezone.utc)


def _sqlite_conn():
    conn = sqlite3.connect(":memory:")
    conn.create_function("now", 0, lambda: sql.ts(sql.utcnow()))
    return conn


class Engine:
    """One connection on one dialect; `%s` placeholders, tuples back, JSON text decoded."""

    def __init__(self, dialect):
        self.dialect = dialect
        self.pg = dialect == "postgres"
        self.conn = psycopg.connect(TEST_URL, autocommit=True) if self.pg else _sqlite_conn()

    def rows(self, query, params=()):
        if not self.pg:
            query = query.replace("%s", "?")
        cur = self.conn.execute(query, params)
        return cur.fetchall() if cur.description else []

    def one(self, query, params=()):
        return self.rows(query, params)[0][0]

    def bind_ts(self, value):
        return value if self.pg else sql.ts(value)  # the S3 adapter binds canonical text

    def table(self, name, pg_cols, lite_cols):
        self.rows(f"CREATE TEMP TABLE {name} ({pg_cols if self.pg else lite_cols})")


@pytest.fixture(params=["postgres", "sqlite"])
def eng(request, monkeypatch):
    monkeypatch.setattr(sql, "DIALECT", request.param)
    engine = Engine(request.param)
    yield engine
    engine.conn.close()


def _decoded(value):
    return json.loads(value) if isinstance(value, str) else value


# --- dialect switch + import hygiene ---

def test_unknown_dialect_is_rejected(monkeypatch):
    monkeypatch.setattr(sql, "DIALECT", "mysql")
    with pytest.raises(ValueError, match="ORCHA_DB_DIALECT"):
        sql.ilike()


def test_env_default_and_import_without_psycopg(monkeypatch):
    monkeypatch.delenv("ORCHA_DB_DIALECT", raising=False)
    monkeypatch.setitem(sys.modules, "psycopg", None)  # `import psycopg` would now raise
    spec = importlib.util.spec_from_file_location("sql_fresh", sql.__file__)
    fresh = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fresh)
    assert fresh.DIALECT == "postgres"
    assert fresh.is_unique_violation(ValueError("x")) is False


# --- time ---

def test_ts_is_canonical_and_round_trips():
    ist = dt.timezone(dt.timedelta(hours=5, minutes=30))
    text = sql.ts(T0.astimezone(ist))
    assert text == "2026-09-29T12:00:00.123456+00:00" and text.endswith("+00:00")
    assert dt.datetime.fromisoformat(text) == T0
    assert sql.ts(T0.replace(microsecond=0)).endswith("12:00:00.000000+00:00")
    with pytest.raises(ValueError):
        sql.ts(dt.datetime(2026, 1, 1))


def test_ago_and_from_now(monkeypatch):
    before = sql.utcnow()
    delta = (sql.utcnow() - sql.ago(3600)) - dt.timedelta(hours=1)
    assert abs(delta) < dt.timedelta(milliseconds=5) and before.tzinfo is not None
    monkeypatch.setattr(sql, "utcnow", lambda: T0)
    assert sql.ago(3600) == T0 - dt.timedelta(hours=1)
    assert sql.from_now(90) == T0 + dt.timedelta(seconds=90)


def test_age_secs_and_epoch(eng):
    expected = {"postgres": "EXTRACT(EPOCH FROM (now() - (w.x)))",
                "sqlite": "((julianday(now()) - julianday(w.x)) * 86400.0)"}
    assert sql.age_secs("w.x") == expected[eng.dialect]
    age = eng.one(f"SELECT {sql.age_secs('%s')}", (eng.bind_ts(sql.ago(90)),))
    assert abs(float(age) - 90) < 1
    eng.table("tt", "t timestamptz", "t TEXT")
    eng.rows("INSERT INTO tt VALUES (NULL)")
    assert eng.one(f"SELECT {sql.age_secs('t')} FROM tt") is None
    assert abs(float(eng.one(f"SELECT {sql.epoch('%s')}", (eng.bind_ts(T0),))) - T0.timestamp()) < 0.001


# --- set membership ---

def test_in_list_and_list_param(eng):
    assert sql.in_list("id") == ("id = ANY(%s)" if eng.pg else "id IN (SELECT value FROM json_each(%s))")
    ids = [uuid.uuid4() for _ in range(3)]
    eng.table("items", "id uuid, n integer", "id TEXT, n INTEGER")
    for n, item_id in enumerate(ids):
        eng.rows("INSERT INTO items VALUES (%s, %s)", (item_id if eng.pg else str(item_id), n))
    got = eng.rows(f"SELECT n FROM items WHERE {sql.in_list('id')} ORDER BY n",
                   (sql.list_param([ids[0], ids[2]]),))
    assert got == [(0,), (2,)]
    got = eng.rows(f"SELECT n FROM items WHERE {sql.in_list('n')} ORDER BY n", (sql.list_param([1, 2]),))
    assert got == [(1,), (2,)]
    assert eng.rows(f"SELECT n FROM items WHERE {sql.in_list('id')}", (sql.list_param([]),)) == []
    if not eng.pg:
        assert sql.list_param((ids[0], 7, "s")) == json.dumps([str(ids[0]), 7, "s"])


# --- JSON ---

def test_json_object(eng):
    expr = sql.json_object("'k'", "1", "'s'", "'x'")
    assert expr == ("json_build_object" if eng.pg else "json_object") + "('k', 1, 's', 'x')"
    assert _decoded(eng.one(f"SELECT {expr}")) == {"k": 1, "s": "x"}
    with pytest.raises(ValueError):
        sql.json_object("'k'")


def test_json_array_agg(eng):
    eng.table("vals", "v text", "v TEXT")
    for v in ("b", "c", "a"):
        eng.rows("INSERT INTO vals VALUES (%s)", (v,))
    got = eng.one(f"SELECT {sql.json_array_agg('v')} FROM (SELECT v FROM vals ORDER BY v) s")
    assert _decoded(got) == ["a", "b", "c"]
    if eng.pg:
        assert sql.json_array_agg("v", "v DESC") == "json_agg(v ORDER BY v DESC)"
        assert _decoded(eng.one(f"SELECT {sql.json_array_agg('v', 'v DESC')} FROM vals")) == ["c", "b", "a"]
    else:
        assert sql.json_array_agg("v") == "json_group_array(v)"
        with pytest.raises(ValueError, match="subquery"):
            sql.json_array_agg("v", "v DESC")


def test_json_param_and_cast(eng):
    assert sql.json_cast() == ("%s::jsonb" if eng.pg else "%s")
    assert sql.json_cast("%(d)s") == ("%(d)s::jsonb" if eng.pg else "%(d)s")
    eng.table("docs", "d jsonb", "d TEXT")
    doc = {"a": [1, True, None], "b": "x"}
    eng.rows("INSERT INTO docs VALUES (%s)", (sql.json_param(doc),))  # no cast needed on PG either
    assert _decoded(eng.one("SELECT d FROM docs")) == doc


@pytest.mark.parametrize("default, expected", [(True, [1, 3, 4]), (False, [1])])
def test_json_bool_is_true(eng, default, expected):
    eng.table("ev", "id int, detail jsonb", "id INTEGER, detail TEXT")
    details = [{"approved": True}, {"approved": False}, {"other": 1}, None]
    for i, detail in enumerate(details, start=1):
        eng.rows("INSERT INTO ev VALUES (%s, %s)", (i, None if detail is None else json.dumps(detail)))
    pred = sql.json_bool_is_true("detail", "approved", default=default)
    got = [r[0] for r in eng.rows(f"SELECT id FROM ev WHERE {pred} ORDER BY id")]
    assert got == expected
    if eng.pg and default:  # byte-identical to container_metrics_routes.py's inline predicate
        assert pred == "COALESCE(detail->>'approved', 'true') = 'true'"
    with pytest.raises(ValueError):
        sql.json_bool_is_true("detail", "x') OR ('1")


# --- strings / misc ---

def test_left_and_right(eng):
    assert sql.left("m.body", 140) == ("LEFT(m.body, 140)" if eng.pg else "substr(m.body, 1, 140)")
    assert sql.right("o", 5) == ("right(o, 5)" if eng.pg else "substr(o, -5)")
    got = eng.rows(f"SELECT {sql.left('%s', 3)}, {sql.right('%s', 2)}, {sql.right('%s', 0)}, "
                   f"{sql.right('%s', 9)}, {sql.left('%s', 2)}", ("abcdef",) * 4 + (None,))
    assert got == [("abc", "ef", "", "abcdef", None)]
    for bad in (-1, 1.5, "3", True):
        with pytest.raises(ValueError):
            sql.left("x", bad)


def test_ilike_is_case_insensitive_for_ascii(eng):
    assert sql.ilike() == ("ILIKE" if eng.pg else "LIKE")
    eng.table("roles", "r text", "r TEXT")
    for r in ("Backend Engineer", "designer"):
        eng.rows("INSERT INTO roles VALUES (%s)", (r,))
    assert eng.rows(f"SELECT r FROM roles WHERE r {sql.ilike()} %s", ("%ENGINEER%",)) == [("Backend Engineer",)]
    assert eng.rows(f"SELECT r FROM roles WHERE r {sql.ilike()} %s", ("DESIGN%",)) == [("designer",)]


def test_for_update(eng):
    assert sql.for_update() == (" FOR UPDATE" if eng.pg else "")
    eng.table("locks", "id int", "id INTEGER")
    eng.rows("INSERT INTO locks VALUES (1)")
    assert eng.rows("SELECT id FROM locks WHERE id = %s" + sql.for_update(), (1,)) == [(1,)]


def test_greatest_text_and_arity(eng):
    assert sql.greatest("a", "b") == ("GREATEST(a, b)" if eng.pg else "max(a, b)")
    assert eng.one(f"SELECT {sql.greatest('1', '3', '2')}") == 3
    with pytest.raises(ValueError):
        sql.greatest("a")


def test_greatest_null_caveat_needs_coalesce(monkeypatch):
    """Postgres GREATEST ignores NULL, SQLite max() returns NULL: only COALESCE'd operands agree.
    If the raw-NULL half ever stops differing, the caveat (and the COALESCE rule) can go."""
    results = {}
    for dialect in ("postgres", "sqlite"):
        monkeypatch.setattr(sql, "DIALECT", dialect)
        eng = Engine(dialect)
        coalesced = eng.one(f"SELECT {sql.greatest('COALESCE(%s, 0)', 'COALESCE(%s, 0)')}", (None, 1))
        raw = eng.one(f"SELECT {sql.greatest('%s', '1')}", (None,))
        results[dialect] = (int(coalesced), raw)
        eng.conn.close()
    assert results["postgres"][0] == results["sqlite"][0] == 1
    assert results["postgres"][1] == 1 and results["sqlite"][1] is None


def test_is_unique_violation(eng):
    eng.table("u", "k text UNIQUE, v text NOT NULL", "k TEXT UNIQUE, v TEXT NOT NULL")
    eng.rows("INSERT INTO u VALUES (%s, %s)", ("a", "x"))
    errors = (psycopg.Error, sqlite3.Error)
    with pytest.raises(errors) as dup:
        eng.rows("INSERT INTO u VALUES (%s, %s)", ("a", "y"))
    with pytest.raises(errors) as not_null:
        eng.rows("INSERT INTO u VALUES (%s, %s)", ("b", None))
    assert sql.is_unique_violation(dup.value) is True
    assert sql.is_unique_violation(not_null.value) is False
    assert sql.is_unique_violation(ValueError("UNIQUE constraint failed")) is False
