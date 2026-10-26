"""Compatibility checks for retirement of project-level autonomy (#298)."""


async def test_legacy_project_autonomy_route_is_explicitly_retired(
    client, container, make_agent, db
):
    owner = await make_agent("Owner", kind="human")
    before = db.execute(
        "SELECT autonomy_level,autonomy_enforced FROM containers WHERE id=%s",
        (container["id"],),
    )[0]
    response = await client.post(
        f"/api/containers/{container['id']}/autonomy",
        json={"level": "full", "actor_agent_id": owner["agent_id"]},
    )
    assert response.status_code == 410
    assert response.json()["detail"]["code"] == "task_autonomy_only"
    after = db.execute(
        "SELECT autonomy_level,autonomy_enforced FROM containers WHERE id=%s",
        (container["id"],),
    )[0]
    assert after == before


async def test_claim_payload_contains_only_task_authority(
    client, make_agent, make_task, work_headers
):
    owner = await make_agent("Owner", kind="human")
    worker = await make_agent("Worker")
    task = await make_task("Claim", "Finish")
    assigned = await client.post(
        f"/api/tasks/{task['id']}/assign",
        json={
            "actor_agent_id": owner["agent_id"],
            "agent_id": worker["agent_id"],
        },
    )
    assert assigned.status_code == 200, assigned.text
    response = await client.post(
        f"/api/agents/{worker['agent_id']}/next",
        headers=await work_headers(worker["agent_id"]),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["task"]["id"] == task["id"]
    assert body["task_autonomy"] == "off"
    assert body["task_autonomy_revision"] == 1
    assert "autonomy_level" not in body
    assert "effective_autonomy" not in body


async def test_legacy_columns_remain_readable_but_do_not_seed_task_authority(
    db, container, make_agent, make_task
):
    owner = await make_agent("Owner", kind="human")
    db.execute(
        "UPDATE agents SET autonomy_override='full' WHERE id=%s", (owner["agent_id"],)
    )
    assert db.execute(
        "SELECT autonomy_level FROM containers WHERE id=%s", (container["id"],)
    )[0]["autonomy_level"] == "plan"
    task = await make_task("Safe", "Done")
    assert db.execute(
        "SELECT autonomy,autonomy_revision FROM tasks WHERE id=%s", (task["id"],)
    )[0] == {"autonomy": "off", "autonomy_revision": 1}
