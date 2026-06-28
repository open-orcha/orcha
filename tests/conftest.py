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

The app reads `DATABASE_URL` at import time, so we (re)create the test DB and set
the env var *before* importing `main`.
"""
import asyncio
import json as _json
import os
import pathlib
import sys

import psycopg
from psycopg.rows import dict_row
import pytest
import pytest_asyncio
import httpx

# --- locate the shipped app + schema (templates live under orcha-cli/) ---
REPO = pathlib.Path(__file__).resolve().parent.parent
PORTAL_DIR = REPO / "orcha-cli" / "orcha_cli" / "templates" / "portal"
MIGRATIONS_DIR = REPO / "orcha-cli" / "orcha_cli" / "templates" / "migrations"
SCHEMA_SQL = MIGRATIONS_DIR / "001_init.sql"

# --- a SEPARATE database so a test run never touches a live stack's data ---
ADMIN_URL = os.environ.get("ORCHA_TEST_ADMIN_URL", "postgresql://orcha:orcha@localhost:5432/postgres")
TEST_DB = os.environ.get("ORCHA_TEST_DB_NAME", "orcha_test")
TEST_URL = os.environ.get(
    "ORCHA_TEST_DATABASE_URL", f"postgresql://orcha:orcha@localhost:5432/{TEST_DB}"
)

# Truncate order doesn't matter with CASCADE, but list every app table explicitly
# so a new table added to the schema fails loudly here until it's wired in.
APP_TABLES = [
    "conversation_turns", "conversations",
    "agent_wake_state", "agent_reachability", "agent_memory_digests",
    "agent_notification_state",
    "agent_event_acks",
    "decisions", "agent_events", "events", "task_messages", "agent_tasks",
    "task_dependencies", "requests", "tasks", "container_provider_keys", "agents", "containers",
]


def _bootstrap_database() -> None:
    """Drop+recreate the test DB, load 001_init.sql, then apply incremental
    migrations (002+) — so the test schema matches a live DB after `orcha up`
    runs the R1 migration runner, not just the initdb baseline."""
    with psycopg.connect(ADMIN_URL, autocommit=True) as conn:
        conn.execute(f'DROP DATABASE IF EXISTS "{TEST_DB}" WITH (FORCE)')
        conn.execute(f'CREATE DATABASE "{TEST_DB}"')
    with psycopg.connect(TEST_URL) as conn:
        conn.execute(SCHEMA_SQL.read_text())
        # Apply every migration past the 001 baseline, in lexical order, exactly as
        # the portal's run_migrations() does on a live stack.
        for sql_file in sorted(MIGRATIONS_DIR.glob("0*.sql")):
            if sql_file.name == SCHEMA_SQL.name:
                continue
            conn.execute(sql_file.read_text())
        conn.commit()


# Run once at collection, BEFORE importing main (which binds DATABASE_URL).
_bootstrap_database()
os.environ["DATABASE_URL"] = TEST_URL
sys.path.insert(0, str(PORTAL_DIR))
# Also expose the CLI package so tests can `from orcha_cli import notifier` even when
# collected standalone (orcha-cli isn't installed in every env — e.g. a targeted run).
sys.path.insert(0, str(REPO / "orcha-cli"))
import main  # noqa: E402  (must follow the env + path setup above)


@pytest.fixture(autouse=True)
def _clean_db():
    """Truncate every app table before each test → each test starts empty."""
    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        conn.execute("TRUNCATE " + ", ".join(APP_TABLES) + " RESTART IDENTITY CASCADE")
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


class Db:
    """Thin DB accessor for tests — no ORM, just raw rows.

    `execute()` returns a list of dict rows (empty for non-SELECT). Used for
    row-level assertions the API doesn't expose (e.g. the event-bus fan-out).
    """

    def execute(self, sql, params=()):
        with psycopg.connect(TEST_URL, row_factory=dict_row, autocommit=True) as conn:
            cur = conn.execute(sql, params)
            try:
                return cur.fetchall()
            except psycopg.ProgrammingError:
                return []

    def event_rows(self, event_key):
        """All agent_events rows for a delivery key, in insertion order."""
        return self.execute(
            "SELECT * FROM agent_events WHERE event_key=%s ORDER BY id", (event_key,)
        )


@pytest.fixture
def db():
    return Db()


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
