"""GH #83 — lazy/late worker-run → task attribution.

A worker run that does work for a task must be attributed to that task no matter how the
worker was spawned. Several spawn paths can't supply a task_id at wake time:
  - a task-request accept (the spawned task is in_progress, not ready-queued, and no wake
    event carries its id),
  - a checkpoint respawn that lost the original wake context,
  - any wake that fires without a directed task event.
The portal backfills the link server-side: at run start (POST /agents/{aid}/runs) from the
agent's current in_progress task, and as a backstop on /finish for a run still unattached.
"""
import uuid


def _task_payload(title="build X", dod="done"):
    return {"title": title, "definition_of_done": dod, "priority": 100}


async def test_run_without_task_id_attributes_to_current_in_progress_task(
        client, make_agent, make_task):
    """A run started with no task_id is lazily linked to the agent's current in_progress task.
    An assigned task is created in_progress with an agent_tasks 'working' row."""
    a = await make_agent("W", "eng")
    aid = a["agent_id"]
    tid = (await make_task("T", "dod", assignee_alias="W"))["id"]

    # the daemon spawns a run but passes NO task_id (e.g. wake carried no directed task event)
    r = await client.post(f"/api/agents/{aid}/runs", json={"wake_kind": "ephemeral"})
    assert r.status_code == 201, r.text
    assert r.json()["task_id"] == tid              # lazily attributed at start

    # the run shows up under the task's run feed
    pt = await client.get(f"/api/tasks/{tid}/runs")
    assert [run["run_id"] for run in pt.json()["runs"]] == [r.json()["run_id"]]


async def test_accept_task_spawned_run_is_attributed(
        client, make_agent, make_request):
    """The headline scenario: a worker created by ACCEPTING a task request must not float
    unattached. The accepter's next run (no task_id from the wake) links to the spawned task."""
    a = await make_agent("Requester", "lead")
    b = await make_agent("bb", "eng")
    req = await make_request(a["agent_id"], "build X", target_alias="bb",
                             type="task", task=_task_payload())
    acc = await client.post(f"/api/requests/{req['request_id']}/accept-task",
                            json={"responder_agent_id": b["agent_id"], "note": "on it"})
    spawned = acc.json()["spawned_task_id"]
    assert spawned

    # the accepter wakes to work the spawned task; the wake carries no task_id
    r = await client.post(f"/api/agents/{b['agent_id']}/runs", json={"wake_kind": "ephemeral"})
    assert r.status_code == 201, r.text
    assert r.json()["task_id"] == spawned

    pt = await client.get(f"/api/tasks/{spawned}/runs")
    assert r.json()["run_id"] in [run["run_id"] for run in pt.json()["runs"]]


async def test_late_attribution_on_finish_when_unattached_at_start(
        client, make_agent, make_task):
    """Backstop: a run that started before the agent had any in_progress task (so it began
    unattached) is reconciled on /finish once the agent's current task is determinable."""
    a = await make_agent("W", "eng")
    aid = a["agent_id"]

    # run starts while the agent holds no in_progress task → unattached
    r = await client.post(f"/api/agents/{aid}/runs", json={"wake_kind": "ephemeral"})
    assert r.json()["task_id"] is None

    # the agent now has an in_progress task (assigned task is created in_progress + working)
    tid = (await make_task("T", "dod", assignee_alias="W"))["id"]

    # finishing the run backfills the link
    f = await client.post(f"/api/runs/{r.json()['run_id']}/finish",
                          json={"status": "exited", "exit_code": 0})
    assert f.status_code == 200
    run = (await client.get(f"/api/agents/{aid}/runs")).json()["runs"][0]
    assert run["task_id"] == tid


async def test_explicit_task_id_is_never_overwritten(client, make_agent, make_task):
    """No regression: an explicitly-supplied task_id is preserved at start AND survives finish
    (the finish backstop only fills a NULL link, never replaces an existing one)."""
    a = await make_agent("W", "eng")
    aid = a["agent_id"]
    # two in_progress tasks; T2 is created later so the lazy guess (most-recently-started) is T2,
    # NOT the explicit T1 we pass — proving the explicit link wins over the heuristic.
    t1 = await make_task("T1", "dod", assignee_alias="W")
    await make_task("T2", "dod", assignee_alias="W")

    r = await client.post(f"/api/agents/{aid}/runs",
                          json={"wake_kind": "ephemeral", "task_id": t1["id"]})
    assert r.json()["task_id"] == t1["id"]          # explicit link kept, not the lazy guess
    await client.post(f"/api/runs/{r.json()['run_id']}/finish", json={"status": "exited"})
    run = (await client.get(f"/api/agents/{aid}/runs")).json()["runs"][0]
    assert run["task_id"] == t1["id"]               # finish did not overwrite it


async def test_taskless_wake_stays_unattributed(client, make_agent):
    """An agent with no active task (a genuinely inbox-only wake) leaves the run unattached —
    we never invent a bogus link."""
    a = await make_agent("W", "eng")
    aid = a["agent_id"]
    r = await client.post(f"/api/agents/{aid}/runs", json={"wake_kind": "ephemeral"})
    assert r.status_code == 201, r.text
    assert r.json()["task_id"] is None
    f = await client.post(f"/api/runs/{r.json()['run_id']}/finish", json={"status": "exited"})
    assert f.status_code == 200
    run = (await client.get(f"/api/agents/{aid}/runs")).json()["runs"][0]
    assert run["task_id"] is None
