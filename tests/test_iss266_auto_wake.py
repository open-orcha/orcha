"""#266 — clock-driven AUTO-WAKE.

Covers the wake-scan `auto_wake_due` truth table (due / not-due / lease /
kill-switch / opt-in-NULL; GH#39: budget no longer gates the clock wake), the human-gated
PATCH /api/agents/{aid}/auto-wake (floor / null-disable / human-gating / 404 / human-target),
the snapshot surfacing, and the notifier's pure scheduled-wake prompt + event label.

Same committed-isolation harness as test_wake.py — the wake-scan reads committed rows from
the shared autocommit connection. We drive non-API state (turns_used, last_woken_at, lease)
through the `db` fixture and exercise every contract surface through the API.
"""
import pathlib
import sys
import uuid

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "orcha-cli"))
from orcha_cli import notifier  # noqa: E402


async def _scan(client, cid, aid, *, cooldown=15.0, min_idle=0.0):
    r = await client.get(f"/api/containers/{cid}/wake-scan",
                         params={"cooldown": cooldown, "min_idle": min_idle})
    assert r.status_code == 200, r.text
    body = r.json()
    cand = next((c for c in body["candidates"] if c["agent_id"] == aid), None)
    return body, cand


def _set_interval(db, aid, secs):
    db.execute("UPDATE agents SET auto_wake_interval_secs=%s WHERE id=%s", (secs, aid))


def _set_last_woken(db, aid, seconds_ago):
    """Seed the wake clock anchor `seconds_ago` in the past (NULL row created if absent)."""
    db.execute(
        "INSERT INTO agent_wake_state (agent_id, last_woken_at) "
        "VALUES (%s, now() - make_interval(secs => %s)) "
        "ON CONFLICT (agent_id) DO UPDATE SET last_woken_at = EXCLUDED.last_woken_at",
        (aid, float(seconds_ago)),
    )


# ---------- wake-scan truth table ----------

@pytest.mark.asyncio
async def test_auto_wake_fires_when_interval_set_and_never_woken(client, container, make_agent, db):
    """Opt-in interval + never woken (last_woken_at NULL ⇒ due immediately) + idle, with NO pending
    events or ready tasks ⇒ a clock-driven wake. This is the whole feature: a heartbeat poll."""
    a = await make_agent("A")
    aid = a["agent_id"]
    _, cand = await _scan(client, container["id"], aid)
    assert cand["auto_wake_due"] is False          # no interval set yet → opt-in default off
    assert cand["should_wake"] is False

    _set_interval(db, aid, 60)
    _, cand = await _scan(client, container["id"], aid)
    assert cand["auto_wake_due"] is True
    assert cand["auto_wake_interval_secs"] == 60
    assert cand["should_wake"] is True
    assert "scheduled auto-wake" in cand["reason"]
    assert cand["pending_events"] == 0 and cand["auto_start_task_ids"] == []   # purely clock-driven


@pytest.mark.asyncio
async def test_auto_wake_fires_once_interval_elapsed(client, container, make_agent, db):
    """Clock floats off last_woken_at: not-due while inside the interval, due once it elapses."""
    a = await make_agent("A")
    aid = a["agent_id"]
    _set_interval(db, aid, 60)

    _set_last_woken(db, aid, seconds_ago=10)       # 10s < 60s → not due
    _, cand = await _scan(client, container["id"], aid, cooldown=0)
    assert cand["auto_wake_due"] is False
    assert cand["should_wake"] is False
    assert cand["reason"] == "no pending events or ready tasks"

    _set_last_woken(db, aid, seconds_ago=120)      # 120s >= 60s → due
    _, cand = await _scan(client, container["id"], aid, cooldown=0)
    assert cand["auto_wake_due"] is True
    assert cand["should_wake"] is True


@pytest.mark.asyncio
async def test_auto_wake_disabled_when_interval_null(client, container, make_agent, db):
    """NULL interval (the opt-in default) never auto-wakes, even when long-idle and never woken."""
    a = await make_agent("A")
    aid = a["agent_id"]
    _set_last_woken(db, aid, seconds_ago=99999)
    _, cand = await _scan(client, container["id"], aid)
    assert cand["auto_wake_interval_secs"] is None
    assert cand["auto_wake_due"] is False
    assert cand["should_wake"] is False


@pytest.mark.asyncio
async def test_auto_wake_not_gated_by_budget(
        client, container, make_agent, make_request, db):
    """GH#39: the turns_used<turn_budget cost ceiling is removed, so an over-budget agent's clock
    wake is NO LONGER suppressed — an interval-due agent fires the clock wake regardless of budget.
    A real event still wakes it too (unchanged)."""
    a = await make_agent("A")
    b = await make_agent("B")
    aid = b["agent_id"]
    _set_interval(db, aid, 60)                     # due (never woken)
    db.execute("UPDATE agents SET turns_used=50, turn_budget=50 WHERE id=%s", (aid,))

    _, cand = await _scan(client, container["id"], aid)
    assert cand["auto_wake_due"] is True           # GH#39: budget no longer gates the clock wake
    assert cand["should_wake"] is True

    # A real pending event lands (A asks B) — still wakes, via the event.
    await make_request(a["agent_id"], "need input", target_alias="B")
    _, cand = await _scan(client, container["id"], aid)
    assert cand["pending_events"] >= 1
    assert cand["should_wake"] is True


@pytest.mark.asyncio
async def test_recurring_clock_keeps_firing_past_budget_iss25(
        client, container, make_agent, db):
    """GH #25: a fixed-interval clock wake must keep firing for as long as it is scheduled. It
    previously stopped 'after a few cycles' because every wake bumps turns_used and the clock was
    gated on turns_used<turn_budget — so once the budget (default 50) was spent, auto_wake_due went
    permanently False and the recurring series silently died. GH #39 removed that gate.

    This proves the RECURRING property across many cycles AND past budget exhaustion: the clock is
    stateless (due = secs_since_woken >= interval), so it re-arms automatically every cycle off
    last_woken_at — a missed/late tick or a spent budget can't cancel the series. TEETH: restore the
    `turns_used < turn_budget` term in wake-scan and this fails at the first over-budget cycle."""
    a = await make_agent("Looper")
    aid = a["agent_id"]
    _set_interval(db, aid, 300)                        # every 5 minutes
    db.execute("UPDATE agents SET turns_used=0, turn_budget=3 WHERE id=%s", (aid,))  # tiny budget
    for cycle in range(10):                            # far more cycles than the budget allows
        _set_last_woken(db, aid, seconds_ago=301)      # cadence elapsed → this cycle is due
        db.execute("UPDATE agents SET turns_used = turns_used + 5 WHERE id=%s", (aid,))  # wake spends turns
        _, cand = await _scan(client, container["id"], aid)
        assert cand["auto_wake_due"] is True, f"clock wake stopped firing at cycle {cycle}"
        assert cand["should_wake"] is True, f"agent not woken at cycle {cycle}"


@pytest.mark.asyncio
async def test_auto_wake_suppressed_by_live_lease(client, container, make_agent, db):
    """A live single-flight lease suppresses a clock wake exactly like an event wake (no double-spawn
    over a live worker) — events/clock stay due and fire after release."""
    a = await make_agent("A")
    aid = a["agent_id"]
    _set_interval(db, aid, 60)
    db.execute(
        "INSERT INTO agent_wake_state (agent_id, wake_lease_until, lease_kind) "
        "VALUES (%s, now() + make_interval(secs => 300), 'ephemeral') "
        "ON CONFLICT (agent_id) DO UPDATE SET wake_lease_until=EXCLUDED.wake_lease_until, "
        "lease_kind=EXCLUDED.lease_kind",
        (aid,),
    )
    _, cand = await _scan(client, container["id"], aid)
    assert cand["auto_wake_due"] is True           # the clock IS due …
    assert cand["lease_active"] is True
    assert cand["should_wake"] is False            # … but a live worker holds the lease


@pytest.mark.asyncio
async def test_auto_wake_suppressed_by_kill_switch(client, container, make_agent, db):
    """Strictly subordinate to the global wakes_enabled kill-switch — flipping it off halts a due
    clock wake too, no new bypass."""
    a = await make_agent("A")
    aid = a["agent_id"]
    _set_interval(db, aid, 60)
    r = await client.post(f"/api/containers/{container['id']}/wakes", json={"enabled": False})
    assert r.status_code == 200, r.text
    _, cand = await _scan(client, container["id"], aid)
    assert cand["auto_wake_due"] is True
    assert cand["should_wake"] is False
    assert "kill-switch" in cand["reason"]


# ---------- PATCH /api/agents/{aid}/auto-wake (human-gated) ----------

@pytest.mark.asyncio
async def test_patch_enable_then_disable_surfaces_everywhere(client, container, make_agent, db):
    a = await make_agent("A")
    aid = a["agent_id"]
    human = await make_agent("Human", kind="human")
    hid = human["agent_id"]

    # enable
    r = await client.patch(f"/api/agents/{aid}/auto-wake",
                           json={"actor_agent_id": hid, "interval_secs": 120})
    assert r.status_code == 200, r.text
    assert r.json()["auto_wake_interval_secs"] == 120 and r.json()["enabled"] is True

    # surfaces in wake-scan AND the container agent snapshot
    _, cand = await _scan(client, container["id"], aid)
    assert cand["auto_wake_interval_secs"] == 120
    snap = (await client.get(f"/api/containers/{container['id']}")).json()
    row = next(ag for ag in snap["agents"] if ag["id"] == aid)
    assert row["auto_wake_interval_secs"] == 120

    # disable with an explicit null (unambiguous — not "unchanged")
    r = await client.patch(f"/api/agents/{aid}/auto-wake",
                           json={"actor_agent_id": hid, "interval_secs": None})
    assert r.status_code == 200, r.text
    assert r.json()["auto_wake_interval_secs"] is None and r.json()["enabled"] is False
    assert db.execute("SELECT auto_wake_interval_secs FROM agents WHERE id=%s", (aid,))[0][
        "auto_wake_interval_secs"] is None


@pytest.mark.asyncio
async def test_patch_floor_rejected_422(client, container, make_agent):
    a = await make_agent("A")
    human = await make_agent("Human", kind="human")
    # 30 < 60s floor → Pydantic ge=60 rejects before SQL
    r = await client.patch(f"/api/agents/{a['agent_id']}/auto-wake",
                           json={"actor_agent_id": human["agent_id"], "interval_secs": 30})
    assert r.status_code == 422, r.text
    # exactly 60 is accepted (boundary)
    r = await client.patch(f"/api/agents/{a['agent_id']}/auto-wake",
                           json={"actor_agent_id": human["agent_id"], "interval_secs": 60})
    assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_patch_requires_human_actor(client, container, make_agent):
    a = await make_agent("A")
    other = await make_agent("B")        # an AI actor
    r = await client.patch(f"/api/agents/{a['agent_id']}/auto-wake",
                           json={"actor_agent_id": other["agent_id"], "interval_secs": 90})
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_patch_unknown_agent_404_and_human_target_400(client, container, make_agent):
    human = await make_agent("Human", kind="human")
    hid = human["agent_id"]
    # unknown target → 404 (actor passes the human gate first)
    r = await client.patch(f"/api/agents/{uuid.uuid4()}/auto-wake",
                           json={"actor_agent_id": hid, "interval_secs": 90})
    assert r.status_code == 404, r.text
    # a human is never woken → 400
    r = await client.patch(f"/api/agents/{hid}/auto-wake",
                           json={"actor_agent_id": hid, "interval_secs": 90})
    assert r.status_code == 400, r.text


# ---------- FIRING fix: active_conversations.auto_wake_due (warm resident yield seam) ----------

async def _start_conv(client, aid, human_id):
    r = await client.post(f"/api/agents/{aid}/conversations", json={"actor_agent_id": human_id})
    assert r.status_code in (200, 201), r.text
    return r.json()["conversation"]["id"]


async def _active_cand(client, cid, conv_id):
    r = await client.get(f"/api/containers/{cid}/active-conversations")
    assert r.status_code == 200, r.text
    return next((c for c in r.json()["conversations"] if c["conversation_id"] == conv_id), None)


@pytest.mark.asyncio
async def test_active_conversations_auto_wake_due_truth_table(client, container, make_agent, db):
    """FIRING fix: the resident-discovery scan now reports auto_wake_due so a warm-but-idle resident
    can be yielded for a clock wake. Identical interlocks to wake_scan: opt-in interval and the
    cadence elapsed off last_woken_at. GH#39: no turn-budget cost ceiling."""
    human = await make_agent("KedarAW", "human", kind="human")
    ai = await make_agent("VoxAW", "eng")
    aid = ai["agent_id"]
    conv_id = await _start_conv(client, aid, human["agent_id"])

    # opt-in default OFF: no interval → never due, even though never-woken
    cand = await _active_cand(client, container["id"], conv_id)
    assert cand is not None and cand["auto_wake_due"] is False

    # interval set + never woken (NULL anchor) → due immediately
    _set_interval(db, aid, 60)
    cand = await _active_cand(client, container["id"], conv_id)
    assert cand["auto_wake_due"] is True

    # inside the interval → not due
    _set_last_woken(db, aid, seconds_ago=10)
    assert (await _active_cand(client, container["id"], conv_id))["auto_wake_due"] is False
    # cadence elapsed → due
    _set_last_woken(db, aid, seconds_ago=120)
    assert (await _active_cand(client, container["id"], conv_id))["auto_wake_due"] is True

    # GH#39: over the old cost ceiling → still due; turns_used no longer gates the clock wake
    db.execute("UPDATE agents SET turns_used=turn_budget WHERE id=%s", (aid,))
    assert (await _active_cand(client, container["id"], conv_id))["auto_wake_due"] is True


# ---------- FIRING fix: wake-ack stamp_woken preserves the cadence clock ----------

@pytest.mark.asyncio
async def test_wake_ack_stamp_woken_false_preserves_clock(client, container, make_agent, db):
    """The auto-wake idle-yield releases the lease WITHOUT counting as a wake: stamp_woken=False must
    leave last_woken_at untouched (so the ephemeral clock wake it stepped aside for still reads
    auto_wake_due), yet still release the single-flight lease."""
    a = await make_agent("A")
    aid = a["agent_id"]
    _set_interval(db, aid, 60)
    _set_last_woken(db, aid, seconds_ago=120)        # cadence is due
    db.execute(
        "UPDATE agent_wake_state SET wake_lease_until=now() + make_interval(secs => 300), "
        "lease_kind='resident' WHERE agent_id=%s", (aid,))
    before = db.execute("SELECT last_woken_at FROM agent_wake_state WHERE agent_id=%s",
                        (aid,))[0]["last_woken_at"]

    # release-only ack with stamp_woken=False (what _close_resident posts on an auto_wake_yield)
    r = await client.post(f"/api/agents/{aid}/wake-ack",
                          json={"kind": "resident_auto_wake_yield", "release_lease": True,
                                "stamp_woken": False})
    assert r.status_code == 200, r.text
    after = db.execute("SELECT last_woken_at, wake_lease_until, lease_kind "
                       "FROM agent_wake_state WHERE agent_id=%s", (aid,))[0]
    assert after["last_woken_at"] == before          # clock NOT reset
    assert after["wake_lease_until"] is None and after["lease_kind"] is None   # lease released
    # the clock survived → wake-scan still sees the auto-wake as due, lease gone → it now fires
    _, cand = await _scan(client, container["id"], aid)
    assert cand["auto_wake_due"] is True and cand["lease_active"] is False
    assert cand["should_wake"] is True

    # contrast: a normal ack (stamp_woken default True) DOES reset the clock → no longer due
    r = await client.post(f"/api/agents/{aid}/wake-ack",
                          json={"kind": "ephemeral", "event": "auto_wake"})
    assert r.status_code == 200, r.text
    _, cand = await _scan(client, container["id"], aid)
    assert cand["auto_wake_due"] is False            # last_woken_at=now() → inside the interval again


# ---------- notifier (pure) ----------

def test_notifier_scheduled_wake_prompt_and_event_label():
    """A clock-driven wake with nothing flagged gets a 'scheduled heartbeat' prompt (not the
    misleading generic 'pending work') and the daemon labels the event 'auto_wake'."""
    cand = {"alias": "Mon", "should_wake": True, "auto_wake_due": True,
            "pending_events": 0, "auto_start_task_ids": [], "prompt_messages": []}
    prompt = notifier.build_wake_prompt(cand)
    assert "scheduled heartbeat wake" in prompt
    assert "[orcha wake] Mon:" in prompt

    # the event label the daemon (tick()) derives for an auto_wake-only candidate — call the
    # SAME production helper tick() uses, not a re-derived copy, so removing the #266 branch in
    # notifier.derive_wake_event would fail this assertion.
    assert notifier.derive_wake_event(cand) == "auto_wake"


def test_derive_wake_event_precedence():
    """derive_wake_event is the single source of the wake LABEL tick() records. Precedence:
    a real pending event > an auto-start ready task > #266 clock heartbeat > nothing. Driving
    the production helper directly means a regression in any branch (e.g. dropping the
    `auto_wake` term) is caught here rather than passing against an inline duplicate."""
    # real event wins over everything
    assert notifier.derive_wake_event(
        {"latest_event": "task_message", "auto_start_task_ids": [1], "auto_wake_due": True}
    ) == "task_message"
    # no event → an auto-start ready task wins over the clock
    assert notifier.derive_wake_event(
        {"latest_event": None, "auto_start_task_ids": ["t1"], "auto_wake_due": True}
    ) == "auto_start"
    # no event, no ready task, clock due → #266 heartbeat label
    assert notifier.derive_wake_event(
        {"latest_event": None, "auto_start_task_ids": [], "auto_wake_due": True}
    ) == "auto_wake"
    # nothing flagged → no label
    assert notifier.derive_wake_event(
        {"latest_event": None, "auto_start_task_ids": [], "auto_wake_due": False}
    ) is None


def test_notifier_real_work_prompt_unchanged_by_auto_wake_flag():
    """When real work is pending, the scheduled-heartbeat phrasing is NOT added — the event/task
    bits drive the prompt (the heartbeat branch is gated on nothing else being flagged)."""
    cand = {"alias": "A", "should_wake": True, "auto_wake_due": True,
            "pending_events": 2, "auto_start_task_ids": [], "prompt_messages": []}
    prompt = notifier.build_wake_prompt(cand)
    assert "2 new event(s)" in prompt
    assert "scheduled heartbeat wake" not in prompt
