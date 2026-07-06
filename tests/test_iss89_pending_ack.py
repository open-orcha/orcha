"""GH#89 — human view + acknowledge of an agent's pending notifications (wake veto).

The driving question is not "did the human see it?" but "should the agent still act on it?".
Acknowledging removes an item from the agent's wake queue by advancing BOTH the human read cursor
(agent_notification_state.read_through_ts) AND the daemon delivery cursor
(agent_wake_state.delivered_ts), so the next wake-scan no longer counts it.

Four surfaces:
  1. GET  /notifications/pending — only unacknowledged (ts > read_through), all zones, total_pending;
  2. POST /notifications/{id}/acknowledge — advances both cursors (GREATEST, never backward), 404-scoped;
  3. POST /notifications/read {suppress_wake} — bulk ack advances both cursors to max ts;
  4. POST /wake/snooze — suppresses the CLOCK wake only (event wakes still fire), until/relative + 422.

Same committed-isolation harness as test_wake.py / test_iss266_auto_wake.py — the wake-scan reads
committed rows from the shared autocommit `db` connection.
"""
import json as _json

import pytest

import main


async def _emit(db, *, event_key, event_name, ts, payload=None):
    """Insert one agent_events bus row directly (as _publish_event would)."""
    db.execute(
        """INSERT INTO agent_events (event_key, event_name, ts, payload)
           VALUES (%s, %s, %s, %s::jsonb) RETURNING id""",
        (event_key, event_name, ts, _json.dumps(payload or {})),
    )


def _event_id(db, event_key, ts):
    return db.execute("SELECT id FROM agent_events WHERE event_key=%s AND ts=%s",
                      (event_key, ts))[0]["id"]


def _cursors(db, aid):
    ns = db.execute("SELECT read_through_ts FROM agent_notification_state WHERE agent_id=%s", (aid,))
    ws = db.execute("SELECT delivered_ts FROM agent_wake_state WHERE agent_id=%s", (aid,))
    return (ns[0]["read_through_ts"] if ns else None,
            ws[0]["delivered_ts"] if ws else None)


async def _scan(client, cid, aid, *, cooldown=15.0, min_idle=0.0):
    r = await client.get(f"/api/containers/{cid}/wake-scan",
                         params={"cooldown": cooldown, "min_idle": min_idle})
    assert r.status_code == 200, r.text
    cand = next((c for c in r.json()["candidates"] if c["agent_id"] == aid), None)
    return cand


# ---------------------------------------------------------------------------
# 1. pending feed
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_pending_returns_only_unacknowledged_across_zones(client, container, make_agent, db):
    """Only ts > read_through_ts, spanning BOTH zones (needs_you `prompt` + earlier `task_message`),
    with an accurate total_pending."""
    a = await make_agent("Recv")
    aid = a["agent_id"]
    await _emit(db, event_key=aid, event_name="prompt", ts=10.0, payload={"message": "nudge"})
    await _emit(db, event_key=aid, event_name="task_message", ts=20.0, payload={"task_id": "T", "preview": "hi"})
    await _emit(db, event_key=aid, event_name="request_answered", ts=30.0, payload={"request_id": "R"})

    body = (await client.get(f"/api/agents/{aid}/notifications/pending")).json()
    assert body["total_pending"] == 3
    zones = {n["zone"] for n in body["notifications"]}
    assert "needs_you" in zones and "earlier" in zones      # spans all zones
    assert [n["ts"] for n in body["notifications"]] == [30.0, 20.0, 10.0]   # newest first
    assert all("id" in n for n in body["notifications"])    # carries the notif_id for acknowledge

    # advance the read cursor past ts=20 → only the ts=30 row remains pending
    await client.post(f"/api/agents/{aid}/notifications/read", json={"through_ts": 20.0})
    body = (await client.get(f"/api/agents/{aid}/notifications/pending")).json()
    assert body["total_pending"] == 1
    assert [n["ts"] for n in body["notifications"]] == [30.0]


@pytest.mark.asyncio
async def test_pending_excludes_suppressed_from_count(client, container, make_agent, db):
    """conversation_turn / digest_snapshotted never surface and never inflate total_pending."""
    a = await make_agent("Recv")
    aid = a["agent_id"]
    await _emit(db, event_key=aid, event_name="conversation_turn", ts=5.0, payload={"turn_id": "x"})
    await _emit(db, event_key=aid, event_name="digest_snapshotted", ts=6.0, payload={})
    await _emit(db, event_key=aid, event_name="task_message", ts=7.0, payload={"task_id": "T"})
    body = (await client.get(f"/api/agents/{aid}/notifications/pending")).json()
    assert body["total_pending"] == 1
    assert [n["event_name"] for n in body["notifications"]] == ["task_message"]


@pytest.mark.asyncio
async def test_pending_keyset_pages_without_drops(client, container, make_agent, db):
    """Compound (ts, id) keyset pages the unacknowledged tail with zero drops/dupes."""
    a = await make_agent("Recv")
    aid = a["agent_id"]
    for i in range(5):
        await _emit(db, event_key=aid, event_name="task_message", ts=100.0,
                    payload={"task_id": f"co{i}", "preview": f"co{i}"})
    collected, before_ts, before_id, guard = [], None, None, 0
    while True:
        guard += 1
        assert guard < 20
        qs = "limit=2"
        if before_ts is not None:
            qs += f"&before_ts={before_ts}"
        if before_id is not None:
            qs += f"&before_id={before_id}"
        pg = (await client.get(f"/api/agents/{aid}/notifications/pending?{qs}")).json()
        collected += [n["deeplink"]["id"] for n in pg["notifications"]]
        before_ts, before_id = pg["next_before_ts"], pg["next_before_id"]
        if before_ts is None:
            break
    assert sorted(collected) == [f"co{i}" for i in range(5)]
    assert len(collected) == len(set(collected))


# ---------------------------------------------------------------------------
# 2. per-notification acknowledge
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_acknowledge_advances_both_cursors(client, container, make_agent, db):
    """Default suppress_wake=true advances read_through_ts AND delivered_ts to the event ts; the
    item drops out of the pending feed on re-fetch."""
    a = await make_agent("Recv")
    aid = a["agent_id"]
    await _emit(db, event_key=aid, event_name="task_message", ts=42.0, payload={"task_id": "T"})
    nid = _event_id(db, aid, 42.0)

    r = await client.post(f"/api/agents/{aid}/notifications/{nid}/acknowledge", json={})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["read_through_ts"] == 42.0
    assert body["delivered_ts"] == 42.0
    assert body["suppress_wake"] is True
    assert _cursors(db, aid) == (42.0, 42.0)

    # gone from pending
    pend = (await client.get(f"/api/agents/{aid}/notifications/pending")).json()
    assert pend["total_pending"] == 0 and pend["notifications"] == []


@pytest.mark.asyncio
async def test_acknowledge_greatest_guard_is_a_noop(client, container, make_agent, db):
    """Acknowledging an event the daemon already acted on (delivered_ts already past it) never moves
    a cursor backward — it's a harmless no-op, not an error."""
    a = await make_agent("Recv")
    aid = a["agent_id"]
    await _emit(db, event_key=aid, event_name="task_message", ts=10.0, payload={"task_id": "old"})
    await _emit(db, event_key=aid, event_name="task_message", ts=90.0, payload={"task_id": "new"})
    old_id = _event_id(db, aid, 10.0)
    # daemon already woke through ts=90
    db.execute("INSERT INTO agent_wake_state (agent_id, delivered_ts) VALUES (%s, 90.0) "
               "ON CONFLICT (agent_id) DO UPDATE SET delivered_ts=90.0", (aid,))
    db.execute("INSERT INTO agent_notification_state (agent_id, read_through_ts) VALUES (%s, 90.0) "
               "ON CONFLICT (agent_id) DO UPDATE SET read_through_ts=90.0", (aid,))

    r = await client.post(f"/api/agents/{aid}/notifications/{old_id}/acknowledge", json={})
    assert r.status_code == 200, r.text
    # both cursors STAY at 90 (GREATEST guard) — never dragged back to 10
    assert r.json()["read_through_ts"] == 90.0 and r.json()["delivered_ts"] == 90.0
    assert _cursors(db, aid) == (90.0, 90.0)


@pytest.mark.asyncio
async def test_acknowledge_suppress_wake_false_leaves_delivered(client, container, make_agent, db):
    """suppress_wake=false = mark-read only: read cursor advances, delivered_ts untouched (no wake veto)."""
    a = await make_agent("Recv")
    aid = a["agent_id"]
    await _emit(db, event_key=aid, event_name="task_message", ts=55.0, payload={"task_id": "T"})
    nid = _event_id(db, aid, 55.0)
    r = await client.post(f"/api/agents/{aid}/notifications/{nid}/acknowledge",
                          json={"suppress_wake": False})
    assert r.status_code == 200, r.text
    assert r.json()["read_through_ts"] == 55.0
    assert r.json()["delivered_ts"] is None
    read, delivered = _cursors(db, aid)
    assert read == 55.0 and delivered is None       # no wake_state row created


@pytest.mark.asyncio
async def test_acknowledge_removes_wake_reason_in_scan(client, container, make_agent, db):
    """End-to-end: an unacknowledged event wakes the agent; after acknowledge the next scan no longer
    counts it (pending_events → 0, should_wake → false)."""
    a = await make_agent("Recv")
    aid = a["agent_id"]
    await _emit(db, event_key=aid, event_name="task_message", ts=1000.0, payload={"task_id": "T"})
    cand = await _scan(client, container["id"], aid)
    assert cand["pending_events"] >= 1 and cand["should_wake"] is True

    nid = _event_id(db, aid, 1000.0)
    r = await client.post(f"/api/agents/{aid}/notifications/{nid}/acknowledge", json={})
    assert r.status_code == 200, r.text
    cand = await _scan(client, container["id"], aid)
    assert cand["pending_events"] == 0
    assert cand["should_wake"] is False


@pytest.mark.asyncio
async def test_acknowledge_scoped_to_agent_404(client, container, make_agent, db):
    """A human can't acknowledge another agent's notification — event id not on this agent's key → 404."""
    me = await make_agent("Me")
    other = await make_agent("Other")
    await _emit(db, event_key=other["agent_id"], event_name="task_message", ts=3.0, payload={"task_id": "T"})
    nid = _event_id(db, other["agent_id"], 3.0)
    r = await client.post(f"/api/agents/{me['agent_id']}/notifications/{nid}/acknowledge", json={})
    assert r.status_code == 404, r.text
    # unknown id → 404 too
    r = await client.post(f"/api/agents/{me['agent_id']}/notifications/999999/acknowledge", json={})
    assert r.status_code == 404
    # bad uuid → 400
    r = await client.post(f"/api/agents/not-a-uuid/notifications/{nid}/acknowledge", json={})
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# 3. bulk acknowledge (mark-all-read + suppress_wake)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_bulk_read_suppress_wake_advances_both_to_max(client, container, make_agent, db):
    """POST /notifications/read {suppress_wake:true} with no through_ts advances read AND delivered
    to the max event ts (Acknowledge all)."""
    a = await make_agent("Recv")
    aid = a["agent_id"]
    await _emit(db, event_key=aid, event_name="task_message", ts=5.0, payload={"task_id": "T"})
    await _emit(db, event_key=aid, event_name="task_message", ts=9.0, payload={"task_id": "T"})
    r = await client.post(f"/api/agents/{aid}/notifications/read", json={"suppress_wake": True})
    assert r.status_code == 200, r.text
    assert r.json()["read_through_ts"] == 9.0 and r.json()["delivered_ts"] == 9.0
    assert _cursors(db, aid) == (9.0, 9.0)


@pytest.mark.asyncio
async def test_bulk_read_default_leaves_delivered_untouched(client, container, make_agent, db):
    """The legacy default (no suppress_wake) still advances ONLY the read cursor — the daemon
    delivery cursor is never crossed (backward-compat)."""
    a = await make_agent("Recv")
    aid = a["agent_id"]
    await _emit(db, event_key=aid, event_name="task_message", ts=8.0, payload={"task_id": "T"})
    r = await client.post(f"/api/agents/{aid}/notifications/read", json={})
    assert r.json()["read_through_ts"] == 8.0
    assert r.json()["delivered_ts"] is None
    read, delivered = _cursors(db, aid)
    assert read == 8.0 and delivered is None


# ---------------------------------------------------------------------------
# 4. wake snooze (clock wakes only)
# ---------------------------------------------------------------------------

def _set_interval(db, aid, secs):
    db.execute("UPDATE agents SET auto_wake_interval_secs=%s WHERE id=%s", (secs, aid))


@pytest.mark.asyncio
async def test_snooze_suppresses_clock_wake_not_event_wake(client, container, make_agent, db):
    """A due clock wake is suppressed while snoozed; a real event still wakes the agent during the
    snooze; the interval is untouched (auto-wake not disabled)."""
    a = await make_agent("A")
    aid = a["agent_id"]
    _set_interval(db, aid, 60)                       # never woken → clock due

    cand = await _scan(client, container["id"], aid)
    assert cand["auto_wake_due"] is True and cand["should_wake"] is True

    r = await client.post(f"/api/agents/{aid}/wake/snooze", json={"snooze_seconds": 3600})
    assert r.status_code == 200, r.text
    assert r.json()["snooze_until"] is not None

    cand = await _scan(client, container["id"], aid)
    assert cand["snooze_active"] is True
    assert cand["auto_wake_due"] is False            # clock term suppressed …
    assert cand["should_wake"] is False
    assert cand["auto_wake_interval_secs"] == 60      # … but the interval is preserved

    # an event still wakes a snoozed agent
    await _emit(db, event_key=aid, event_name="task_message", ts=1.0e12, payload={"task_id": "T"})
    cand = await _scan(client, container["id"], aid)
    assert cand["pending_events"] >= 1 and cand["should_wake"] is True


@pytest.mark.asyncio
async def test_snooze_until_ts_and_past_ts_clears(client, container, make_agent, db):
    """until_ts sets an absolute window; a past until_ts is effectively no snooze (clock fires again)."""
    a = await make_agent("A")
    aid = a["agent_id"]
    _set_interval(db, aid, 60)

    far_future = 9.0e12
    r = await client.post(f"/api/agents/{aid}/wake/snooze", json={"until_ts": far_future})
    assert r.status_code == 200 and r.json()["snooze_until"] == far_future
    cand = await _scan(client, container["id"], aid)
    assert cand["auto_wake_due"] is False and cand["snooze_active"] is True

    # move it to the past → snooze no longer active, clock resumes
    r = await client.post(f"/api/agents/{aid}/wake/snooze", json={"until_ts": 1.0})
    assert r.status_code == 200
    cand = await _scan(client, container["id"], aid)
    assert cand["snooze_active"] is False
    assert cand["auto_wake_due"] is True


@pytest.mark.asyncio
async def test_snooze_validation(client, container, make_agent):
    """Exactly one of until_ts / snooze_seconds; neither or both → 422; bad uuid → 400."""
    a = await make_agent("A")
    aid = a["agent_id"]
    assert (await client.post(f"/api/agents/{aid}/wake/snooze", json={})).status_code == 422
    assert (await client.post(f"/api/agents/{aid}/wake/snooze",
                              json={"until_ts": 5.0, "snooze_seconds": 60})).status_code == 422
    # non-positive relative window rejected by the field constraint
    assert (await client.post(f"/api/agents/{aid}/wake/snooze",
                              json={"snooze_seconds": 0})).status_code == 422
    assert (await client.post("/api/agents/not-a-uuid/wake/snooze",
                              json={"snooze_seconds": 60})).status_code == 400


# ---------------------------------------------------------------------------
# 5. badge count on the container snapshot
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_snapshot_pending_notifications_badge(client, container, make_agent, db):
    """The container snapshot carries per-agent pending_notifications (the bell badge), matching the
    pending feed's total_pending and shrinking as items are acknowledged."""
    a = await make_agent("Recv")
    aid = a["agent_id"]
    await _emit(db, event_key=aid, event_name="task_message", ts=10.0, payload={"task_id": "T"})
    await _emit(db, event_key=aid, event_name="request_answered", ts=20.0, payload={"request_id": "R"})
    await _emit(db, event_key=aid, event_name="conversation_turn", ts=25.0, payload={})  # excluded

    def _badge(snap):
        return next(ag for ag in snap["agents"] if ag["id"] == aid)["pending_notifications"]

    snap = (await client.get(f"/api/containers/{container['id']}")).json()
    assert _badge(snap) == 2                          # conversation_turn excluded

    nid = _event_id(db, aid, 10.0)
    await client.post(f"/api/agents/{aid}/notifications/{nid}/acknowledge", json={})
    snap = (await client.get(f"/api/containers/{container['id']}")).json()
    assert _badge(snap) == 1                          # acknowledged one → badge shrinks
