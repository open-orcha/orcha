"""#110 — the wake-cursor REWIND endpoint (POST /api/agents/{aid}/wake-reopen).

wake-ack advances delivered_ts monotonically (GREATEST) at DISPATCH, before the daemon knows if
the drain succeeded. When a task worker exits failed/rate-limited, the events it 'consumed' were
never handled — so the daemon rewinds the cursor to the pre-wake value, and those events re-surface
on a later wake-scan instead of being silently dropped. This is the ONLY path that lowers the
cursor, and it never lowers below the caller-supplied value.
"""
import pytest_asyncio  # noqa: F401  (async fixtures live in conftest)


async def test_wake_reopen_rewinds_cursor(client, make_agent):
    aid = (await make_agent("A"))["agent_id"]
    # dispatch advanced the cursor to 100
    r = await client.post(f"/api/agents/{aid}/wake-ack",
                          json={"delivered_ts": 100.0, "kind": "ephemeral", "release_lease": True})
    assert r.json()["delivered_ts"] == 100.0
    # a failed/rate-limited reap rewinds it to the pre-wake value (40)
    r2 = await client.post(f"/api/agents/{aid}/wake-reopen", json={"before_ts": 40.0})
    assert r2.status_code == 200 and r2.json()["delivered_ts"] == 40.0


async def test_wake_reopen_only_lowers(client, make_agent):
    """LEAST semantics: reopening with a value ABOVE the current cursor must NOT advance it."""
    aid = (await make_agent("A"))["agent_id"]
    await client.post(f"/api/agents/{aid}/wake-ack",
                      json={"delivered_ts": 30.0, "kind": "ephemeral", "release_lease": True})
    r = await client.post(f"/api/agents/{aid}/wake-reopen", json={"before_ts": 90.0})
    assert r.json()["delivered_ts"] == 30.0


async def test_wake_reopen_seeds_row_when_absent(client, make_agent):
    """No wake-state row yet (never woken) → reopen seeds the cursor at before_ts, not a crash."""
    aid = (await make_agent("A"))["agent_id"]
    r = await client.post(f"/api/agents/{aid}/wake-reopen", json={"before_ts": 5.0})
    assert r.status_code == 200 and r.json()["delivered_ts"] == 5.0


async def test_wake_reopen_unknown_agent_404(client):
    r = await client.post("/api/agents/00000000-0000-0000-0000-000000000000/wake-reopen",
                          json={"before_ts": 1.0})
    assert r.status_code == 404


async def test_wake_reopen_bad_uuid_400(client):
    r = await client.post("/api/agents/not-a-uuid/wake-reopen", json={"before_ts": 1.0})
    assert r.status_code == 400
