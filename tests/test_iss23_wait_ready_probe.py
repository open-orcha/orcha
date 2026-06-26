"""#23 [P0] — GET /api/agents/{aid}/wait must check DB LEVEL state before blocking.

`_wait_for_event` is EDGE-triggered (returns only agent_events rows with ts > since_ts). So a
task that became assigned+ready while the agent wasn't subscribed — its task_ready/task_assigned
event already <= since_ts, or never delivered on this agent's key (a container-only signal) — is
invisible to the long poll. Meanwhile the notifier wake-scan that WOULD auto-start it is
suppressed because the very act of /wait-ing refreshes last_heartbeat_at (the agent looks
non-idle). Net: an idle deadlock on work that already exists.

The fix makes /wait LEVEL-triggered too: before blocking (and again on timeout) it probes for an
assigned-ready task using the SAME query as wake-scan's auto_start_task_ids, and if one exists
returns a synthetic `task_ready` immediately. Real events keep strict precedence; the synthetic
echoes the caller's cursor (ts = since_ts) so it can never mask a real event, and it self-clears
the moment the listener claims via /orcha-next (status flips to in_progress).
"""
import asyncio

import pytest

pytestmark = pytest.mark.asyncio


async def _assign_ready(db, aid, tid, status="assigned"):
    """Craft the wake-scan auto-start target directly: an agent_tasks row for `aid` against a
    task left at status='ready'. This is the dep-cleared / re-readied assigned state (create_task
    with an assignee lands in_progress, so we set the level state explicitly, as the iss50 tests do)."""
    db.execute("UPDATE tasks SET status='ready' WHERE id=%s", (tid,))
    db.execute(
        """INSERT INTO agent_tasks (agent_id, task_id, assignment_status)
           VALUES (%s, %s, %s)
           ON CONFLICT (agent_id, task_id) DO UPDATE SET assignment_status=EXCLUDED.assignment_status""",
        (aid, tid, status),
    )


async def test_assigned_ready_no_events_returns_synthetic_immediately(
        client, container, make_agent, make_task, db):
    """Tooth 1: an assigned+ready task with NO pending events surfaces as a synthetic task_ready
    on entry — WITHOUT blocking to timeout. (timeout=30 but the call returns at once; if the entry
    probe were absent it would block the full 30s and return 'timeout'.)"""
    a = await make_agent("A")
    aid = a["agent_id"]
    t = await make_task("ready work", "done when done")
    await _assign_ready(db, aid, t["id"])

    r = await client.get(f"/api/agents/{aid}/wait", params={"since_ts": 0, "timeout": 30})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["event"] == "task_ready"
    assert body["task_id"] == t["id"]
    assert body["assigned"] is True
    assert body["ts"] == 0          # echoes the caller's cursor (since_ts), never advances it


async def test_real_event_wins_over_ready_probe(
        client, container, make_agent, make_task, make_request, db):
    """Tooth 2: when a REAL agent_events row > since_ts is pending, it is delivered unchanged — the
    ready-probe never pre-empts a real event (strict precedence preserved)."""
    a = await make_agent("A")
    b = await make_agent("B")
    bid = b["agent_id"]
    t = await make_task("ready work", "dod")
    await _assign_ready(db, bid, t["id"])              # B also has an assigned-ready task
    await make_request(a["agent_id"], "need input", target_alias="B")  # ...and a real event

    r = await client.get(f"/api/agents/{bid}/wait", params={"since_ts": 0, "timeout": 5})
    body = r.json()
    assert body["event"] == "request_created"         # the real event, not the synthetic
    assert body["event"] != "task_ready"


async def test_no_work_returns_timeout(client, container, make_agent):
    """Tooth 3: no ready task and no events → a normal 'timeout' (no false synthetic)."""
    a = await make_agent("A")
    r = await client.get(f"/api/agents/{a['agent_id']}/wait", params={"since_ts": 0, "timeout": 1})
    assert r.json()["event"] == "timeout"


async def test_in_progress_task_yields_no_synthetic(
        client, container, make_agent, make_task, db):
    """Tooth 4 (self-clearing / no-spin): once the assigned-ready task is CLAIMED via /orcha-next
    its status flips to in_progress, so the next probe finds nothing ready and /wait blocks/timeouts
    normally — the synthetic cannot spin a tight loop."""
    a = await make_agent("A")
    aid = a["agent_id"]
    t = await make_task("ready work", "dod")
    await _assign_ready(db, aid, t["id"])

    claim = await client.post(f"/api/agents/{aid}/next")
    assert claim.status_code == 200 and claim.json()["task"]["id"] == t["id"]   # claimed → in_progress

    r = await client.get(f"/api/agents/{aid}/wait", params={"since_ts": 0, "timeout": 1})
    assert r.json()["event"] == "timeout"             # self-cleared; no synthetic re-fires


async def test_root_ready_task_excluded(client, container, make_agent, db):
    """Tooth 5: the container ROOT task is ready by construction but is_root=true; assigning it must
    NOT make /wait emit a synthetic (only the human verifies the root)."""
    a = await make_agent("A")
    aid = a["agent_id"]
    await _assign_ready(db, aid, container["root_task_id"])   # root is already status='ready'

    r = await client.get(f"/api/agents/{aid}/wait", params={"since_ts": 0, "timeout": 1})
    assert r.json()["event"] == "timeout"


async def test_ready_task_assigned_to_other_agent_not_returned(
        client, container, make_agent, make_task, db):
    """Tooth 6: an assigned-ready task belonging to a DIFFERENT agent is invisible to this agent's
    /wait (the JOIN is on at.agent_id) — no cross-agent leak / stolen auto-start."""
    a = await make_agent("A")
    b = await make_agent("B")
    t = await make_task("B's work", "dod")
    await _assign_ready(db, b["agent_id"], t["id"])          # assigned to B

    r = await client.get(f"/api/agents/{a['agent_id']}/wait", params={"since_ts": 0, "timeout": 1})
    assert r.json()["event"] == "timeout"                    # A sees nothing


async def test_timeout_recheck_catches_task_readied_during_block(
        client, container, make_agent, make_task, db):
    """Tooth 7: a task assigned+readied DURING the block with NO agent-key event (e.g. a
    container-only task_ready that _wait_for_event can't see) is caught by the timeout re-check, so
    the listener gets the work THIS poll instead of a cycle later."""
    a = await make_agent("A")
    aid = a["agent_id"]
    t = await make_task("late work", "dod")                  # exists but NOT yet ready/assigned

    waiter = asyncio.create_task(
        client.get(f"/api/agents/{aid}/wait", params={"since_ts": 0, "timeout": 2}))
    await asyncio.sleep(0.4)                                 # entry probe already ran (saw nothing)
    await _assign_ready(db, aid, t["id"])                    # readied mid-block, no agent-key event

    r = await waiter
    body = r.json()
    assert body["event"] == "task_ready"                     # re-check surfaced it on timeout
    assert body["task_id"] == t["id"]


async def test_paused_container_suppresses_synthetic(
        client, container, make_agent, make_task, db):
    """Tooth 8 (Gate PR#274): on a PAUSED container the synthetic probe must NOT fire — /orcha-next
    would 409 (_require_container_active), so surfacing task_ready is a false claimable signal that a
    listener loop would re-emit → spin. Entry path: assigned-ready task present, container paused →
    'timeout', not 'task_ready'."""
    a = await make_agent("A")
    aid = a["agent_id"]
    t = await make_task("ready work", "dod")
    await _assign_ready(db, aid, t["id"])
    db.execute("UPDATE containers SET status='paused' WHERE id=%s", (container["id"],))

    r = await client.get(f"/api/agents/{aid}/wait", params={"since_ts": 0, "timeout": 1})
    assert r.json()["event"] == "timeout"                    # gated: no synthetic on a paused container

    # and once resumed, the same assigned-ready task surfaces again (gate is transient, not sticky)
    db.execute("UPDATE containers SET status='active' WHERE id=%s", (container["id"],))
    r2 = await client.get(f"/api/agents/{aid}/wait", params={"since_ts": 0, "timeout": 30})
    assert r2.json()["event"] == "task_ready"
    assert r2.json()["task_id"] == t["id"]


async def test_exhausted_budget_does_not_suppress_synthetic(
        client, container, make_agent, make_task, db):
    """GH#39: the turn-budget gate is removed, so an exhausted budget no longer suppresses the
    synthetic — the assigned-ready task still surfaces and /orcha-next claims it (200), not 429."""
    a = await make_agent("A")
    aid = a["agent_id"]
    t = await make_task("ready work", "dod")
    await _assign_ready(db, aid, t["id"])
    db.execute("UPDATE agents SET turns_used = turn_budget WHERE id=%s", (aid,))

    r = await client.get(f"/api/agents/{aid}/wait", params={"since_ts": 0, "timeout": 30})
    body = r.json()
    assert body["event"] == "task_ready"                     # budget no longer gates the synthetic
    assert body["task_id"] == t["id"]

    # and /orcha-next genuinely claims it now (no 429)
    claim = await client.post(f"/api/agents/{aid}/next")
    assert claim.status_code == 200, claim.text


async def test_retired_agent_suppresses_synthetic(
        client, container, make_agent, make_task, db):
    """Tooth 10 (Gate/Helm PR#274): a RETIRED agent (terminated_at set) must NOT get a synthetic —
    /orcha-next would 409 (_reject_if_retired). Surfacing task_ready is a false claimable signal."""
    a = await make_agent("A")
    aid = a["agent_id"]
    t = await make_task("ready work", "dod")
    await _assign_ready(db, aid, t["id"])
    db.execute("UPDATE agents SET terminated_at = now() WHERE id=%s", (aid,))

    r = await client.get(f"/api/agents/{aid}/wait", params={"since_ts": 0, "timeout": 1})
    assert r.json()["event"] == "timeout"                    # gated: retired → no synthetic

    # and /orcha-next genuinely refuses (the mirrored condition)
    claim = await client.post(f"/api/agents/{aid}/next")
    assert claim.status_code == 409


async def test_happy_path_active_in_budget_still_fires(
        client, container, make_agent, make_task, db):
    """Tooth 11 (Helm PR#274): the gate must NOT over-suppress — an ACTIVE container + in-budget +
    not-retired agent with an assigned-ready task still gets the synthetic task_ready. Guards
    against a too-broad claim-blocked predicate silently killing the whole feature."""
    a = await make_agent("A")
    aid = a["agent_id"]
    t = await make_task("ready work", "dod")
    await _assign_ready(db, aid, t["id"])

    r = await client.get(f"/api/agents/{aid}/wait", params={"since_ts": 0, "timeout": 30})
    body = r.json()
    assert body["event"] == "task_ready"
    assert body["task_id"] == t["id"]
