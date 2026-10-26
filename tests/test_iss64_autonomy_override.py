"""Compatibility checks for retired per-agent autonomy overrides (#64)."""


async def test_agent_override_write_is_explicitly_retired(
    client, make_agent, db
):
    owner = await make_agent("Owner", kind="human")
    worker = await make_agent("Worker")
    response = await client.patch(
        f"/api/agents/{worker['agent_id']}",
        json={"actor_agent_id": owner["agent_id"], "autonomy_override": "full"},
    )
    assert response.status_code == 410
    assert response.json()["detail"]["code"] == "task_autonomy_only"
    assert db.execute(
        "SELECT autonomy_override FROM agents WHERE id=%s", (worker["agent_id"],)
    )[0]["autonomy_override"] is None


async def test_historical_override_cannot_complete_an_off_task(
    client, make_agent, make_task, db, work_headers
):
    worker = await make_agent("Worker")
    db.execute(
        "UPDATE agents SET autonomy_override='full' WHERE id=%s", (worker["agent_id"],)
    )
    task = await make_task("Safe", "Finish", assignee_alias="Worker")
    await client.post(
        f"/api/agents/{worker['agent_id']}/next",
        headers=await work_headers(worker["agent_id"]),
    )
    response = await client.post(
        f"/api/tasks/{task['id']}/done",
        json={"agent_id": worker["agent_id"], "result": "Finished"},
        headers=await work_headers(worker["agent_id"]),
    )
    assert response.status_code == 200
    assert response.json()["status"] == "needs_verification"


async def test_snapshot_labels_override_as_legacy_history(
    client, container, make_agent, db
):
    worker = await make_agent("Worker")
    db.execute(
        "UPDATE agents SET autonomy_override='pr' WHERE id=%s", (worker["agent_id"],)
    )
    response = await client.get(f"/api/containers/{container['id']}")
    assert response.status_code == 200
    agent = next(a for a in response.json()["agents"] if a["id"] == worker["agent_id"])
    assert agent["legacy_autonomy_override"] == "pr"
    assert "autonomy_override" not in agent
    assert "effective_autonomy" not in agent
