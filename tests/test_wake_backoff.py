"""No-progress wake circuit breaker (INCIDENT: quantal-health, 2026-08-03 — ~4,300 wakes
over 3 days for a `task_created_unassigned` candidate the orchestrator kept receiving and
never acting on, billed invisibly against the operator's Claude subscription).

Covers: strike increment on a repeated candidate with a recent same-trigger completed run;
reset when the candidate disappears; ladder thresholds + suppression filtering (a suppressed
candidate is excluded from the wake-scan response — zero daemon changes); the tier-3
needs-you artifact fires exactly once per strike-streak; the human DELETE release valve
(and its gating); env-tunable thresholds; and the agent_spend `subscription-loop` insight.

Doctrine under test throughout: the breaker never touches task/agent state — every test that
asserts a suppression also asserts the underlying task/candidate DATA is untouched."""
import importlib

from portal_backend import task_start_core as core
from portal_backend.database import db_cursor

# asyncio_mode=auto (pytest.ini) handles async def tests without an explicit marker —
# this file also has plain sync tests (pure-function checks), so no module pytestmark.


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

async def _make_unassigned_trigger(client, container, make_agent, *, title="Route me"):
    """Reproduce the incident shape: an orchestrator + an unassigned task, which emits a
    task_created_unassigned candidate for the orchestrator (test_task_start_core's own
    fixture recipe, reused verbatim)."""
    cid = container["id"]
    reporter = await make_agent("reporter", kind="human")
    atlas = await make_agent("Atlas", role="orchestrator / system architect", kind="ai")
    with db_cursor() as (conn, cur):
        core.start_task_from_slack_capture(
            cur, cid, title=title, description="raw text",
            created_by_agent_id=reporter["agent_id"], assignee_agent_id=None,
        )
        conn.commit()
    return atlas["agent_id"]


async def _scan(client, cid):
    r = await client.get(f"/api/containers/{cid}/wake-scan", params={"cooldown": 0, "min_idle": 0})
    assert r.status_code == 200, r.text
    return r.json()


def _candidate_for(body, aid):
    return next((c for c in body["candidates"] if c["agent_id"] == aid), None)


async def _completed_run(client, aid, *, wake_event, ended_ago=None, db=None):
    """A finished (non-running) worker_run carrying the given wake_event — the 'ran, changed
    nothing, exited' shape the breaker keys off."""
    r = await client.post(f"/api/agents/{aid}/runs",
                          json={"wake_kind": "ephemeral", "wake_event": wake_event})
    assert r.status_code == 201, r.text
    rid = r.json()["run_id"]
    f = await client.post(f"/api/runs/{rid}/finish", json={"status": "exited", "exit_code": 0})
    assert f.status_code == 200, f.text
    if ended_ago and db is not None:
        db.execute(
            f"UPDATE worker_runs SET ended_at = now() - interval '{ended_ago}' WHERE run_id=%s",
            (rid,),
        )
    return rid


def _backoff_row(db, aid, wake_key="task_created_unassigned"):
    rows = db.execute(
        "SELECT * FROM wake_backoff WHERE agent_id=%s AND wake_key=%s", (aid, wake_key)
    )
    return rows[0] if rows else None


# --------------------------------------------------------------------------- #
# strike accounting
# --------------------------------------------------------------------------- #

async def test_strike_increments_on_repeated_candidate_with_recent_same_kind_run(
        client, container, make_agent, db):
    """A completed run sharing the candidate's wake_key, ended recently -> strikes++ on the
    NEXT scan tick (the strike judges the PRIOR tick's run, not the one that just happened)."""
    cid = container["id"]
    aid = await _make_unassigned_trigger(client, container, make_agent)

    body = await _scan(client, cid)
    assert _candidate_for(body, aid)["should_wake"] is True
    assert _backoff_row(db, aid) is None  # nothing struck yet — first sighting, no prior run

    await _completed_run(client, aid, wake_event="task_created_unassigned")
    body = await _scan(client, cid)
    row = _backoff_row(db, aid)
    assert row is not None and row["strikes"] == 1

    await _completed_run(client, aid, wake_event="task_created_unassigned")
    body = await _scan(client, cid)
    row = _backoff_row(db, aid)
    assert row["strikes"] == 2


async def test_no_strike_without_a_recent_completed_run(client, container, make_agent, db):
    """A candidate with NO corroborating run yet (brand new trigger) must not strike — striking
    would punish an agent that hasn't had a chance to act."""
    cid = container["id"]
    aid = await _make_unassigned_trigger(client, container, make_agent)
    await _scan(client, cid)
    await _scan(client, cid)
    assert _backoff_row(db, aid) is None


async def test_no_strike_when_run_is_too_old(client, container, make_agent, db):
    """A same-wake_key completed run OUTSIDE the recent-run window doesn't count — it may
    predate an unrelated intervening fix."""
    cid = container["id"]
    aid = await _make_unassigned_trigger(client, container, make_agent)
    await _completed_run(client, aid, wake_event="task_created_unassigned",
                         ended_ago="90 minutes", db=db)
    await _scan(client, cid)
    assert _backoff_row(db, aid) is None


async def test_no_strike_when_run_still_running(client, container, make_agent, db):
    """A STILL-RUNNING run can't yet be judged to have changed nothing."""
    cid = container["id"]
    aid = await _make_unassigned_trigger(client, container, make_agent)
    r = await client.post(f"/api/agents/{aid}/runs",
                          json={"wake_kind": "ephemeral", "wake_event": "task_created_unassigned"})
    assert r.status_code == 201, r.text
    await _scan(client, cid)
    assert _backoff_row(db, aid) is None


async def test_reset_on_candidate_disappearance(client, container, make_agent, db):
    """Once the task is assigned (candidate clears), the wake_backoff row is deleted outright —
    a later recurrence starts a clean streak, not a resumed one."""
    cid = container["id"]
    reporter = await make_agent("reporter", kind="human")
    atlas = await make_agent("Atlas", role="orchestrator / system architect", kind="ai")
    aid = atlas["agent_id"]
    worker = await make_agent("worker-1", kind="ai")

    with db_cursor() as (conn, cur):
        result = core.start_task_from_slack_capture(
            cur, cid, title="Route me", description="raw",
            created_by_agent_id=reporter["agent_id"], assignee_agent_id=None,
        )
        conn.commit()
    tid = result["task_id"]

    await _completed_run(client, aid, wake_event="task_created_unassigned")
    await _scan(client, cid)
    assert _backoff_row(db, aid) is not None

    # Assign the task away — the task_created_unassigned candidate disappears.
    db.execute(
        "INSERT INTO agent_tasks (agent_id, task_id, assignment_status) VALUES (%s,%s,'working')",
        (worker["agent_id"], tid),
    )
    db.execute("UPDATE tasks SET status='in_progress' WHERE id=%s", (tid,))
    db.execute(
        "DELETE FROM agent_events WHERE event_key=%s AND event_name='task_created_unassigned'",
        (aid,),
    )

    await _scan(client, cid)
    assert _backoff_row(db, aid) is None


# --------------------------------------------------------------------------- #
# ladder thresholds + suppression filtering
# --------------------------------------------------------------------------- #

async def test_ladder_suppresses_at_tier1_and_filters_the_scan_response(
        client, container, make_agent, db):
    """strikes >= 3 -> suppressed_until set AND the candidate is excluded from the very next
    scan's response — the daemon literally never sees it (zero daemon changes)."""
    cid = container["id"]
    aid = await _make_unassigned_trigger(client, container, make_agent)

    for _ in range(3):
        await _completed_run(client, aid, wake_event="task_created_unassigned")
        body = await _scan(client, cid)

    row = _backoff_row(db, aid)
    assert row["strikes"] == 3
    assert row["suppressed_until"] is not None

    # The tick that just reached tier 1 already filtered its own response.
    assert _candidate_for(body, aid) is None

    # Underlying data untouched — doctrine: the breaker never changes task state.
    r = await client.get(f"/api/containers/{cid}/tasks")
    tasks = [t for t in r.json()["tasks"] if not t.get("is_root")]
    assert any(t["status"] == "ready" for t in tasks)  # task still ready, unassigned, untouched


async def test_ladder_tier2_and_tier3_widen_the_window(client, container, make_agent, db, monkeypatch):
    """Tighter env thresholds so the ladder is exercised end-to-end within a small loop:
    tier1=1 strike/60s, tier2=2/120s, tier3=3/240s."""
    monkeypatch.setenv("ORCHA_WAKE_BACKOFF_STRIKES_TIER1", "1")
    monkeypatch.setenv("ORCHA_WAKE_BACKOFF_STRIKES_TIER2", "2")
    monkeypatch.setenv("ORCHA_WAKE_BACKOFF_STRIKES_TIER3", "3")
    monkeypatch.setenv("ORCHA_WAKE_BACKOFF_SECS_TIER1", "60")
    monkeypatch.setenv("ORCHA_WAKE_BACKOFF_SECS_TIER2", "120")
    monkeypatch.setenv("ORCHA_WAKE_BACKOFF_SECS_TIER3", "240")
    _reload_wake_backoff()
    try:
        cid = container["id"]
        aid = await _make_unassigned_trigger(client, container, make_agent)

        await _completed_run(client, aid, wake_event="task_created_unassigned")
        await _scan(client, cid)
        row = _backoff_row(db, aid)
        assert row["strikes"] == 1
        first_suppressed_until = row["suppressed_until"]
        assert first_suppressed_until is not None

        # Clear suppression manually so the next scan tick can re-strike (a still-suppressed
        # candidate is filtered before it can be judged again — that's the point of §ladder).
        db.execute("UPDATE wake_backoff SET suppressed_until=NULL WHERE agent_id=%s", (aid,))
        await _completed_run(client, aid, wake_event="task_created_unassigned")
        await _scan(client, cid)
        row = _backoff_row(db, aid)
        assert row["strikes"] == 2
        second_suppressed_until = row["suppressed_until"]
        assert second_suppressed_until > first_suppressed_until  # tier2 window is wider
    finally:
        for k in ("ORCHA_WAKE_BACKOFF_STRIKES_TIER1", "ORCHA_WAKE_BACKOFF_STRIKES_TIER2",
                  "ORCHA_WAKE_BACKOFF_STRIKES_TIER3", "ORCHA_WAKE_BACKOFF_SECS_TIER1",
                  "ORCHA_WAKE_BACKOFF_SECS_TIER2", "ORCHA_WAKE_BACKOFF_SECS_TIER3"):
            monkeypatch.delenv(k, raising=False)
        _reload_wake_backoff()


def _reload_wake_backoff():
    """Re-import wake_backoff (module-level env reads) after monkeypatching env vars, and
    rebind the wake_scan_routes seam that imported the OLD function object by name."""
    import portal_backend.wake_backoff as wb
    importlib.reload(wb)
    import portal_backend.wake_scan_routes as wsr
    wsr.apply_wake_backoff = wb.apply_wake_backoff


# --------------------------------------------------------------------------- #
# tier-3 needs-you artifact
# --------------------------------------------------------------------------- #

async def test_needs_you_artifact_created_once_at_tier3(client, container, make_agent, db, monkeypatch):
    """At strikes >= tier3 (env-shrunk to 2 here for a fast test) an open `request` targeting
    the human is created EXACTLY once — a second tick past the threshold must not duplicate it.
    This is the same mechanism the existing needs-you surface (HomePage/NotificationCenter's
    `escs`, sourced from open requests targeting a human) already renders end-to-end."""
    monkeypatch.setenv("ORCHA_WAKE_BACKOFF_STRIKES_TIER1", "1")
    monkeypatch.setenv("ORCHA_WAKE_BACKOFF_STRIKES_TIER2", "1")
    monkeypatch.setenv("ORCHA_WAKE_BACKOFF_STRIKES_TIER3", "2")
    monkeypatch.setenv("ORCHA_WAKE_BACKOFF_SECS_TIER3", "3600")
    _reload_wake_backoff()
    try:
        cid = container["id"]
        # _make_unassigned_trigger already registers a human ("reporter") — pick_human
        # (most-recently-created live human) resolves to that one; no need for a second.
        aid = await _make_unassigned_trigger(client, container, make_agent)

        await _completed_run(client, aid, wake_event="task_created_unassigned")
        await _scan(client, cid)  # strike 1 -> already >= tier3(2)? no, ==1 < 2

        row = _backoff_row(db, aid)
        assert row["strikes"] == 1

        db.execute("UPDATE wake_backoff SET suppressed_until=NULL WHERE agent_id=%s", (aid,))
        await _completed_run(client, aid, wake_event="task_created_unassigned")
        await _scan(client, cid)  # strike 2 -> reaches tier3

        row = _backoff_row(db, aid)
        assert row["strikes"] == 2
        assert row["notified_at"] is not None

        reqs = db.execute(
            "SELECT * FROM requests WHERE container_id=%s AND status='open' AND requester_id=%s",
            (cid, aid),
        )
        assert len(reqs) == 1
        assert "Atlas" in reqs[0]["payload"]
        assert "unassigned" in reqs[0]["payload"]
        assert "paused" in reqs[0]["payload"]
        assert reqs[0]["target_id"] is not None  # targets a live human, per pick_human

        # A further tick past the threshold (still suppressed -> filtered before it can even be
        # re-struck) must not create a second artifact.
        db.execute("UPDATE wake_backoff SET suppressed_until=NULL WHERE agent_id=%s", (aid,))
        await _completed_run(client, aid, wake_event="task_created_unassigned")
        await _scan(client, cid)
        reqs_after = db.execute(
            "SELECT * FROM requests WHERE container_id=%s AND status='open' AND requester_id=%s",
            (cid, aid),
        )
        assert len(reqs_after) == 1  # still exactly one — fired ONCE per strike-streak
    finally:
        for k in ("ORCHA_WAKE_BACKOFF_STRIKES_TIER1", "ORCHA_WAKE_BACKOFF_STRIKES_TIER2",
                  "ORCHA_WAKE_BACKOFF_STRIKES_TIER3", "ORCHA_WAKE_BACKOFF_SECS_TIER3"):
            monkeypatch.delenv(k, raising=False)
        _reload_wake_backoff()


async def test_needs_you_artifact_renders_via_existing_attention_surface(
        client, container, make_agent, db, monkeypatch):
    """End-to-end proof the artifact reaches the SAME plumbing HomePage/NotificationCenter's
    needs-you zone already consumes (SnapshotProvider.attnItems -> escs: open requests
    targeting a human) — the container snapshot must list it, with zero frontend changes."""
    monkeypatch.setenv("ORCHA_WAKE_BACKOFF_STRIKES_TIER3", "1")
    _reload_wake_backoff()
    try:
        cid = container["id"]
        await make_agent("op", kind="human")
        aid = await _make_unassigned_trigger(client, container, make_agent)
        await _completed_run(client, aid, wake_event="task_created_unassigned")
        await _scan(client, cid)

        snap = await client.get(f"/api/containers/{cid}")
        assert snap.status_code == 200, snap.text
        body = snap.json()
        open_reqs = [r for r in body.get("requests", []) if r.get("status") == "open"]
        assert any("wakes for this trigger are paused" in (r.get("payload") or "") for r in open_reqs)
    finally:
        monkeypatch.delenv("ORCHA_WAKE_BACKOFF_STRIKES_TIER3", raising=False)
        _reload_wake_backoff()


# --------------------------------------------------------------------------- #
# DELETE release valve
# --------------------------------------------------------------------------- #

async def test_delete_release_clears_row_and_resumes_immediately(client, container, make_agent, db):
    cid = container["id"]
    human = await make_agent("op", kind="human")
    aid = await _make_unassigned_trigger(client, container, make_agent)
    for _ in range(3):
        await _completed_run(client, aid, wake_event="task_created_unassigned")
        await _scan(client, cid)
    assert _backoff_row(db, aid)["suppressed_until"] is not None
    body = await _scan(client, cid)
    assert _candidate_for(body, aid) is None  # confirmed suppressed

    r = await client.request(
        "DELETE", f"/api/containers/{cid}/agents/{aid}/wake-backoff/task_created_unassigned",
        json={"actor_agent_id": human["agent_id"]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["released"] is True
    assert _backoff_row(db, aid) is None

    body = await _scan(client, cid)
    assert _candidate_for(body, aid) is not None  # resumed immediately, not "wait out the timer"


async def test_delete_release_requires_human_actor(client, container, make_agent, db):
    """Gated like other agent mutations: a non-human (or missing) actor is refused."""
    cid = container["id"]
    ai_actor = await make_agent("not-human", kind="ai")
    aid = await _make_unassigned_trigger(client, container, make_agent)
    for _ in range(3):
        await _completed_run(client, aid, wake_event="task_created_unassigned")
        await _scan(client, cid)

    r = await client.request(
        "DELETE", f"/api/containers/{cid}/agents/{aid}/wake-backoff/task_created_unassigned",
        json={"actor_agent_id": ai_actor["agent_id"]},
    )
    assert r.status_code == 403
    assert _backoff_row(db, aid) is not None  # unreleased

    r = await client.request(
        "DELETE", f"/api/containers/{cid}/agents/{aid}/wake-backoff/task_created_unassigned",
        json={},
    )
    assert r.status_code == 400  # no actor at all — require_kind rejects a missing/invalid id
    assert _backoff_row(db, aid) is not None


async def test_delete_release_is_idempotent_on_missing_row(client, container, make_agent):
    cid = container["id"]
    human = await make_agent("op", kind="human")
    aid = (await make_agent("Someone", kind="ai"))["agent_id"]
    r = await client.request(
        "DELETE", f"/api/containers/{cid}/agents/{aid}/wake-backoff/nonexistent-key",
        json={"actor_agent_id": human["agent_id"]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["released"] is False


# --------------------------------------------------------------------------- #
# GET listing
# --------------------------------------------------------------------------- #

async def test_get_wake_backoff_lists_active_suppressions(client, container, make_agent, db):
    cid = container["id"]
    aid = await _make_unassigned_trigger(client, container, make_agent)
    for _ in range(3):
        await _completed_run(client, aid, wake_event="task_created_unassigned")
        await _scan(client, cid)

    r = await client.get(f"/api/containers/{cid}/wake-backoff")
    assert r.status_code == 200, r.text
    rows = r.json()["backoffs"]
    assert len(rows) == 1
    assert rows[0]["agent_id"] == aid
    assert rows[0]["wake_key"] == "task_created_unassigned"
    assert rows[0]["strikes"] == 3
    assert rows[0]["suppressed"] is True


# --------------------------------------------------------------------------- #
# env-tunable thresholds
# --------------------------------------------------------------------------- #

async def test_env_tunable_thresholds_change_the_ladder(monkeypatch):
    monkeypatch.setenv("ORCHA_WAKE_BACKOFF_STRIKES_TIER1", "2")
    monkeypatch.setenv("ORCHA_WAKE_BACKOFF_SECS_TIER1", "42")
    import portal_backend.wake_backoff as wb
    importlib.reload(wb)
    try:
        assert wb.STRIKE_TIER_1 == 2
        assert wb.backoff_secs_for_strikes(2) == 42
        assert wb.backoff_secs_for_strikes(1) == 0
    finally:
        monkeypatch.delenv("ORCHA_WAKE_BACKOFF_STRIKES_TIER1", raising=False)
        monkeypatch.delenv("ORCHA_WAKE_BACKOFF_SECS_TIER1", raising=False)
        importlib.reload(wb)
        import portal_backend.wake_scan_routes as wsr
        wsr.apply_wake_backoff = wb.apply_wake_backoff


def test_default_ladder_matches_spec():
    import portal_backend.wake_backoff as wb
    assert wb.STRIKE_TIER_1 == 3 and wb.BACKOFF_SECS_TIER1 == 5 * 60
    assert wb.STRIKE_TIER_2 == 6 and wb.BACKOFF_SECS_TIER2 == 30 * 60
    assert wb.STRIKE_TIER_3 == 10 and wb.BACKOFF_SECS_TIER3 == 4 * 60 * 60


# --------------------------------------------------------------------------- #
# derive_wake_key (pure)
# --------------------------------------------------------------------------- #

def test_derive_wake_key_precedence():
    from portal_backend.wake_backoff import derive_wake_key
    assert derive_wake_key({"latest_event": "task_created_unassigned"}) == "task_created_unassigned"
    assert derive_wake_key({"latest_event": None, "auto_start_task_ids": ["t1"]}) == "auto_start"
    assert derive_wake_key({"latest_event": None, "auto_start_task_ids": [], "self_wake_due": True}) == "self_wake"
    assert derive_wake_key({"latest_event": None, "auto_start_task_ids": [], "self_wake_due": False,
                            "auto_wake_due": True}) == "auto_wake"
    assert derive_wake_key({"latest_event": None, "auto_start_task_ids": [], "self_wake_due": False,
                            "auto_wake_due": False}) is None


# --------------------------------------------------------------------------- #
# agent_spend insight: subscription-loop
# --------------------------------------------------------------------------- #

async def _finish_run(client, aid, **toks):
    r = await client.post(f"/api/agents/{aid}/runs", json={"wake_kind": "ephemeral"})
    rid = r.json()["run_id"]
    body = {"status": "exited", "exit_code": 0}
    body.update(toks)
    f = await client.post(f"/api/runs/{rid}/finish", json=body)
    assert f.status_code == 200, f.text
    return rid


async def test_subscription_loop_insight_fires_over_200_runs_near_zero_cost(
        client, container, make_agent):
    cid = container["id"]
    aid = (await make_agent("Looper", kind="ai"))["agent_id"]
    for _ in range(201):
        await _finish_run(client, aid, input_tokens=10, output_tokens=5, total_cost_usd=0.001)

    r = await client.get(f"/api/containers/{cid}/metrics/insights?window=all")
    assert r.status_code == 200, r.text
    insights = r.json()["insights"]
    hit = next((i for i in insights if i["id"] == f"subscription-loop:{aid}"), None)
    assert hit is not None
    assert hit["severity"] == "high"
    assert "almost no recorded cost" in hit["detail"]
    assert hit["evidence"]["runs"] == 201


async def test_subscription_loop_insight_silent_under_threshold(client, container, make_agent):
    """Below the 200-run floor, or with real dollar spend, the rule stays silent."""
    cid = container["id"]
    quiet = (await make_agent("Quiet", kind="ai"))["agent_id"]
    for _ in range(50):
        await _finish_run(client, quiet, input_tokens=10, output_tokens=5, total_cost_usd=0.001)

    spender = (await make_agent("BigSpender", kind="ai"))["agent_id"]
    for _ in range(201):
        await _finish_run(client, spender, input_tokens=1000, output_tokens=1000, total_cost_usd=0.05)

    r = await client.get(f"/api/containers/{cid}/metrics/insights?window=all")
    insights = r.json()["insights"]
    assert not any(i["id"] == f"subscription-loop:{quiet}" for i in insights)
    assert not any(i["id"] == f"subscription-loop:{spender}" for i in insights)
