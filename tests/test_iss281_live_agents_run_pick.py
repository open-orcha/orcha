"""#281: GET /api/containers picks the right running worker_run per agent, on every SQLite.

`_live_agents_by_container` chooses which 'running' worker_run to show for an agent: the run
on the lane its lease holds (work lease -> work run; only a conversation lease ->
conversation run), else the newest. The ordering used to read the OUTER `ws`
(agent_wake_state) alias inside the scalar subquery's ORDER BY, which SQLite before 3.46
cannot resolve ("no such column: ws.wake_lease_until") -- uv's Python 3.12 and GitHub's
Ubuntu runners ship 3.45, so fresh native projects 500'd on the project list.

Each case makes the run that must be picked the OLDER one, so a pick by recency alone (a
regression that drops the lane preference) fails. The picked run is read back through its
task title. Runs on both backends (ORCHA_TEST_BACKEND=sqlite|postgres).
"""
import pytest
from conftest import ts_ago, ts_from_now


def _row(resp, cid):
    assert resp.status_code == 200, resp.text
    return next(c for c in resp.json()["containers"] if c["id"] == cid)


def _lease(db, agent_id, *, work=None, conv=None):
    """Upsert agent_wake_state with the given lease literals (None -> NULL)."""
    db.execute(
        "INSERT INTO agent_wake_state (agent_id, wake_lease_until, conv_lease_until, lease_kind) "
        f"VALUES (%s, {work or 'NULL'}, {conv or 'NULL'}, 'ephemeral') "
        "ON CONFLICT (agent_id) DO UPDATE SET wake_lease_until=EXCLUDED.wake_lease_until, "
        "conv_lease_until=EXCLUDED.conv_lease_until",
        (agent_id,),
    )


def _run(db, agent_id, task_id, lane, started):
    db.execute(
        "INSERT INTO worker_runs (agent_id, task_id, status, lane, started_at) "
        f"VALUES (%s, %s, 'running', %s, {started})",
        (agent_id, task_id, lane),
    )


async def _agent_with_two_runs(make_agent, make_task, db, alias, *, older, newer):
    """An AI agent with a running work run and a running conversation run. `older` is
    the lane whose run started first (10 min ago); the other started 1 min ago."""
    a = await make_agent(alias, "eng")
    tw = await make_task(f"{alias} work task", "done", assignee_alias=alias)
    tc = await make_task(f"{alias} conversation task", "done", assignee_alias=alias)
    by_lane = {"work": tw["id"], "conversation": tc["id"]}
    _run(db, a["agent_id"], by_lane[older], older, ts_ago(600))
    _run(db, a["agent_id"], by_lane[newer], newer, ts_ago(60))
    return a


@pytest.mark.asyncio
async def test_live_work_lease_prefers_the_work_run(client, db, container, make_agent, make_task):
    a = await _agent_with_two_runs(make_agent, make_task, db, "worker",
                                   older="work", newer="conversation")
    _lease(db, a["agent_id"], work=ts_from_now(300), conv=ts_from_now(300))
    [la] = _row(await client.get("/api/containers"), container["id"])["live_agents"]
    assert la["alias"] == "worker"
    assert la["status"] == "working"
    assert la["task_title"] == "worker work task"


@pytest.mark.asyncio
async def test_only_conversation_lease_prefers_the_conversation_run(
        client, db, container, make_agent, make_task):
    a = await _agent_with_two_runs(make_agent, make_task, db, "chatter",
                                   older="conversation", newer="work")
    # work lease lapsed, conversation lease live
    _lease(db, a["agent_id"], work=ts_ago(60), conv=ts_from_now(300))
    [la] = _row(await client.get("/api/containers"), container["id"])["live_agents"]
    assert la["task_title"] == "chatter conversation task"


@pytest.mark.asyncio
async def test_no_live_lease_picks_the_newest_running_run(
        client, db, container, make_agent, make_task):
    a = await _agent_with_two_runs(make_agent, make_task, db, "orphan",
                                   older="work", newer="conversation")
    _lease(db, a["agent_id"], work=ts_ago(120), conv=ts_ago(120))
    [la] = _row(await client.get("/api/containers"), container["id"])["live_agents"]
    assert la["status"] == "working"  # VD-09: a running run reads Working, lease or not
    assert la["task_title"] == "orphan conversation task"


@pytest.mark.asyncio
async def test_agent_without_wake_state_row_picks_the_newest_run(
        client, db, container, make_agent, make_task):
    a = await _agent_with_two_runs(make_agent, make_task, db, "stateless",
                                   older="conversation", newer="work")
    db.execute("DELETE FROM agent_wake_state WHERE agent_id = %s", (a["agent_id"],))
    [la] = _row(await client.get("/api/containers"), container["id"])["live_agents"]
    assert la["task_title"] == "stateless work task"


@pytest.mark.asyncio
async def test_fresh_project_and_idle_agents_list_cleanly(
        client, db, container, make_agent):
    """The #281 repro: a fresh project (a human, no or idle AI agents) must list, not 500."""
    await make_agent("operator", "operator", kind="human")
    row = _row(await client.get("/api/containers"), container["id"])
    assert row["live_agents"] == [] and row["live_agents_total"] == 0
    idle = await make_agent("idle-bot", "eng")
    _lease(db, idle["agent_id"], work=ts_from_now(300))  # live lease, nothing to do
    row = _row(await client.get("/api/containers"), container["id"])
    assert row["live_agents"] == [] and row["live_agents_total"] == 0
