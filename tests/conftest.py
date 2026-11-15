"""Shared pytest fixtures for the Orcha API state-machine tests (Orcha#22).

Isolation strategy
------------------
We use a **dedicated test database** (never a real stack's `orcha` DB) and
**truncate every app table between tests**. That gives uniform "committed"
isolation, which is the only correct mode for the event-bus / long-poll tests:
`main._wait_for_event` polls `agent_events` from a *separate* connection in a
worker thread (`asyncio.to_thread`), so it can only see rows the request handler
has actually committed. Transactional-rollback isolation would hide those rows,
so we commit-and-truncate uniformly rather than special-casing bus tests.

The app binds its database at import time, so we (re)create the test DB and set
the env var *before* importing `main`: `ORCHA_DB_PATH`, a temp SQLite file per session.
The suite runs on SQLite only (GH #377 removed the PostgreSQL test mode).
"""
import asyncio
import datetime as _dt
import json as _json
import os
import pathlib
import sqlite3
import sys
import tempfile
import time
from contextlib import contextmanager

import pytest
import pytest_asyncio
import httpx

# --- locate the shipped app + schema (templates live under orcha-cli/) ---
REPO = pathlib.Path(__file__).resolve().parent.parent
PORTAL_DIR = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal"
MIGRATIONS_DIR = REPO / "orcha-cli" / "orcha_cli" / "templates" / "migrations"
SCHEMA_SQL = MIGRATIONS_DIR / "001_init.sql"

# GH #377: the suite runs on SQLite only (a temp file per session, no server). The
# PostgreSQL test mode is gone; BACKEND stays as a constant for tests that still read it.
BACKEND = "sqlite"
if os.environ.get("ORCHA_TEST_BACKEND", "sqlite") != "sqlite":
    raise RuntimeError("ORCHA_TEST_BACKEND is no longer supported: the suite runs on SQLite only (GH #377)")
# A worker can inherit the live installation's migration directory. Always test
# this checkout's schema, just as we always use an isolated database below.
os.environ["MIGRATIONS_DIR"] = str(MIGRATIONS_DIR / "sqlite")

# Run once at collection, BEFORE importing main (which binds the database at import).
TEST_DB_PATH = str(pathlib.Path(tempfile.mkdtemp(prefix="orcha-test-")) / "orcha.db")
os.environ.pop("DATABASE_URL", None)
os.environ["ORCHA_DB_PATH"] = TEST_DB_PATH
os.environ.setdefault("ORCHA_DB_ASSERT_READONLY", "1")  # plan S3 note 5: on in tests
sys.path.insert(0, str(PORTAL_DIR))
# Also expose the CLI package so tests can `from orcha_cli import notifier` even when
# collected standalone (orcha-cli isn't installed in every env — e.g. a targeted run).
sys.path.insert(0, str(REPO / "orcha-cli"))
from portal_backend import database, sql  # noqa: E402  (must follow the env + path setup above)

# Use the real runner so the schema and its migration ledger cannot drift apart.
database.run_migrations()
import main  # noqa: E402


def _sqlite_app_tables() -> list:
    with sqlite3.connect(TEST_DB_PATH) as conn:
        return [r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' "
            "AND name <> 'schema_migrations' ORDER BY name")]


SQLITE_TABLES = _sqlite_app_tables()

# Plan PR 7b acceptance / risk R2: every scope held past the 250 ms threshold during the run,
# listed in the terminal summary (the app's own log line is swallowed by output capture).
SLOW_TRANSACTIONS: list = []
_report_slow_transaction = database.report_slow_transaction


def _record_slow_transaction(held, readonly, where):
    test = os.environ.get("PYTEST_CURRENT_TEST", "?").split(" (")[0]
    SLOW_TRANSACTIONS.append((held, readonly, where, test))
    _report_slow_transaction(held, readonly, where)


database.report_slow_transaction = _record_slow_transaction


@pytest.fixture(autouse=True)
def _clean_db():
    """Empty every app table before each test → each test starts empty."""
    conn = sqlite3.connect(TEST_DB_PATH, isolation_level=None, timeout=10)
    try:
        conn.execute("PRAGMA foreign_keys=OFF")
        conn.execute("BEGIN IMMEDIATE")
        for table in SQLITE_TABLES:
            conn.execute(f'DELETE FROM "{table}"')
        conn.execute("DELETE FROM sqlite_sequence")  # RESTART IDENTITY
        conn.execute("COMMIT")
    finally:
        conn.close()
    yield


@pytest.fixture(autouse=True)
def _isolate_persona_cache():
    """Reset the daemon-side module-level persona/digest cache between tests.

    `notifier._PERSONA_CACHE` (added for #285) is a process-global dict. The truncate
    above resets the DB but NOT this in-memory cache, so a test that seeds it (e.g.
    test_iss285 writing an A1/Vox entry) would otherwise leak a stale persona/digest into a
    later test that monkeypatches `_get_json` or reuses an agent id — making `_build_persona`
    return the cached value instead of the freshly-fetched/patched one (the exact test-order
    leak that broke test_iss287's `_build_persona` seam test under CI). Clear before AND after
    so order never matters. Keyed off `sys.modules` so this is a pure no-op for any run that
    never imports notifier (no forced import, nothing to leak)."""
    notifier = sys.modules.get("orcha_cli.notifier")
    if notifier is not None:
        notifier._clear_persona_cache()
    yield
    if notifier is not None:
        notifier._clear_persona_cache()


@pytest.fixture(autouse=True)
def _isolate_startup_backoff():
    """GH #301: the conversation-startup backoff is a process-global dict keyed by
    conversation id; most resident tests reuse "C1"/"c1", so one test's recorded startup
    failure must not hold the next test in backoff. No-op unless the module is imported."""
    preflight = sys.modules.get("orcha_cli.notifier_startup_preflight")
    if preflight is not None:
        preflight._BACKOFF.clear()
    yield
    preflight = sys.modules.get("orcha_cli.notifier_startup_preflight")
    if preflight is not None:
        preflight._BACKOFF.clear()


def ts_ago(seconds):
    """A quoted timestamp literal `seconds` before sql.utcnow(), for raw test SQL on either
    backend: replaces `now() - interval '...'` (Postgres casts the text; SQLite stores it)."""
    from portal_backend import sql

    return "'" + sql.ts(sql.ago(seconds)) + "'"


def ts_from_now(seconds):
    """A quoted timestamp literal `seconds` after sql.utcnow(): replaces `now() + interval`."""
    from portal_backend import sql

    return "'" + sql.ts(sql.from_now(seconds)) + "'"


class Db:
    """Thin DB accessor for tests — no ORM, just raw rows.

    `execute()` returns a list of dict rows (empty for non-SELECT). Used for
    row-level assertions the API doesn't expose (e.g. the event-bus fan-out).
    """

    backend = BACKEND

    def execute(self, sql, params=()):
        with database.db_cursor() as (_conn, cur):  # same adapters + %s translation as the app
            cur.execute(sql, params)
            return cur.fetchall() if cur.description else []

    @staticmethod
    def ago(seconds):
        """A bound timestamp `seconds` in the past: replaces `now() - interval '...'` in raw SQL."""
        return _dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(seconds=seconds)

    @staticmethod
    def from_now(seconds):
        """A bound timestamp `seconds` in the future: replaces `now() + make_interval(...)`."""
        return _dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(seconds=seconds)

    def columns(self, table):
        """`table`'s columns as information_schema-shaped dict rows (column_name, data_type,
        is_nullable, column_default) on either backend: PRAGMA table_info on SQLite, whose
        declared types (BOOLEAN, UUID, ...) lower-case to the Postgres names; boolean
        defaults 0/1 read back as 'false'/'true' like Postgres prints them."""
        out = []
        for r in self.execute(f"PRAGMA table_info({table})"):
            dtype = (r["type"] or "").lower()
            default = r["dflt_value"]
            if dtype == "boolean" and default in ("0", "1"):
                default = "true" if default == "1" else "false"
            out.append({"column_name": r["name"], "data_type": dtype,
                        "is_nullable": "NO" if r["notnull"] or r["pk"] else "YES",
                        "column_default": default})
        return out

    def column(self, table, column):
        """One column's info row from `columns()`, or None when the column is absent."""
        return next((c for c in self.columns(table) if c["column_name"] == column), None)

    @staticmethod
    def check_violation():
        """The exception a CHECK-constraint breach raises on this backend."""
        import sqlite3

        return sqlite3.IntegrityError

    def event_rows(self, event_key):
        """All agent_events rows for a delivery key, in insertion order."""
        return self.execute(
            "SELECT * FROM agent_events WHERE event_key=%s ORDER BY id", (event_key,)
        )


@pytest.fixture
def db():
    return Db()


@contextmanager
def schema_migrations_hidden():
    """Temporarily hide the migration ledger, then restore it exactly.

    Migration and admin-route tests need to exercise a never-migrated database, but the
    session database already has the full schema.  Leaving the ledger dropped makes a
    later subprocess startup try to apply every migration to that existing schema.
    """

    def execute(statement, params=()):
        with database.db_cursor() as (_conn, cur):
            cur.execute(statement, params)
            return cur.fetchall() if cur.description else []

    exists_query = f"SELECT {sql.table_exists('schema_migrations')} AS present"
    existed = bool(execute(exists_query)[0]["present"])
    rows = execute(
        "SELECT version, applied_at FROM schema_migrations ORDER BY version"
    ) if existed else []
    execute("DROP TABLE IF EXISTS schema_migrations")
    try:
        yield
    finally:
        execute("DROP TABLE IF EXISTS schema_migrations")
        if existed:
            execute(
                "CREATE TABLE schema_migrations ("
                "version TEXT PRIMARY KEY NOT NULL, "
                "applied_at TIMESTAMPTZ NOT NULL DEFAULT "
                f"{sql.now_text_default()})"
            )
            for row in rows:
                execute(
                    "INSERT INTO schema_migrations(version, applied_at) VALUES (%s, %s)",
                    (row["version"], row["applied_at"]),
                )


@pytest.fixture
def isolated_schema_migrations():
    with schema_migrations_hidden():
        yield


@pytest_asyncio.fixture
async def client():
    transport = httpx.ASGITransport(app=main.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest_asyncio.fixture
async def container(client):
    """The default test arena: one fresh container (1:1:1 with the empty DB)."""
    r = await client.post("/api/containers", json={"name": "test-arena"})
    assert r.status_code == 201, r.text
    d = r.json()
    return {"id": d["container_id"], "name": "test-arena", "root_task_id": d["root_task_id"]}


@pytest_asyncio.fixture
async def make_agent(client, container):
    async def _make(alias, role="worker", *, kind="ai",
                    prompt="You are a test agent.", initial_task=None, container_id=None):
        cid = container_id or container["id"]
        body = {"alias": alias, "role": role, "kind": kind}
        if kind == "ai":
            body["prompt"] = prompt
        if initial_task is not None:
            body["initial_task"] = initial_task
        r = await client.post(f"/api/containers/{cid}/agents", json=body)
        assert r.status_code in (200, 201), r.text
        return r.json()
    return _make


@pytest_asyncio.fixture
async def make_task(client, container):
    async def _make(title, dod, *, assignee_alias=None, depends_on=(), created_by=None,
                    priority=100, description=None, container_id=None):
        cid = container_id or container["id"]
        body = {
            "title": title, "definition_of_done": dod, "priority": priority,
            "created_by_agent_id": created_by, "assignee_alias": assignee_alias,
            "depends_on": list(depends_on), "description": description,
        }
        r = await client.post(f"/api/containers/{cid}/tasks", json=body)
        assert r.status_code == 201, r.text
        d = r.json()
        d.setdefault("id", d.get("task_id"))  # accept both d["id"] and d["task_id"]
        return d
    return _make


@pytest_asyncio.fixture
async def make_request(client, container):
    async def _make(requester_id, payload, *, target_alias=None, type="info", task=None,
                    priority=100, expires_minutes=60, parent_request_id=None, container_id=None,
                    originating_task_id=None):
        cid = container_id or container["id"]
        body = {
            "requester_agent_id": requester_id, "payload": payload, "type": type,
            "priority": priority, "expires_minutes": expires_minutes,
            "target_alias": target_alias, "task": task,
            "parent_request_id": parent_request_id,
            "originating_task_id": originating_task_id,  # GH #56 (Point 3)
        }
        r = await client.post(f"/api/containers/{cid}/requests", json=body)
        assert r.status_code == 201, r.text
        d = r.json()
        d.setdefault("id", d.get("request_id"))  # accept both d["id"] and d["request_id"]
        return d
    return _make


@pytest_asyncio.fixture
def work_headers(client):
    """GH #91/#90: mint a WORK-lane embodiment token for an agent and return the header dict
    ({"X-Orcha-Run-Token": tok}) that the four work-lane-gated task endpoints (/next,
    accept-task->working, /tasks/{id}/done) now require. A worker process holds such a token in
    production; tests that claim/work/complete a task must present one or the server returns 403.
    Usage:  headers=await work_headers(agent_id)"""
    async def _mint(agent_id, *, kind="headless"):
        r = await client.post(f"/api/agents/{agent_id}/embodiment-tokens",
                              json={"lane": "work", "kind": kind})
        assert r.status_code == 201, r.text
        return {"X-Orcha-Run-Token": r.json()["run_token"]}
    return _mint


async def next_event(client, agent_id, *, since_ts=0.0, timeout=2):
    """Module-level helper (awaitable repeatedly) wrapping GET /wait.

    Returns the event dict, or {"event": "timeout", ...} when nothing newer than
    `since_ts` arrives within `timeout` seconds. Use under committed isolation.
    """
    r = await client.get(
        f"/api/agents/{agent_id}/wait", params={"since_ts": since_ts, "timeout": timeout}
    )
    assert r.status_code == 200, r.text
    return r.json()


async def read_sse(client, path, *, timeout=2.0, max_events=10, params=None):
    """Open an SSE stream, collect parsed `data:` event frames for up to `timeout`s.

    Returns {"status": int, "headers": {lower: val}, "events": [<parsed json>, ...]}.
    The stream is infinite (heartbeats forever), so we read under a wall-clock cap.
    """
    out = {"status": None, "headers": {}, "events": []}

    async def _pump():
        async with client.stream("GET", path, params=params or {}) as resp:
            out["status"] = resp.status_code
            out["headers"] = {k.lower(): v for k, v in resp.headers.items()}
            async for line in resp.aiter_lines():
                line = line.strip()
                if line.startswith("data:"):
                    try:
                        out["events"].append(_json.loads(line[len("data:"):].strip()))
                    except ValueError:
                        pass
                    if len(out["events"]) >= max_events:
                        return

    try:
        await asyncio.wait_for(_pump(), timeout=timeout)
    except asyncio.TimeoutError:
        pass
    return out


def pytest_addoption(parser):
    # GH #258 PR 1: tests/test_dialect_parity.py rewrites tests/fixtures/parity_postgres.json
    # instead of asserting against it (regenerate only on a deliberate response-shape change).
    parser.addoption(
        "--regen-parity", action="store_true", default=False,
        help="rewrite tests/fixtures/parity_postgres.json from this run instead of comparing",
    )


def pytest_configure(config):
    # The bus suite tags itself @pytest.mark.committed (Thread's contract). Our
    # isolation truncates-committed uniformly, so the marker is a documented no-op.
    config.addinivalue_line(
        "markers", "committed: test needs real-commit isolation (no-op here; we truncate uniformly)"
    )
    # R2: the end-to-end real-seam gate (real server + real PTY exec). Run it as a required
    # merge gate with `pytest -m smoke`; it's heavier than the mocked unit suite.
    config.addinivalue_line(
        "markers", "smoke: end-to-end real-seam gate (real HTTP server + real PTY exec)"
    )


def pytest_terminal_summary(terminalreporter):
    terminalreporter.write_line(
        f"[db] slow transactions (> {database.SLOW_TX_SECS * 1000:.0f} ms): {len(SLOW_TRANSACTIONS)}")
    for held, readonly, where, test in sorted(SLOW_TRANSACTIONS, reverse=True):
        terminalreporter.write_line(
            f"[db]   {held * 1000:.0f} ms at {where}{' (readonly)' if readonly else ''} in {test}")


async def fresh_task_id(client, cid, actor):
    """A task of its own, for a test that needs its sessions on different tasks."""
    r = await client.post(f"/api/containers/{cid}/tasks", json={"title": "A run", "definition_of_done": "It ran.", "created_by_agent_id": actor})
    assert r.status_code == 201, r.text
    return r.json()["task_id"]


async def run_task_id(client, cid, actor):
    """The task a QA session starts on, as the tool server gets it: no session exists without one."""
    r = await client.post(f"/api/containers/{cid}/qa/run-task", json={"actor_agent_id": actor, "kind": "check", "platform": "web"})
    assert r.status_code == 200, r.text
    return r.json()["task_id"]
