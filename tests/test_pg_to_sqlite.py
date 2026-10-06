"""GH #258 plan Part 6 M1 (PR 8) — the Postgres -> SQLite converter (``orcha_cli.db_convert``).

Two layers:

* pure tests of the value mapper, the foreign-key ordering and the never-overwrite rule
  (run on both test legs; no database server needed);
* the end-to-end check (Postgres leg only, ``ORCHA_TEST_BACKEND=postgres``): the plan S8
  scenario from ``tests/test_dialect_parity.py`` is driven through the API into the Postgres
  test database, the database is converted into a temp SQLite file, and the same read
  endpoints are served by a child portal process bound to that file. Every response must
  match the Postgres one exactly, after only the fields that are computed from the clock at
  request time are masked.
"""
import datetime as _dt
import decimal
import json
import os
import pathlib
import sqlite3
import subprocess
import sys
import uuid

import pytest

import main
from conftest import BACKEND, PORTAL_DIR, REPO, TEST_URL
from orcha_cli import db_convert
from test_dialect_parity import _endpoints, _run_scenario, diff_recordings, record

UTC = _dt.timezone.utc


# ---------------------------------------------------------------- value mapper (plan M1 step 3)

def test_map_value_uuid_is_lowercase_text():
    u = uuid.UUID("6F1C1A52-0C1B-4C4E-9D1E-2B1F0F7E3A11")
    assert db_convert.map_value(u, "uuid") == "6f1c1a52-0c1b-4c4e-9d1e-2b1f0f7e3a11"


def test_map_value_timestamps_keep_microseconds_in_utc():
    aware = _dt.datetime(2026, 10, 6, 9, 30, 1, 123456, tzinfo=_dt.timezone(_dt.timedelta(hours=-4)))
    assert db_convert.map_value(aware, "timestamp with time zone") == \
        "2026-10-06T13:30:01.123456+00:00"
    naive = _dt.datetime(2026, 10, 6, 13, 30, 1)  # psycopg naive = UTC (session time zone)
    assert db_convert.map_value(naive, "timestamp with time zone") == \
        "2026-10-06T13:30:01.000000+00:00"


def test_map_value_decimal_bool_bytes_and_null():
    assert db_convert.map_value(decimal.Decimal("0.000123"), "numeric") == 0.000123
    assert db_convert.map_value(True, "boolean") == 1
    assert db_convert.map_value(False, "boolean") == 0
    assert db_convert.map_value(memoryview(b"\x00\x01"), "bytea") == b"\x00\x01"
    assert db_convert.map_value(None, "jsonb") is None
    assert db_convert.map_value(7, "integer") == 7
    assert db_convert.map_value(1.5, "double precision") == 1.5


def test_map_value_json_text_passes_through_and_json_null_is_not_sql_null():
    # jsonb is SELECTed as ::text, so the converter sees Postgres' own JSON text
    nested = '{"a": [1, {"b": null}], "c": "é"}'
    assert db_convert.map_value(nested, "jsonb") == nested
    assert db_convert.map_value("null", "jsonb") == "null"  # JSON null stays a value
    assert db_convert.map_value(None, "jsonb") is None  # SQL NULL stays NULL
    # a decoded value (a driver that does not honour ::text) is re-encoded, never str()-ed
    assert json.loads(db_convert.map_value({"a": [1, None]}, "jsonb")) == {"a": [1, None]}
    assert db_convert.map_value("abc", "text") == "abc"


def test_mapped_values_read_back_through_the_portal_converters(tmp_path):
    """What the converter stores must decode, through the portal's own sqlite3 converters,
    to what psycopg handed the converter (D3/D8/D9; JSONB has NUMERIC affinity)."""
    con = sqlite3.connect(str(tmp_path / "t.db"), detect_types=sqlite3.PARSE_DECLTYPES)
    con.execute("CREATE TABLE t (j JSONB, b BOOLEAN, ts TIMESTAMPTZ, u UUID, n REAL)")
    ts = _dt.datetime(2026, 1, 2, 3, 4, 5, 6, tzinfo=UTC)
    u = uuid.uuid4()
    for j in ('{"k": [1, 2]}', "5", '"text"', "null", "[]"):
        con.execute("INSERT INTO t VALUES (?, ?, ?, ?, ?)", (
            db_convert.map_value(j, "jsonb"), db_convert.map_value(True, "boolean"),
            db_convert.map_value(ts, "timestamp with time zone"),
            db_convert.map_value(u, "uuid"), db_convert.map_value(decimal.Decimal("1.25"), "numeric")))
    from portal_backend import database  # noqa: F401  (registers the converters)

    rows = con.execute("SELECT j, b, ts, u, n FROM t").fetchall()
    assert [r[0] for r in rows] == [{"k": [1, 2]}, 5, "text", None, []]
    assert all(r[1] is True and r[2] == ts and r[3] == str(u) and r[4] == 1.25 for r in rows)


def test_comparable_normalises_both_sides():
    t = "timestamp with time zone"
    pg = _dt.datetime(2026, 1, 1, 12, 0, tzinfo=_dt.timezone(_dt.timedelta(hours=2)))
    assert db_convert.comparable(pg, t) == db_convert.comparable("2026-01-01T10:00:00.000000+00:00", t)
    assert db_convert.comparable('{"a": 1, "b": 2}', "jsonb") == \
        db_convert.comparable(b'{"b":2,"a":1}', "jsonb")
    assert db_convert.comparable(True, "boolean") == db_convert.comparable(1, "boolean")
    assert db_convert.comparable("null", "jsonb") is None
    assert db_convert.comparable(None, "jsonb") is None


# ---------------------------------------------------------------- ordering + file safety

def test_fk_order_puts_parents_first_and_ignores_self_references():
    tables = ["tasks", "agents", "containers", "task_messages", "requests"]
    edges = [("tasks", "containers"), ("tasks", "tasks"), ("agents", "containers"),
             ("task_messages", "tasks"), ("task_messages", "agents"), ("requests", "agents"),
             ("requests", "requests"), ("tasks", "unrelated_table")]
    order = db_convert.fk_order(tables, edges)
    for child, parent in edges:
        if child != parent and parent in tables:
            assert order.index(parent) < order.index(child), (parent, child, order)
    assert order == db_convert.fk_order(list(reversed(tables)), edges)  # stable


def test_fk_order_reports_a_cycle():
    with pytest.raises(db_convert.ConvertError, match="cycle"):
        db_convert.fk_order(["a", "b"], [("a", "b"), ("b", "a")])


def test_refuses_to_overwrite_an_existing_file(tmp_path):
    out = tmp_path / "orcha.db"
    out.write_bytes(b"keep me")

    def never(*a, **k):
        raise AssertionError("must not get this far")

    with pytest.raises(db_convert.ConvertError, match="already exists"):
        db_convert.convert("postgresql://unused", out, connect=never, apply_schema=never)
    assert out.read_bytes() == b"keep me"


def test_force_moves_the_old_file_aside_and_a_failure_leaves_no_output(tmp_path):
    out = tmp_path / "orcha.db"
    out.write_bytes(b"old")
    (tmp_path / "orcha.db-wal").write_bytes(b"old-wal")

    def broken_connect(url):
        raise OSError("connection refused")

    with pytest.raises(db_convert.ConvertError, match="connection refused"):
        db_convert.convert("postgresql://unused", out, force=True, connect=broken_connect)
    assert not out.exists() and not (tmp_path / "orcha.db-wal").exists()
    moved = sorted(p.name for p in tmp_path.iterdir())
    assert len(moved) == 2 and moved[0].startswith("orcha.db.bak-"), moved
    assert (tmp_path / moved[0]).read_bytes() == b"old"
    assert (tmp_path / moved[1]).read_bytes() == b"old-wal" and moved[1].endswith("-wal")


def test_schema_step_uses_the_portal_migrations(tmp_path):
    out = tmp_path / "schema-only.db"
    db_convert.apply_sqlite_schema(out)
    con = sqlite3.connect(str(out))
    tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"tasks", "agents", "containers", "schema_migrations"} <= tables
    assert con.execute(
        "SELECT count(*) FROM schema_migrations WHERE version='001_baseline.sql'").fetchone()[0] == 1


def test_report_renders_counts_and_json():
    rep = db_convert.Report(out="/x/orcha.db", sampled=3,
                            non_ascii_lower={"containers.name": 1})
    rep.tables = [db_convert.TableReport("containers", 2, 0.01),
                  db_convert.TableReport("tasks", 5, 0.02)]
    text = rep.render()
    assert "containers" in text and "2 tables, 7 rows, 3 sampled" in text
    assert "non-ASCII value(s) in containers.name" in text
    d = rep.as_dict()
    assert d["total_rows"] == 7 and d["table_count"] == 2 and json.dumps(d)


# ---------------------------------------------------------------- end to end (Postgres leg)

_CHILD = r"""
import asyncio, json, sys
import httpx
import main

async def run(requests):
    out = {}
    transport = httpx.ASGITransport(app=main.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        for label, path, params in requests:
            r = await c.get(path, params=params)
            out[label] = {"status": r.status_code, "body": r.json()}
    return out

print(json.dumps(asyncio.run(run(json.load(sys.stdin)))))
"""

# Fields computed from the clock at request time (they tick between the two reads).
_VOLATILE = frozenset({"heartbeat_age_secs", "wake_scan_age_secs", "idle_seconds"})


def _mask(v):
    if isinstance(v, dict):
        return {k: ("<volatile>" if k in _VOLATILE else _mask(x)) for k, x in v.items()}
    if isinstance(v, list):
        return [_mask(x) for x in v]
    return v


@pytest.fixture
def stamped_pg():
    """The test database is built by executing the migration files directly (conftest), so
    it has no schema_migrations table; a live stack's portal runner always writes one.
    Stamp it the way that runner does."""
    import psycopg

    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations "
            "(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())")
        for f in sorted((REPO / "orcha-cli" / "orcha_cli" / "templates" / "migrations").glob("*.sql")):
            conn.execute("INSERT INTO schema_migrations (version) VALUES (%s) "
                         "ON CONFLICT (version) DO NOTHING", (f.name,))
    yield


def _leaf_diff(a, b, path="$"):
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            yield from _leaf_diff(a.get(k, "<absent>"), b.get(k, "<absent>"), f"{path}.{k}")
    elif isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        for i, (x, y) in enumerate(zip(a, b)):
            yield from _leaf_diff(x, y, f"{path}[{i}]")
    elif a != b and (_instant(a) is None or _instant(a) != _instant(b)):
        yield path, a, b


def _instant(v):
    """A datetime string as a UTC instant (Postgres' to_json trims trailing zeros from the
    fraction inside nested JSON; the stored SQLite text keeps all six digits)."""
    if isinstance(v, str) and len(v) >= 20 and v[4:5] == "-" and v[10:11] == "T":
        try:
            return _dt.datetime.fromisoformat(v.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def _serve_from_sqlite(db_file: pathlib.Path, requests) -> dict:
    env = {k: v for k, v in os.environ.items() if k not in ("DATABASE_URL", "ORCHA_DB_ASSERT_READONLY")}
    env["ORCHA_DB_PATH"] = str(db_file)
    env["PYTHONPATH"] = os.pathsep.join([str(PORTAL_DIR), str(REPO / "orcha-cli")])
    proc = subprocess.run([sys.executable, "-c", _CHILD], input=json.dumps(requests),
                          env=env, capture_output=True, text=True, timeout=120)
    assert proc.returncode == 0, proc.stderr[-3000:]
    return json.loads(proc.stdout.strip().splitlines()[-1])


@pytest.mark.skipif(BACKEND != "postgres", reason="converts the Postgres test DB (Postgres leg)")
async def test_converted_database_serves_the_same_responses(
        client, container, make_agent, make_task, make_request, work_headers, tmp_path,
        monkeypatch, stamped_pg):
    att = tmp_path / "orcha-attachments"
    att.mkdir()
    monkeypatch.setattr(main, "ATTACHMENTS_DIR", att)
    ids = await _run_scenario(client, container, make_agent, make_task, make_request,
                              work_headers)
    requests = _endpoints(ids)

    pg_bodies = {}
    for label, path, params in requests:
        r = await client.get(path, params=params)
        assert r.status_code == 200, f"{label}: {r.status_code} {r.text[:300]}"
        pg_bodies[label] = r.json()

    out = tmp_path / "converted" / "orcha.db"
    events = []
    report = db_convert.convert(TEST_URL, out, verify_sample=1000, progress=events.append, seed=1)
    assert out.exists() and not out.with_name("orcha.db-wal").exists()
    assert [e["stage"] for e in events][:1] == ["schema"] and events[-1]["stage"] == "done"
    counts = {t.table: t.rows for t in report.tables}
    assert counts["tasks"] >= 3 and counts["requests"] >= 2 and counts["agents"] >= 3
    assert report.sampled == report.total_rows  # every row compared field by field
    con = sqlite3.connect(str(out))
    assert con.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert con.execute("PRAGMA foreign_key_check").fetchall() == []
    stamped = {r[0] for r in con.execute("SELECT version FROM schema_migrations")}
    assert "001_baseline.sql" in stamped and "001_init.sql" in stamped
    triggers = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='trigger'")}
    assert "worker_run_task_sync_ins" in triggers  # dropped for the load, put back after
    con.close()

    served = _serve_from_sqlite(out, [[label, path, params] for label, path, params in requests])
    bad = [f"{label}: HTTP {v['status']}" for label, v in served.items() if v["status"] != 200]
    assert not bad, bad
    lite_bodies = {label: v["body"] for label, v in served.items()}

    shape = diff_recordings({k: record(v) for k, v in pg_bodies.items()},
                            {k: record(v) for k, v in lite_bodies.items()})
    assert not shape, "response shapes differ after conversion:\n" + "\n".join(shape)
    differing = []
    for label in pg_bodies:
        differing += [f"  {label} {path}: pg {a!r} != sqlite {b!r}"
                      for path, a, b in _leaf_diff(_mask(pg_bodies[label]), _mask(lite_bodies[label]))]
    assert not differing, "values differ after conversion:\n" + "\n".join(differing[:40])


@pytest.mark.skipif(BACKEND != "postgres", reason="converts the Postgres test DB (Postgres leg)")
def test_cli_json_mode_reports_counts_and_refuses_overwrite(tmp_path, container, stamped_pg):
    out = tmp_path / "cli.db"
    argv = [sys.executable, str(REPO / "tools" / "db" / "pg_to_sqlite.py"), "--pg", TEST_URL,
            "--out", str(out), "--json"]
    env = {**os.environ, "PYTHONPATH": str(REPO / "orcha-cli")}
    proc = subprocess.run(argv, capture_output=True, text=True, timeout=120, env=env)
    assert proc.returncode == 0, proc.stderr
    lines = [json.loads(line) for line in proc.stdout.splitlines()]
    assert lines[0] == {"event": "progress", "stage": "schema"}
    rep = lines[-1]
    assert rep["event"] == "report" and rep["out"] == str(out)
    assert {t["table"]: t["rows"] for t in rep["tables"]}["containers"] == 1
    assert rep["table_count"] == len(rep["tables"]) > 50
    again = subprocess.run(argv, capture_output=True, text=True, timeout=120, env=env)
    assert again.returncode == 1
    assert json.loads(again.stdout.splitlines()[-1])["event"] == "error"
    assert out.exists()  # the refused second run left the first output alone
