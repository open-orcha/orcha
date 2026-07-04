"""ISS-50 — heartbeat-on-poll.

A live idle agent that's only long-polling GET /api/agents/{aid}/wait (via /loop /orcha-listen)
never touched last_heartbeat_at, so the roster derived it as OFFLINE (last_active =
GREATEST(last_heartbeat_at, max worker_run start)). The fix refreshes last_heartbeat_at at /wait
entry — heartbeat ONLY (NOT bump_agent, which also increments turns_used; a poll isn't a turn).

Because last_heartbeat_at is ALSO wake-scan's idle signal, a present listener (fresh heartbeat)
is correctly NOT considered idle, so the daemon won't spawn a redundant headless worker while a
live listener is here — and resumes waking once the loop goes quiet >= min_idle.
"""
import asyncio

import pytest

pytestmark = pytest.mark.asyncio


async def _hb_turns(db, aid):
    row = db.execute("SELECT last_heartbeat_at, turns_used FROM agents WHERE id=%s", (aid,))[0]
    return row["last_heartbeat_at"], row["turns_used"]


async def test_wait_refreshes_heartbeat_but_not_turns(client, container, make_agent, db):
    a = await make_agent("A")
    aid = a["agent_id"]
    # Force a stale heartbeat + a known turn count so we can see exactly what /wait changes.
    db.execute("UPDATE agents SET last_heartbeat_at = now() - interval '1 hour', turns_used = 5 "
               "WHERE id=%s", (aid,))
    before_hb, before_turns = await _hb_turns(db, aid)

    # No pending events → /wait blocks then times out; the heartbeat is written at ENTRY regardless.
    r = await client.get(f"/api/agents/{aid}/wait", params={"since_ts": 0, "timeout": 1})
    assert r.status_code == 200 and r.json()["event"] == "timeout"

    after_hb, after_turns = await _hb_turns(db, aid)
    assert after_hb > before_hb          # heartbeat refreshed by the poll
    assert after_turns == before_turns == 5   # a poll is NOT a turn


async def test_polling_agent_reads_fresh_in_roster(client, container, make_agent, db):
    """The roster's last_active (GREATEST(heartbeat, worker-run start)) goes fresh after a poll,
    so a long-polling agent stops showing OFFLINE."""
    a = await make_agent("A")
    aid = a["agent_id"]
    db.execute("UPDATE agents SET last_heartbeat_at = now() - interval '1 hour' WHERE id=%s", (aid,))

    r0 = await client.get(f"/api/containers/{container['id']}")
    a0 = next(x for x in r0.json()["agents"] if x["id"] == aid)

    await client.get(f"/api/agents/{aid}/wait", params={"since_ts": 0, "timeout": 1})

    r1 = await client.get(f"/api/containers/{container['id']}")
    a1 = next(x for x in r1.json()["agents"] if x["id"] == aid)
    assert a1["last_active"] > a0["last_active"]   # poll refreshed liveness


async def test_present_listener_suppresses_then_releases_wake(client, container, make_agent, make_request, db):
    """Design property (Option A): a fresh heartbeat (what a just-completed poll leaves) keeps
    wake-scan from spawning a redundant headless worker; once the agent goes quiet past min_idle
    it becomes a wake candidate again."""
    a = await make_agent("A")
    b = await make_agent("B")
    bid = b["agent_id"]
    await make_request(a["agent_id"], "need input", target_alias="B")   # B has pending work

    # A real poll writes a fresh heartbeat → with min_idle=60 the agent is "active", not idle.
    await client.get(f"/api/agents/{bid}/wait", params={"since_ts": 0, "timeout": 1})
    r = await client.get(f"/api/containers/{container['id']}/wake-scan", params={"min_idle": 60})
    cand = next(c for c in r.json()["candidates"] if c["agent_id"] == bid)
    assert cand["should_wake"] is False
    assert "active" in cand["reason"]            # "agent active (idle Ns < 60s)"

    # Once the listener goes quiet past min_idle, the daemon resumes waking it. GH #91/#90: the
    # WORK-idle gate keys on work_last_heartbeat_at (which the poll now also bumps), so age BOTH.
    db.execute("UPDATE agents SET last_heartbeat_at = now() - interval '5 minutes' WHERE id=%s", (bid,))
    db.execute("UPDATE agent_wake_state SET work_last_heartbeat_at = now() - interval '5 minutes' "
               "WHERE agent_id=%s", (bid,))
    r = await client.get(f"/api/containers/{container['id']}/wake-scan", params={"min_idle": 60})
    cand = next(c for c in r.json()["candidates"] if c["agent_id"] == bid)
    assert cand["should_wake"] is True


async def test_event_near_end_of_poll_refreshes_heartbeat(client, container, make_agent, make_request, db):
    """Review P1: an event that arrives near the END of a long poll is delivered to a LIVE
    listener, but its agent_events row is still pending for wake-scan. The entry-only write is
    stale by then, so the heartbeat must ALSO be refreshed at return — otherwise wake-scan sees
    idle + pending and the notifier spawns a duplicate headless worker."""
    a = await make_agent("A")
    b = await make_agent("B")
    bid = b["agent_id"]
    # Start a long poll; the entry-write stamps the heartbeat ~now, then we let it AGE past
    # min_idle (1s) before the event arrives, so only a RETURN write can keep it fresh.
    waiter = asyncio.create_task(
        client.get(f"/api/agents/{bid}/wait", params={"since_ts": 0, "timeout": 5}))
    await asyncio.sleep(1.5)                     # entry heartbeat is now ~1.5s old (> min_idle=1)

    await make_request(a["agent_id"], "need input", target_alias="B")   # event lands mid-poll
    r = await waiter
    assert r.json()["event"] != "timeout"       # the live listener received it

    # The event row is still pending (no wake-ack). Only the RETURN heartbeat write keeps wake-scan
    # from treating B as idle and double-spawning.
    scan = await client.get(f"/api/containers/{container['id']}/wake-scan", params={"min_idle": 1})
    cand = next(c for c in scan.json()["candidates"] if c["agent_id"] == bid)
    assert cand["pending_events"] >= 1          # work is still pending for the listener
    assert cand["should_wake"] is False         # but the fresh return-heartbeat suppresses a dup
    assert "active" in cand["reason"]
