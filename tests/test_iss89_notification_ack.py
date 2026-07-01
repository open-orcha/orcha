"""GH #89 — per-notification human acknowledge + wake suppression (the veto).

The pain point: sometimes the human does NOT want an agent to wake for a chosen notification —
they handle it themselves, so the agent must not burn a wake acting on it. The mechanism is a
per-ROW marker (`agent_events.human_acked_at`, migration 031), deliberately NOT the issue's
original cursor advance: acking one event must never swallow an unacked neighbor, and the veto
must hold on BOTH #104 lanes (work `delivered_ts` / conversation `conv_delivered_ts` are
cursors this column never touches).

Coverage, mirroring the plan (docs/plans/issue-89-plan.md §7):
  1. ack removes the wake reason (wake-scan flips)
  2. NO NEIGHBOR SWALLOW — the spec deviation's teeth (fails under a cursor design)
  3. lane coverage — the veto holds on the resident-drain (conversation) surface
  4. directed-message veto — an acked `prompt` is not injected into the wake prompt
  5. idempotency + guards (double-ack no-op, foreign/unknown 404, suppressed-name 400)
  6. bulk ack via notifications/read {suppress_wake} + the conversation_turn message-eater guard
  7. pending feed + total_pending + event_id; acked rows stay in the REGULAR feed as read
  8. read-but-unacked regression (Round-1 review fix): read alone neither hides nor suppresses
  9. clock-wake snooze gates ONLY auto_wake_due; event wakes fire through it
 10. long-poll delivery (_fetch_next_event) skips acked rows
 11. /wait entry precheck (Round-1 review fix): an acked-only backlog can't block the
     synthetic task_ready until timeout

Committed-isolation harness (see test_wake.py): wake-scan and the /wait worker thread read
committed rows from their own connections; non-API state is driven through the `db` fixture.
"""
import time

import pytest

import main


async def _scan(client, cid):
    r = await client.get(f"/api/containers/{cid}/wake-scan",
                         params={"cooldown": 0, "min_idle": 0})
    assert r.status_code == 200, r.text
    return r.json()


def _cand(scan, aid):
    return next(c for c in scan["candidates"] if c["agent_id"] == aid)


async def _prompt(client, aid, message):
    """Publish a directed `prompt` event (the canonical waking event) and return its bus row."""
    r = await client.post(f"/api/agents/{aid}/prompt", json={"message": message})
    assert r.status_code == 201, r.text


def _rows(db, aid):
    return db.event_rows(aid)


async def _ack(client, aid, event_id, *, suppress=True):
    return await client.post(
        f"/api/agents/{aid}/notifications/{event_id}/acknowledge",
        json={"suppress_wake": suppress})


# ---------------------------------------------------------------------------
# 1. ack removes the wake reason
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_ack_removes_wake_reason(client, container, make_agent, db):
    a = await make_agent("Vox89a", "eng")
    aid = a["agent_id"]
    await _prompt(client, aid, "please look at X")

    cand = _cand(await _scan(client, container["id"]), aid)
    assert cand["should_wake"] is True and cand["pending_events"] == 1

    ev = _rows(db, aid)[0]
    r = await _ack(client, aid, ev["id"])
    assert r.status_code == 200, r.text
    assert r.json()["suppressed"] is True and r.json()["human_acked_at"] is not None

    cand = _cand(await _scan(client, container["id"]), aid)
    assert cand["should_wake"] is False
    assert cand["pending_events"] == 0
    # the wake reason / triage surface must not name the vetoed event either
    assert cand["latest_event"] is None
    # max_event_ts stays over ALL events so a wake-ack still advances past the acked row
    assert cand["max_event_ts"] == pytest.approx(ev["ts"])


# ---------------------------------------------------------------------------
# 2. no neighbor swallow — the reason this is a per-row marker, not a cursor
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_ack_does_not_swallow_unacked_neighbor(client, container, make_agent, db):
    """Acking the NEWER of two pending events must leave the older one waking. Under the
    issue's original delivered_ts-advance design this test fails (the cursor jump past ts2
    silently suppresses ts1) — it is the teeth of the plan's one deliberate deviation."""
    a = await make_agent("Vox89b", "eng")
    aid = a["agent_id"]
    await _prompt(client, aid, "first ask")
    await _prompt(client, aid, "second ask")
    e1, e2 = _rows(db, aid)
    assert e1["ts"] <= e2["ts"]

    assert (await _ack(client, aid, e2["id"])).status_code == 200

    cand = _cand(await _scan(client, container["id"]), aid)
    assert cand["should_wake"] is True and cand["pending_events"] == 1
    # the wake manifest carries the survivor, not the vetoed row
    previews = " | ".join((n.get("preview") or "") for n in cand["notifications"])
    assert "first ask" in previews and "second ask" not in previews


# ---------------------------------------------------------------------------
# 3. lane coverage — the veto holds on the resident-drain surface too
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_ack_vetoes_resident_drain_surface(client, container, make_agent, db):
    """active-conversations' pending_inbox / inbox_messages (the conversation-lane drain
    surface) must honor the same per-row veto — lane-agnostic by construction."""
    human = await make_agent("Kedar89c", "human", kind="human")
    ai = await make_agent("Vox89c", "eng")
    aid = ai["agent_id"]
    r = await client.post(f"/api/agents/{aid}/conversations",
                          json={"actor_agent_id": human["agent_id"]})
    assert r.status_code in (200, 201), r.text

    await _prompt(client, aid, "eaten by the human")
    await _prompt(client, aid, "still live")
    e1, _e2 = _rows(db, aid)
    assert (await _ack(client, aid, e1["id"])).status_code == 200

    r = await client.get(f"/api/containers/{container['id']}/active-conversations")
    assert r.status_code == 200, r.text
    cand = next(c for c in r.json()["conversations"] if c["agent_id"] == aid)
    assert cand["pending_inbox"] == 1
    joined = "\n".join(cand["inbox_messages"])
    assert "still live" in joined and "eaten by the human" not in joined


# ---------------------------------------------------------------------------
# 4. directed-message veto — the wake prompt never carries an acked message
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_ack_vetoes_wake_prompt_injection(client, container, make_agent, db):
    a = await make_agent("Vox89d", "eng")
    aid = a["agent_id"]
    await _prompt(client, aid, "acked nudge")
    await _prompt(client, aid, "live nudge")
    e1, _ = _rows(db, aid)
    assert (await _ack(client, aid, e1["id"])).status_code == 200

    cand = _cand(await _scan(client, container["id"]), aid)
    joined = "\n".join(cand["prompt_messages"])
    assert "live nudge" in joined and "acked nudge" not in joined


# ---------------------------------------------------------------------------
# 5. idempotency + guards
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_ack_idempotent_and_guarded(client, container, make_agent, db):
    a = await make_agent("Vox89e", "eng")
    b = await make_agent("Nyx89e", "eng")
    aid = a["agent_id"]
    await _prompt(client, aid, "hi")
    ev = _rows(db, aid)[0]

    first = (await _ack(client, aid, ev["id"])).json()
    second_r = await _ack(client, aid, ev["id"])
    assert second_r.status_code == 200
    # double-ack is a no-op: the original stamp survives verbatim
    assert second_r.json()["human_acked_at"] == first["human_acked_at"]

    # suppress_wake=false stamps nothing (API-shape compat) — here on a fresh row
    await _prompt(client, b["agent_id"], "other")
    evb = _rows(db, b["agent_id"])[0]
    r = await _ack(client, b["agent_id"], evb["id"], suppress=False)
    assert r.status_code == 200
    assert r.json()["suppressed"] is False and r.json()["human_acked_at"] is None
    assert _rows(db, b["agent_id"])[0]["human_acked_at"] is None

    # foreign event (belongs to b) and unknown id → 404
    assert (await _ack(client, aid, evb["id"])).status_code == 404
    assert (await _ack(client, aid, 999999999)).status_code == 404

    # a _NOTIF_SUPPRESSED name (never feed-visible) → 400: you can't have "seen" it, and an
    # un-consumed live chat message must not be ackable out of existence
    rows = db.execute(
        "INSERT INTO agent_events (event_key, event_name, ts, payload) "
        "VALUES (%s, 'conversation_turn', %s, '{}') RETURNING id",
        (aid, time.time()))
    assert (await _ack(client, aid, rows[0]["id"])).status_code == 400


# ---------------------------------------------------------------------------
# 6. bulk ack — notifications/read {suppress_wake:true}
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_bulk_ack_bounded_and_spares_conversation_turns(client, container, make_agent, db):
    a = await make_agent("Vox89f", "eng")
    aid = a["agent_id"]
    await _prompt(client, aid, "old one")
    await _prompt(client, aid, "old two")
    # an un-consumed live chat message inside the acked band — MUST survive the bulk ack
    # (the message-eater guard: you can only ack what the feed can show you)
    db.execute(
        "INSERT INTO agent_events (event_key, event_name, ts, payload) "
        "VALUES (%s, 'conversation_turn', %s, '{}')", (aid, time.time()))
    mid_ts = max(r["ts"] for r in _rows(db, aid))
    await _prompt(client, aid, "newer than the ack bound")

    # without the flag: pure cursor move, nothing stamped (existing behaviour regression-pin)
    r = await client.post(f"/api/agents/{aid}/notifications/read", json={"through_ts": mid_ts})
    assert r.status_code == 200 and r.json()["suppressed_count"] == 0
    assert all(row["human_acked_at"] is None for row in _rows(db, aid))

    r = await client.post(f"/api/agents/{aid}/notifications/read",
                          json={"through_ts": mid_ts, "suppress_wake": True})
    assert r.status_code == 200, r.text
    assert r.json()["suppressed_count"] == 2      # the two prompts; NOT the conversation_turn
    by_name = {}
    for row in _rows(db, aid):
        by_name.setdefault(row["event_name"], []).append(row)
    acked = [row for row in by_name["prompt"] if row["human_acked_at"] is not None]
    assert len(acked) == 2 and all(row["ts"] <= mid_ts for row in acked)
    assert by_name["conversation_turn"][0]["human_acked_at"] is None
    # the row newer than through_ts stays pending
    newest = max(by_name["prompt"], key=lambda row: row["ts"])
    assert newest["human_acked_at"] is None

    cand = _cand(await _scan(client, container["id"]), aid)
    assert cand["should_wake"] is True and cand["pending_events"] == 1


# ---------------------------------------------------------------------------
# 7. pending feed — wake truth, both zones, event_id, consumed rows drop out
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_pending_feed_tracks_wake_truth(client, container, make_agent, db):
    a = await make_agent("Vox89g", "eng")
    aid = a["agent_id"]
    await _prompt(client, aid, "will be acked")           # needs_you zone
    db.execute(                                            # earlier zone
        "INSERT INTO agent_events (event_key, event_name, ts, payload) "
        "VALUES (%s, 'request_closed', %s, '{\"request_id\": \"r1\"}')",
        (aid, time.time()))
    await _prompt(client, aid, "stays pending")
    e1, e2, e3 = _rows(db, aid)
    assert (await _ack(client, aid, e1["id"])).status_code == 200

    r = await client.get(f"/api/agents/{aid}/notifications/pending")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total_pending"] == 2 and len(body["notifications"]) == 2
    ids = {n["event_id"] for n in body["notifications"]}
    assert ids == {e2["id"], e3["id"]}                    # acked row filtered, both zones present
    zones = {n["zone"] for n in body["notifications"]}
    assert zones == {"needs_you", "earlier"}

    # the acked row STAYS in the regular feed, dimmed as read — without a cursor move
    r = await client.get(f"/api/agents/{aid}/notifications")
    feed = {n["event_id"]: n for n in r.json()["notifications"]}
    assert feed[e1["id"]]["read"] is True
    assert feed[e3["id"]]["read"] is False
    assert r.json()["read_through_ts"] == 0.0

    # a row the agent already consumed (delivery cursor past it) drops out — nothing to veto
    db.execute(
        "INSERT INTO agent_wake_state (agent_id, delivered_ts) VALUES (%s, %s) "
        "ON CONFLICT (agent_id) DO UPDATE SET delivered_ts = EXCLUDED.delivered_ts",
        (aid, e2["ts"]))
    body = (await client.get(f"/api/agents/{aid}/notifications/pending")).json()
    assert body["total_pending"] == 1
    assert [n["event_id"] for n in body["notifications"]] == [e3["id"]]

    # badge parity: the container snapshot's batch agent rows carry the same count
    snap = (await client.get(f"/api/containers/{container['id']}")).json()
    arow = next(x for x in snap["agents"] if str(x["id"]) == aid)
    assert arow["total_pending"] == 1


# ---------------------------------------------------------------------------
# 8. read-but-unacked regression (Round-1 review fix)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_read_alone_neither_hides_nor_suppresses(client, container, make_agent, db):
    """Marking read is VISUAL dimming only. A read-but-unacked notification still wakes the
    agent, so it must stay in the pending panel and keep its badge count."""
    a = await make_agent("Vox89h", "eng")
    aid = a["agent_id"]
    await _prompt(client, aid, "read but never acked")
    ev = _rows(db, aid)[0]

    r = await client.post(f"/api/agents/{aid}/notifications/read", json={})
    assert r.status_code == 200 and r.json()["read_through_ts"] >= ev["ts"]

    body = (await client.get(f"/api/agents/{aid}/notifications/pending")).json()
    assert body["total_pending"] == 1
    assert [n["event_id"] for n in body["notifications"]] == [ev["id"]]

    cand = _cand(await _scan(client, container["id"]), aid)
    assert cand["should_wake"] is True and cand["pending_events"] == 1

    feed = (await client.get(f"/api/agents/{aid}/notifications")).json()["notifications"]
    assert feed[0]["event_id"] == ev["id"] and feed[0]["read"] is True


# ---------------------------------------------------------------------------
# 9. clock-wake snooze
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_snooze_gates_only_the_clock_wake(client, container, make_agent, db):
    a = await make_agent("Vox89i", "eng")
    aid = a["agent_id"]
    db.execute("UPDATE agents SET auto_wake_interval_secs=60 WHERE id=%s", (aid,))

    cand = _cand(await _scan(client, container["id"]), aid)
    assert cand["auto_wake_due"] is True and cand["should_wake"] is True

    r = await client.post(f"/api/agents/{aid}/wake/snooze", json={"snooze_seconds": 3600})
    assert r.status_code == 200 and r.json()["snooze_until"] is not None
    cand = _cand(await _scan(client, container["id"]), aid)
    assert cand["snoozed"] is True and cand["auto_wake_due"] is False
    assert cand["should_wake"] is False          # the clock was the only reason

    # a REAL event during the snooze still wakes — only auto_wake_due is gated
    await _prompt(client, aid, "urgent")
    cand = _cand(await _scan(client, container["id"]), aid)
    assert cand["should_wake"] is True and cand["auto_wake_due"] is False

    # snooze_seconds: 0 clears
    r = await client.post(f"/api/agents/{aid}/wake/snooze", json={"snooze_seconds": 0})
    assert r.status_code == 200 and r.json()["snooze_until"] is None
    cand = _cand(await _scan(client, container["id"]), aid)
    assert cand["snoozed"] is False and cand["auto_wake_due"] is True

    # an until_ts in the past clears too
    r = await client.post(f"/api/agents/{aid}/wake/snooze", json={"until_ts": time.time() - 5})
    assert r.status_code == 200 and r.json()["snooze_until"] is None

    # an EXPIRED snooze self-clears in the read (no sweeper, no lingering suppression)
    db.execute("UPDATE agent_wake_state SET snooze_until = now() - interval '1 minute' "
               "WHERE agent_id=%s", (aid,))
    cand = _cand(await _scan(client, container["id"]), aid)
    assert cand["snoozed"] is False and cand["auto_wake_due"] is True

    # exactly one of the two fields
    assert (await client.post(f"/api/agents/{aid}/wake/snooze", json={})).status_code == 422
    assert (await client.post(f"/api/agents/{aid}/wake/snooze",
                              json={"snooze_seconds": 60, "until_ts": time.time() + 60})
            ).status_code == 422


# ---------------------------------------------------------------------------
# 10. long-poll delivery skips acked rows
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_fetch_next_event_skips_acked(client, container, make_agent, db):
    a = await make_agent("Vox89j", "eng")
    aid = a["agent_id"]
    await _prompt(client, aid, "vetoed")
    await _prompt(client, aid, "delivered")
    e1, e2 = _rows(db, aid)
    assert (await _ack(client, aid, e1["id"])).status_code == 200

    evt = main._fetch_next_event(aid, 0.0)
    assert evt is not None and evt["ts"] == pytest.approx(e2["ts"])
    assert evt.get("message") == "delivered"
    # past the survivor: nothing left (the acked row is never handed out)
    assert main._fetch_next_event(aid, e2["ts"]) is None


# ---------------------------------------------------------------------------
# 11. /wait entry precheck (Round-1 review fix)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_wait_precheck_ignores_acked_backlog(client, container, make_agent, make_task, db):
    """An agent with an assigned READY task whose only pending event is acked must get the
    synthetic task_ready IMMEDIATELY. Without the precheck filter the acked row reads as 'real
    event pending', the poll falls through to _wait_for_event (which skips acked rows), and the
    listener blocks to timeout instead."""
    a = await make_agent("Vox89k", "eng")
    aid = a["agent_id"]
    # create-with-assignee lands in_progress; set the assigned+READY level state explicitly,
    # exactly as the iss23/iss50 probes do (the dep-cleared / re-readied assigned shape).
    t = await make_task("iss89 ready work", "done when tested")
    db.execute("UPDATE tasks SET status='ready' WHERE id=%s", (t["id"],))
    db.execute(
        """INSERT INTO agent_tasks (agent_id, task_id, assignment_status)
           VALUES (%s, %s, 'assigned')
           ON CONFLICT (agent_id, task_id) DO UPDATE
             SET assignment_status = EXCLUDED.assignment_status""",
        (aid, t["id"]))
    await _prompt(client, aid, "acked-only backlog")
    ev = _rows(db, aid)[0]
    assert (await _ack(client, aid, ev["id"])).status_code == 200

    t0 = time.monotonic()
    r = await client.get(f"/api/agents/{aid}/wait", params={"since_ts": 0, "timeout": 5})
    elapsed = time.monotonic() - t0
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["event"] == "task_ready" and body["task_id"] == t["id"]
    assert elapsed < 2.0, f"synthetic task_ready should be immediate, took {elapsed:.1f}s"

    # precedence pin: with an UNACKED event pending, the real event still wins over the synthetic
    await _prompt(client, aid, "real event")
    r = await client.get(f"/api/agents/{aid}/wait", params={"since_ts": 0, "timeout": 5})
    assert r.json()["event"] == "prompt" and r.json().get("message") == "real event"
