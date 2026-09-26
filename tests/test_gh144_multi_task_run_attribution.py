"""GH #144 — a continuous worker run spanning multiple tasks must narrate on EACH task.

worker_runs.task_id is a single column: the "primary" attribution set once (explicit at start,
lazily inferred, or the GH #83 accept-task backstop) and never overwritten thereafter (see
test_gh83_lazy_run_attribution.test_accept_task_does_not_overwrite_existing_run_task). That guard
is correct — moving the primary link would risk stamping the wrong task — but on its own it left
a real task (accepted mid-run, in the SAME continuous session) with no run visible at all.

worker_run_tasks is an additive join table recording every task a run has touched. It never
changes worker_runs.task_id; it only widens the READ paths (task run-feed, task-list summary,
per-agent run list filtered by task) so a run shows up on every task it touched, not just the one
in the primary column.
"""
import uuid


def _task_payload(title="build X", dod="done"):
    return {"title": title, "definition_of_done": dod, "priority": 100}


async def test_run_spanning_two_tasks_surfaces_on_both_run_feeds(
        client, make_agent, make_task, make_request, work_headers):
    """The headline GH #144 scenario: a worker finishes/holds task A, then accepts a task
    request that spawns task B in the SAME run. The run must appear under BOTH tasks' /runs."""
    a = await make_agent("Requester", "lead")
    b = await make_agent("bb", "eng")
    task_a = await make_task("task A", "done", assignee_alias="bb")
    headers = await work_headers(b["agent_id"])
    token = headers["X-Orcha-Run-Token"]

    started = await client.post(f"/api/agents/{b['agent_id']}/runs",
                                json={"wake_kind": "ephemeral", "token_id": token,
                                      "task_id": task_a["id"]})
    assert started.status_code == 201, started.text
    run_id = started.json()["run_id"]

    req = await make_request(a["agent_id"], "build B", target_alias="bb",
                             type="task", task=_task_payload(title="task B"))
    acc = await client.post(f"/api/requests/{req['request_id']}/accept-task",
                            json={"responder_agent_id": b["agent_id"], "note": "on it"},
                            headers=headers)
    assert acc.status_code == 200, acc.text
    task_b = acc.json()["spawned_task_id"]

    runs_a = await client.get(f"/api/tasks/{task_a['id']}/runs")
    runs_b = await client.get(f"/api/tasks/{task_b}/runs")
    assert run_id in [r["run_id"] for r in runs_a.json()["runs"]]
    assert run_id in [r["run_id"] for r in runs_b.json()["runs"]]

    # the run's own worker_runs.task_id (primary attribution) is unchanged — still task A.
    agent_run = (await client.get(f"/api/agents/{b['agent_id']}/runs")).json()["runs"][0]
    assert agent_run["task_id"] == task_a["id"]


async def test_secondary_link_survives_multiple_accept_tasks_in_one_run(
        client, make_agent, make_task, make_request, work_headers):
    """A single long-lived session that accepts THREE task requests in a row narrates on all
    three tasks (plus its original primary task), not just the last one."""
    a = await make_agent("Requester", "lead")
    b = await make_agent("bb", "eng")
    task_a = await make_task("task A", "done", assignee_alias="bb")
    headers = await work_headers(b["agent_id"])
    token = headers["X-Orcha-Run-Token"]

    started = await client.post(f"/api/agents/{b['agent_id']}/runs",
                                json={"wake_kind": "ephemeral", "token_id": token,
                                      "task_id": task_a["id"]})
    run_id = started.json()["run_id"]

    spawned_ids = [task_a["id"]]
    for i in range(3):
        req = await make_request(a["agent_id"], f"build {i}", target_alias="bb",
                                 type="task", task=_task_payload(title=f"task {i}"))
        acc = await client.post(f"/api/requests/{req['request_id']}/accept-task",
                                json={"responder_agent_id": b["agent_id"], "note": "on it"},
                                headers=headers)
        assert acc.status_code == 200, acc.text
        spawned_ids.append(acc.json()["spawned_task_id"])

    for tid in spawned_ids:
        runs = await client.get(f"/api/tasks/{tid}/runs")
        assert run_id in [r["run_id"] for r in runs.json()["runs"]], f"missing on task {tid}"


async def test_task_list_run_count_reflects_secondary_attribution(
        client, make_agent, make_task, make_request, work_headers, container):
    """The container task-list summary's `runs.count` (used by the portal task cards) must count
    a secondarily-linked run too, not just an exact worker_runs.task_id match."""
    a = await make_agent("Requester", "lead")
    b = await make_agent("bb", "eng")
    task_a = await make_task("task A", "done", assignee_alias="bb")
    headers = await work_headers(b["agent_id"])
    token = headers["X-Orcha-Run-Token"]
    await client.post(f"/api/agents/{b['agent_id']}/runs",
                      json={"wake_kind": "ephemeral", "token_id": token,
                            "task_id": task_a["id"]})

    req = await make_request(a["agent_id"], "build B", target_alias="bb",
                             type="task", task=_task_payload(title="task B"))
    acc = await client.post(f"/api/requests/{req['request_id']}/accept-task",
                            json={"responder_agent_id": b["agent_id"], "note": "on it"},
                            headers=headers)
    task_b = acc.json()["spawned_task_id"]

    listing = await client.get(f"/api/containers/{container['id']}/tasks")
    assert listing.status_code == 200, listing.text
    by_id = {t["id"]: t for t in listing.json()["tasks"]}
    assert by_id[task_b]["runs"]["count"] == 1


async def test_agent_runs_task_filter_includes_secondary_link(
        client, make_agent, make_task, make_request, work_headers):
    """GET /api/agents/{aid}/runs?task_id= (the per-agent, per-task filtered view) must also
    honor the secondary worker_run_tasks link, matching the task-scoped /api/tasks/{tid}/runs."""
    a = await make_agent("Requester", "lead")
    b = await make_agent("bb", "eng")
    task_a = await make_task("task A", "done", assignee_alias="bb")
    headers = await work_headers(b["agent_id"])
    token = headers["X-Orcha-Run-Token"]
    started = await client.post(f"/api/agents/{b['agent_id']}/runs",
                                json={"wake_kind": "ephemeral", "token_id": token,
                                      "task_id": task_a["id"]})
    run_id = started.json()["run_id"]

    req = await make_request(a["agent_id"], "build B", target_alias="bb",
                             type="task", task=_task_payload(title="task B"))
    acc = await client.post(f"/api/requests/{req['request_id']}/accept-task",
                            json={"responder_agent_id": b["agent_id"], "note": "on it"},
                            headers=headers)
    task_b = acc.json()["spawned_task_id"]

    filtered = await client.get(f"/api/agents/{b['agent_id']}/runs",
                                params={"task_id": task_b})
    assert run_id in [r["run_id"] for r in filtered.json()["runs"]]


async def test_finish_backstop_also_records_secondary_link(
        client, make_agent, make_task, db):
    """The GH #83 finish-time backstop (a run that started task-less gets attributed once the
    agent's active task is determinable) must ALSO write the worker_run_tasks row, not just
    worker_runs.task_id, so a late-attributed run shows up via the task-scoped read path too."""
    a = await make_agent("W", "eng")
    aid = a["agent_id"]

    r = await client.post(f"/api/agents/{aid}/runs", json={"wake_kind": "ephemeral"})
    assert r.json()["task_id"] is None
    run_id = r.json()["run_id"]

    tid = (await make_task("T", "dod", assignee_alias="W"))["id"]

    f = await client.post(f"/api/runs/{run_id}/finish", json={"status": "exited", "exit_code": 0})
    assert f.status_code == 200

    row = db.execute("SELECT task_id FROM worker_run_tasks WHERE run_id=%s", (run_id,))
    assert [str(x["task_id"]) for x in row] == [tid]

    runs = await client.get(f"/api/tasks/{tid}/runs")
    assert run_id in [x["run_id"] for x in runs.json()["runs"]]
