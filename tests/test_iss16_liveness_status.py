"""ISS-16/#89 — derive agent status from LIVENESS, not sticky ownership.

The stored `agents.status` flips to 'working' the moment a task is assigned
(`recompute_agent_status`, ownership-only) and recomputes ONLY at mutation
points — so it sticks at 'working' long after the worker process exits. The
portal renders that stale 'working' as a live indicator (the Dock/Page
"sticky Working" bug).

The fix (Helm REUSE direction, req afa7ffe2): recompute the surfaced `status`
LIVE at the API-projection layer (GET /api/containers/{cid}), REUSING the
existing stored-enum vocabulary so the frontend needs ZERO change. No migration,
no separate field — the snapshot's `status` is derived at query time and the
stored `agents.status` column is left UNTOUCHED as internal truth.

Layered priority, mirroring recompute_agent_status but GATING 'working' on a
live single-flight lease:

    terminated       -> never auto-flip (defensive; terminated rows filtered out)
    awaiting_request -> has >=1 open OUTGOING request  (ABOVE working)
    working          -> owns an active task AND holds a live lease right now
    idle             -> none of the above (incl. live-lease-with-no-task, OR
                        owned-task-with-no-live-lease — the sticky-'Working' fix)

Plus RAW `heartbeat_age_secs` (no threshold — a 'stalled' badge rides ISS-31).

These teeth pin the layered priority, the headline sticky-'Working' case, the
'working requires BOTH task and live lease' nuance, and that the stored column
is never mutated by this read-time path.
"""
import pytest


async def _snapshot_agent(client, cid, aid):
    """Fetch one agent row out of the container snapshot (GET /api/containers/{cid})."""
    r = await client.get(f"/api/containers/{cid}")
    assert r.status_code == 200, r.text
    rows = [a for a in r.json()["agents"] if a["id"] == aid]
    assert len(rows) == 1, f"agent {aid} not in snapshot"
    return rows[0]


# ---------- read-time derived `status` ----------

@pytest.mark.asyncio
async def test_status_working_when_owns_task_and_live_lease(
        client, make_agent, make_task, container, db):
    """A worker that OWNS an active task AND holds a live lease is genuinely
    embodied → derived status 'working' (and the embodiment agrees)."""
    cid = container["id"]
    a = await make_agent("Live")
    aid = a["agent_id"]
    await make_task("do the thing", "done when done", assignee_alias="Live")
    await client.post(f"/api/agents/{aid}/wake-claim",
                      json={"lease_ttl": 300, "lease_kind": "ephemeral"})

    row = await _snapshot_agent(client, cid, aid)
    assert row["status"] == "working"
    assert row["embodiment"] == "ephemeral"        # same live-lease predicate


@pytest.mark.asyncio
async def test_status_idle_when_owns_task_but_no_live_lease(
        client, make_agent, make_task, container, db):
    """THE headline bug (ISS-16): an agent that OWNS an in_progress task but has
    NO live lease (the worker exited) must read 'idle' — even though the STORED
    column still says 'working'. The read-time derivation corrects the lie WITHOUT
    touching the persisted value (which internal callers still rely on)."""
    cid = container["id"]
    a = await make_agent("Ghost")
    aid = a["agent_id"]
    await make_task("orphaned work", "done", assignee_alias="Ghost")

    # The stored column is the ownership-derived (sticky) 'working'...
    stored = db.execute("SELECT status FROM agents WHERE id=%s", (aid,))[0]["status"]
    assert stored == "working", "stored status is ownership-derived → sticky 'working'"
    # ...but the surfaced, liveness-derived status reads 'idle' (no live lease).
    row = await _snapshot_agent(client, cid, aid)
    assert row["status"] == "idle", "no live lease → liveness says idle"


@pytest.mark.asyncio
async def test_status_idle_when_live_lease_but_no_task(client, make_agent, container, db):
    """Helm's REUSE nuance: 'working' requires BOTH an active task AND a live lease.
    A live lease ALONE (no owned task) is NOT 'working' — it reads 'idle'."""
    cid = container["id"]
    a = await make_agent("Resident")
    aid = a["agent_id"]
    # No task assigned.
    await client.post(f"/api/agents/{aid}/wake-claim",
                      json={"lease_ttl": 300, "lease_kind": "resident"})

    row = await _snapshot_agent(client, cid, aid)
    assert row["embodiment"] == "resident", "the lease IS live"
    assert row["status"] == "idle", "live lease but owns no active task → not 'working'"


@pytest.mark.asyncio
async def test_status_idle_when_lease_expired(client, make_agent, make_task, container, db):
    """An EXPIRED lease is not live → derived status falls back to 'idle' (mirrors the
    embodiment NULL-when-not-live contract exactly — same predicate, same boundary)."""
    cid = container["id"]
    a = await make_agent("Lapsed")
    aid = a["agent_id"]
    await make_task("work", "done", assignee_alias="Lapsed")
    await client.post(f"/api/agents/{aid}/wake-claim",
                      json={"lease_ttl": 300, "lease_kind": "resident"})
    # Force the lease into the past — held row, but no longer LIVE. GH #91/#90: a resident lives in
    # the CONVERSATION lane, so expire conv_lease_until (the lane its claim actually wrote).
    db.execute("UPDATE agent_wake_state SET conv_lease_until = now() - interval '60 seconds' "
               "WHERE agent_id=%s", (aid,))

    row = await _snapshot_agent(client, cid, aid)
    assert row["status"] == "idle"
    assert row["embodiment"] == "idle"             # the two stay in lockstep


@pytest.mark.asyncio
async def test_status_awaiting_request_outranks_working(
        client, make_agent, make_task, container, db):
    """Layered priority: awaiting_request sits ABOVE working. An agent that owns an
    active task AND holds a live lease (would-be 'working') but ALSO has an open
    OUTGOING request reads 'awaiting_request' — matching recompute_agent_status."""
    cid = container["id"]
    a = await make_agent("Asker")
    aid = a["agent_id"]
    await make_agent("Peer")
    await make_task("blocked work", "done", assignee_alias="Asker")
    await client.post(f"/api/agents/{aid}/wake-claim",
                      json={"lease_ttl": 300, "lease_kind": "ephemeral"})
    # Open outgoing request from Asker → awaiting_request must win over working.
    await client.post(f"/api/containers/{cid}/requests",
                      json={"requester_agent_id": aid, "target_alias": "Peer",
                            "payload": "need an answer", "type": "info"})

    row = await _snapshot_agent(client, cid, aid)
    assert row["status"] == "awaiting_request", "open outgoing request outranks working"


@pytest.mark.asyncio
async def test_heartbeat_age_secs_surfaced_raw(client, make_agent, container, db):
    """heartbeat_age_secs is the RAW seconds-since-last-ping (no threshold applied).
    A backdated agent reports ~the backdate."""
    cid = container["id"]
    a = await make_agent("Beat")
    aid = a["agent_id"]
    db.execute("UPDATE agents SET last_heartbeat_at = now() - interval '900 seconds' WHERE id=%s", (aid,))

    row = await _snapshot_agent(client, cid, aid)
    assert row["heartbeat_age_secs"] is not None
    assert 890 < float(row["heartbeat_age_secs"]) < 960, "raw age, unthresholded"


@pytest.mark.asyncio
async def test_heartbeat_age_secs_null_for_never_beat(client, make_agent, container, db):
    """A never-beat agent has NULL last_heartbeat_at → heartbeat_age_secs is null
    (we don't fabricate a zero — clients distinguish 'never beat' from 'just beat')."""
    cid = container["id"]
    a = await make_agent("Silent")
    aid = a["agent_id"]
    db.execute("UPDATE agents SET last_heartbeat_at = NULL WHERE id=%s", (aid,))

    row = await _snapshot_agent(client, cid, aid)
    assert row["heartbeat_age_secs"] is None


# ---------- the stored column is read-only on this path ----------

@pytest.mark.asyncio
async def test_stored_status_untouched_by_snapshot_and_reaper(
        client, make_agent, container, db):
    """The liveness derivation lives at READ time only — it never writes the stored
    `agents.status`. A stranded stored 'working' (agent owns no task, dead embodiment)
    survives BOTH a snapshot read AND an orphan-lease reap, while the SURFACED status
    correctly reads 'idle'. (Helm: keep the stored column untouched; the reaper does
    NOT recompute it — liveness is projected, not persisted.)"""
    cid = container["id"]
    a = await make_agent("Drift")
    aid = a["agent_id"]
    await client.post(f"/api/agents/{aid}/wake-claim",
                      json={"lease_ttl": 300, "lease_kind": "resident"})
    # Simulate the lie: stored status stuck at 'working' though the agent owns no task,
    # and the embodiment is now heartbeat-dead (reapable). GH #91/#90: a resident is a CONVERSATION
    # embodiment, so its heartbeat-death is on conv_last_heartbeat_at (the lane-scoped reaper keys
    # the conversation branch strictly on that column).
    db.execute("UPDATE agents SET status='working' WHERE id=%s", (aid,))
    db.execute("UPDATE agents SET last_heartbeat_at = now() - interval '2000 seconds' WHERE id=%s", (aid,))
    db.execute("UPDATE agent_wake_state SET conv_last_heartbeat_at = now() - interval '2000 seconds' "
               "WHERE agent_id=%s", (aid,))

    # Surfaced status reads idle (no live lease + no task) even before the reap.
    row = await _snapshot_agent(client, cid, aid)
    assert row["status"] == "idle"

    r = await client.post(f"/api/containers/{cid}/reap-orphan-leases")
    assert [x["agent_id"] for x in r.json()["reaped"]] == [aid]

    # Stored column is UNTOUCHED — still the stranded 'working' (internal truth, not
    # auto-corrected by this read-time feature).
    stored = db.execute("SELECT status FROM agents WHERE id=%s", (aid,))[0]["status"]
    assert stored == "working", "reaper must not mutate the stored status"
