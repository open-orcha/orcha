"""GH #258 S5 / PR 7d — the five correctness-critical time windows, at their exact boundaries.

SQLite moves "now" out of the database: Python computes `sql.utcnow()` / `sql.ago()` /
`sql.from_now()` and binds them, and the SQL `now()` UDF (database.py) returns
`sql.ts(sql.utcnow())` looked up at CALL time. So monkeypatching `sql.utcnow` freezes BOTH
sides of every comparison, and each window can be pinned one second either side of its edge.

Column DEFAULTs (created_at, ...) are NOT frozen: every timestamp a window compares is written
explicitly here. Postgres `now()` cannot be frozen, so the file is SQLite-only.

Each test is written so shifting its boundary offset by one second turns it red (the 7d
acceptance: green, AND each test proven red by a 1 s boundary shift).
"""
import datetime as _dt

import pytest

from conftest import BACKEND
from portal_backend import database, sql

pytestmark = pytest.mark.skipif(
    BACKEND == "postgres", reason="freezes the SQLite now() UDF via sql.utcnow; Postgres now() is the server clock"
)

FROZEN = _dt.datetime(2026, 10, 6, 12, 0, 0, tzinfo=_dt.timezone.utc)
FIVE_H = 5 * 3600


def _freeze(monkeypatch, at):
    monkeypatch.setattr(sql, "utcnow", lambda: at)


def _at(seconds):
    """FROZEN shifted by `seconds` (negative = in the past)."""
    return FROZEN + _dt.timedelta(seconds=seconds)


# ---------- 1. token / spend 5 h window ----------

def _insert_run(db, agent_id, ended_at, input_tokens):
    db.execute(
        """INSERT INTO worker_runs (agent_id, wake_kind, status, started_at, ended_at,
               input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
               total_cost_usd, output)
           VALUES (%s, 'ephemeral', 'exited', %s, %s, %s, 0, 0, 0, 0.01, '')""",
        (agent_id, ended_at - _dt.timedelta(seconds=30), ended_at, input_tokens),
    )


INSIDE_5H = FIVE_H - 1   # ended 4h59m59s ago -> counts
OUTSIDE_5H = FIVE_H + 1  # ended 5h00m01s ago -> does not


@pytest.mark.asyncio
async def test_token_usage_5h_window_boundary(client, container, make_agent, db, monkeypatch):
    _freeze(monkeypatch, FROZEN)
    a = await make_agent("Burner")
    _insert_run(db, a["agent_id"], _at(-INSIDE_5H), 7)
    _insert_run(db, a["agent_id"], _at(-OUTSIDE_5H), 1000)

    r = await client.get(f"/api/containers/{container['id']}/token-usage")
    assert r.status_code == 200, r.text
    w5 = r.json()["windows"]["5h"]
    assert w5["runs"] == 1, w5
    assert w5["input_tokens"] == 7, w5
    # both runs are inside 7d / all — the 5 h edge is the only thing that excluded one
    assert r.json()["windows"]["7d"]["runs"] == 2


@pytest.mark.asyncio
async def test_agent_spend_5h_window_boundary(client, container, make_agent, db, monkeypatch):
    _freeze(monkeypatch, FROZEN)
    a = await make_agent("Spender")
    _insert_run(db, a["agent_id"], _at(-INSIDE_5H), 7)
    _insert_run(db, a["agent_id"], _at(-OUTSIDE_5H), 1000)

    r = await client.get(
        f"/api/containers/{container['id']}/metrics/agents/{a['agent_id']}/spend",
        params={"window": "5h"},
    )
    assert r.status_code == 200, r.text
    totals = r.json()["totals"]
    assert totals["runs"] == 1, totals
    assert totals["input_tokens"] == 7, totals


# ---------- 2. wake backoff suppression ----------

SUPPRESS_EDGE = 1  # seconds either side of suppressed_until


@pytest.mark.asyncio
async def test_wake_backoff_suppressed_until_flips_at_boundary(container, make_agent, monkeypatch):
    from portal_backend import wake_backoff

    _freeze(monkeypatch, FROZEN)
    a = await make_agent("Striker")
    cid, aid, key = container["id"], a["agent_id"], "task:boundary"
    with database.db_cursor() as (conn, cur):
        row = None
        for _ in range(10):  # strike until the ladder starts suppressing
            row = wake_backoff.record_strike(cur, cid, aid, key)
            if row["suppressed_until"] is not None:
                break
        conn.commit()
    until = row["suppressed_until"]
    assert isinstance(until, _dt.datetime), type(until)
    backoff = wake_backoff.backoff_secs_for_strikes(row["strikes"])
    assert until == _at(backoff)  # from_now() round-trips exactly

    _freeze(monkeypatch, until - _dt.timedelta(seconds=SUPPRESS_EDGE))
    with database.db_cursor() as (_conn, cur):
        assert (aid, key) in wake_backoff.fetch_active_backoff_map(cur, cid)
    _freeze(monkeypatch, until + _dt.timedelta(seconds=SUPPRESS_EDGE))
    with database.db_cursor() as (_conn, cur):
        assert (aid, key) not in wake_backoff.fetch_active_backoff_map(cur, cid)


# ---------- 3. single-flight lease ----------

LEASE_TTL = 300
LEASE_HELD_AT = LEASE_TTL - 1     # still honoured
LEASE_EXPIRED_AT = LEASE_TTL + 1  # expired -> re-claimable


@pytest.mark.asyncio
async def test_wake_lease_honoured_until_ttl(client, make_agent, monkeypatch):
    _freeze(monkeypatch, FROZEN)
    a = await make_agent("Leaser")
    aid = a["agent_id"]
    r = await client.post(f"/api/agents/{aid}/wake-claim", json={"lease_ttl": LEASE_TTL})
    assert r.json()["claimed"] is True, r.text

    _freeze(monkeypatch, _at(LEASE_HELD_AT))
    r = await client.post(f"/api/agents/{aid}/wake-claim", json={"lease_ttl": LEASE_TTL})
    assert r.json()["claimed"] is False, r.text

    _freeze(monkeypatch, _at(LEASE_EXPIRED_AT))
    r = await client.post(f"/api/agents/{aid}/wake-claim", json={"lease_ttl": LEASE_TTL})
    assert r.json()["claimed"] is True, r.text


# ---------- 4. orphan-lease idle with a NULL claim floor ----------

ORPHAN_SECS = 600
IDLE_STALE = ORPHAN_SECS + 1   # reaped
IDLE_FRESH = ORPHAN_SECS - 1   # not reaped


async def _resident_with_silence(client, make_agent, db, alias, silent_secs):
    a = await make_agent(alias)
    aid = a["agent_id"]
    r = await client.post(f"/api/agents/{aid}/wake-claim",
                          json={"lease_ttl": 3600, "lease_kind": "resident"})
    assert r.json()["claimed"] is True, r.text
    # NULL claim floor: sql.greatest() is SQLite max(), which is NULL if ANY arg is NULL —
    # the COALESCE(floor, heartbeat) must keep the row reapable (the GREATEST-with-NULL trap).
    db.execute("UPDATE agent_wake_state SET conv_last_heartbeat_at=%s, conv_last_woken_at=NULL "
               "WHERE agent_id=%s", (_at(-silent_secs), aid))
    return aid


@pytest.mark.asyncio
async def test_orphan_lease_null_floor_boundary(client, container, make_agent, db, monkeypatch):
    _freeze(monkeypatch, FROZEN)
    stale = await _resident_with_silence(client, make_agent, db, "Stale", IDLE_STALE)
    fresh = await _resident_with_silence(client, make_agent, db, "Fresh", IDLE_FRESH)

    r = await client.post(f"/api/containers/{container['id']}/reap-orphan-leases",
                          params={"orphan_secs": ORPHAN_SECS})
    assert r.status_code == 200, r.text
    reaped = {row["agent_id"]: row for row in r.json()["reaped"]}
    assert stale in reaped, r.json()
    assert fresh not in reaped, r.json()
    # idle_seconds is the COALESCE floor (= heartbeat age), not NULL
    assert reaped[stale]["idle_seconds"] == pytest.approx(IDLE_STALE, abs=0.5)


# ---------- 5. wake-scan secs_since_woken ----------

WOKEN_AGO = 123


@pytest.mark.asyncio
async def test_wake_scan_secs_since_woken(container, make_agent, db, monkeypatch):
    from portal_backend.wake_scan_queries import list_wake_agents

    _freeze(monkeypatch, FROZEN)
    a = await make_agent("Woken")
    aid = a["agent_id"]
    db.execute("INSERT INTO agent_wake_state (agent_id, last_woken_at) VALUES (%s, %s)",
               (aid, _at(-WOKEN_AGO)))
    with database.db_cursor() as (_conn, cur):
        rows = {str(r["id"]): r for r in list_wake_agents(cur, container["id"], WOKEN_AGO + 1)}
    row = rows[aid]
    assert row["secs_since_woken"] == pytest.approx(123, abs=0.5)
    assert bool(row["in_cooldown"]) is True  # 123 < 124
    with database.db_cursor() as (_conn, cur):
        rows = {str(r["id"]): r for r in list_wake_agents(cur, container["id"], 123 - 1)}
    assert bool(rows[aid]["in_cooldown"]) is False  # 123 !< 122
