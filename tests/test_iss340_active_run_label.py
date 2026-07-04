"""#340 — surface a LIVE worker run as `active_run` so a conversation-turn /
inbox-drain wake (worker_runs.task_id NULL) stops reading IDLE in the portal.

Regression: the snapshot's `current_task` (GET /api/containers/{cid}) only
surfaces an agent_tasks row with assignment_status='working'. Agents now run a
lot as conversation-turn / inbox-drain worker_runs (commits 6c40247/5995982)
that carry task_id=NULL and create NO 'working' row — so a genuinely-live agent
read idle (no current-activity label) even mid-run.

Scope sharpened (Kedar live-test 2026-06-15): the label must be DRIVEN by the
live run, NOT the persistent task-claim. current_task is cleared only on
/orcha-done, so it diverges from live reality two ways — a task-less run reads
idle (above) AND a stale 'working' claim (the wrong-agent auto-claim leftover)
shows that task while the live run is actually a checkpoint/request. The frontend
drives the Activity label off active_run (task title when it's a task, else a
plain-language wake-event label) and falls back to current_task ONLY when no run
is live.

Fix: add an additive `active_run` field to each snapshot agent row = the newest
worker_runs row with status='running' for that agent — GATED on a LIVE lease
(the SAME predicate as the derived `status`/`embodiment`, ISS-16). The gate is
the crux: a STALE 'running' orphan whose lease already expired must NOT show a
perpetual-busy label — it falls back to idle, consistent with the recomputed
status. When the run is a task, task_id + task_title are carried so the card
labels it directly. No migration, no response_model (untyped dict → no OpenAPI
drift).

These teeth pin: the headline NULL-task live-run case, the task_id+task_title
carry for a task run, the stale-claim divergence (live run distinct from the
stale claim, so the frontend can prefer it), the stale-orphan suppression
nuance, and the truly-idle baseline.
"""
import pytest


async def _snapshot_agent(client, cid, aid):
    """Fetch one agent row out of the container snapshot (GET /api/containers/{cid})."""
    r = await client.get(f"/api/containers/{cid}")
    assert r.status_code == 200, r.text
    rows = [a for a in r.json()["agents"] if a["id"] == aid]
    assert len(rows) == 1, f"agent {aid} not in snapshot"
    return rows[0]


@pytest.mark.asyncio
async def test_active_run_surfaces_live_conversation_drain_no_task(
        client, make_agent, container, db):
    """THE regression: a genuinely-live agent (live lease) whose only run is a
    conversation/drain wake with task_id NULL owns NO 'working' task row, so
    current_task is None. `active_run` must surface the live run anyway, carrying
    the wake_event so the card can label the activity instead of reading idle."""
    cid = container["id"]
    a = await make_agent("Drainer")
    aid = a["agent_id"]
    # Live single-flight lease (same predicate the status/embodiment gate uses).
    await client.post(f"/api/agents/{aid}/wake-claim",
                      json={"lease_ttl": 300, "lease_kind": "resident"})
    # A running worker run with NO task — an inbox-drain / conversation-turn wake.
    db.execute(
        "INSERT INTO worker_runs (agent_id, task_id, status, wake_kind, wake_event, lane) "
        "VALUES (%s, NULL, 'running', 'resident', 'request_answered', 'conversation')",
        (aid,),
    )

    row = await _snapshot_agent(client, cid, aid)
    assert row["current_task"] is None, "a task-less drain wake creates no 'working' row"
    assert row["active_run"] is not None, "the live run must surface as active_run (the #340 fix)"
    assert row["active_run"]["wake_event"] == "request_answered"
    assert row["active_run"]["task_id"] is None
    # And it agrees with the embodiment gate it shares (lease is live).
    assert row["embodiment"] == "resident"


@pytest.mark.asyncio
async def test_active_run_carries_task_id_and_title_for_task_run(
        client, make_agent, make_task, container, db):
    """When the live run IS a task, active_run carries task_id AND task_title so the
    card can label the worked task directly (no dependence on current_task matching)."""
    cid = container["id"]
    a = await make_agent("Worker")
    aid = a["agent_id"]
    t = await make_task("do the thing", "done", assignee_alias="Worker")
    tid = t["id"]
    await client.post(f"/api/agents/{aid}/wake-claim",
                      json={"lease_ttl": 300, "lease_kind": "ephemeral"})
    db.execute(
        "INSERT INTO worker_runs (agent_id, task_id, status, wake_kind, wake_event) "
        "VALUES (%s, %s, 'running', 'ephemeral', 'task_assigned')",
        (aid, tid),
    )

    row = await _snapshot_agent(client, cid, aid)
    assert row["current_task"] is not None and row["current_task"]["task_id"] == tid
    assert row["active_run"] is not None
    assert row["active_run"]["task_id"] == tid, "active_run carries the task id for the run"
    assert row["active_run"]["task_title"] == "do the thing", \
        "active_run carries the worked task's title so the card labels it directly"


@pytest.mark.asyncio
async def test_active_run_diverges_from_stale_working_claim(
        client, make_agent, make_task, container, db):
    """THE sharpened bug (Kedar live-test): an agent carrying a STALE 'working' claim
    (the wrong-agent auto-claim leftover) while its LIVE run is actually a conversation /
    checkpoint. Both snapshot fields must be present and DISTINCT so the frontend can drive
    the Activity label off the live run (current_task is the fallback ONLY when no run is
    live) — i.e. the card must NOT be forced to show the stale task. This is the data
    contract behind the precedence flip; the render itself prefers active_run."""
    cid = container["id"]
    a = await make_agent("Gatey")
    aid = a["agent_id"]
    # A persistent 'working' claim on some task (the stale leftover).
    t = await make_task("stale claimed task", "done", assignee_alias="Gatey")
    stale_tid = t["id"]
    # But the LIVE run is a task-less checkpoint — the real current activity.
    await client.post(f"/api/agents/{aid}/wake-claim",
                      json={"lease_ttl": 300, "lease_kind": "resident"})
    db.execute(
        "INSERT INTO worker_runs (agent_id, task_id, status, wake_kind, wake_event, lane) "
        "VALUES (%s, NULL, 'running', 'resident', 'checkpoint_respawn', 'conversation')",
        (aid,),
    )

    row = await _snapshot_agent(client, cid, aid)
    # The stale claim is still present (clearing it is NOT this fix's scope)...
    assert row["current_task"] is not None and row["current_task"]["task_id"] == stale_tid
    # ...but the live run is ALSO surfaced and is a DIFFERENT, task-less activity, so the
    # frontend can prefer it over the stale claim.
    assert row["active_run"] is not None
    assert row["active_run"]["task_id"] is None
    assert row["active_run"]["wake_event"] == "checkpoint_respawn"


@pytest.mark.asyncio
async def test_active_run_follows_work_lane_when_both_lanes_live(
        client, make_agent, make_task, container, db):
    """GH #91/#90 PR review: when both lane leases are live, `embodiment` reports
    the work lane. `active_run` must select the work-lane run too, even if a newer
    conversation run exists, so the portal does not mix work status with resident
    activity details."""
    cid = container["id"]
    a = await make_agent("Mixed")
    aid = a["agent_id"]
    t = await make_task("active work", "done", assignee_alias="Mixed")
    tid = t["id"]

    await client.post(f"/api/agents/{aid}/wake-claim",
                      json={"lease_ttl": 300, "lease_kind": "resident"})
    await client.post(f"/api/agents/{aid}/wake-claim",
                      json={"lease_ttl": 300, "lease_kind": "ephemeral"})
    db.execute(
        """INSERT INTO worker_runs
             (agent_id, task_id, status, wake_kind, wake_event, lane, started_at)
           VALUES
             (%s, %s, 'running', 'ephemeral', 'task_assigned', 'work',
              now() - interval '1 minute')""",
        (aid, tid),
    )
    db.execute(
        """INSERT INTO worker_runs
             (agent_id, task_id, status, wake_kind, wake_event, lane, started_at)
           VALUES
             (%s, NULL, 'running', 'resident', 'conversation_turn', 'conversation',
              now())""",
        (aid,),
    )

    row = await _snapshot_agent(client, cid, aid)
    assert row["embodiment"] == "ephemeral"
    assert row["active_run"] is not None
    assert row["active_run"]["wake_event"] == "task_assigned"
    assert row["active_run"]["task_id"] == tid
    assert row["active_run"]["task_title"] == "active work"


@pytest.mark.asyncio
async def test_active_run_suppressed_for_stale_orphan_run(
        client, make_agent, container, db):
    """THE nuance: a 'running' worker_run whose lease has EXPIRED is a stale orphan
    (the process died, the reaper hasn't reconciled it). It must NOT show a
    perpetual-busy label — active_run reads None, mirroring the idle status. A
    naive 'any running run' implementation would wrongly mark it busy forever."""
    cid = container["id"]
    a = await make_agent("Zombie")
    aid = a["agent_id"]
    # Claim a lease, then expire it (the worker exited; lease lapsed, run not yet reaped).
    await client.post(f"/api/agents/{aid}/wake-claim",
                      json={"lease_ttl": 300, "lease_kind": "ephemeral"})
    db.execute(
        "UPDATE agent_wake_state SET wake_lease_until = now() - interval '1 hour' WHERE agent_id=%s",
        (aid,),
    )
    db.execute(
        "INSERT INTO worker_runs (agent_id, task_id, status, wake_kind, wake_event) "
        "VALUES (%s, NULL, 'running', 'ephemeral', 'conversation_turn')",
        (aid,),
    )

    row = await _snapshot_agent(client, cid, aid)
    assert row["active_run"] is None, "expired lease → stale orphan run is suppressed (not busy)"
    assert row["status"] == "idle", "and the derived status agrees it is idle"


@pytest.mark.asyncio
async def test_active_run_none_when_truly_idle(client, make_agent, container):
    """A genuinely idle agent — no running run, no live lease — has active_run None
    so the portal still renders the em-dash. Baseline that idle stays idle."""
    cid = container["id"]
    a = await make_agent("Resting")
    row = await _snapshot_agent(client, cid, a["agent_id"])
    assert row["active_run"] is None
    assert row["current_task"] is None
