"""Task-only ON/OFF autonomy across owner controls, plans and completion."""


async def _claim(client, agent_id, work_headers):
    response = await client.post(
        f"/api/agents/{agent_id}/next", headers=await work_headers(agent_id)
    )
    assert response.status_code == 200, response.text
    return response.json()


async def _set(client, task_id, owner_id, mode):
    return await client.put(
        f"/api/tasks/{task_id}/autonomy",
        json={"autonomy": mode, "actor_agent_id": owner_id},
    )


async def test_new_and_existing_tasks_default_off_and_legacy_project_setting_is_inert(
    client, container, make_agent, make_task, db, work_headers
):
    owner = await make_agent("Owner", kind="human")
    worker = await make_agent("Worker")
    task = await make_task("Safe default", "Finish it", assignee_alias="Worker")
    row = db.execute(
        "SELECT autonomy,autonomy_revision FROM tasks WHERE id=%s", (task["id"],)
    )[0]
    assert row == {"autonomy": "off", "autonomy_revision": 1}

    # Retained legacy data is history only, even when an old database says Full.
    db.execute(
        "UPDATE containers SET autonomy_level='full',autonomy_enforced=true WHERE id=%s",
        (container["id"],),
    )
    await _claim(client, worker["agent_id"], work_headers)
    done = await client.post(
        f"/api/tasks/{task['id']}/done",
        json={"agent_id": worker["agent_id"], "result": "Finished safely"},
        headers=await work_headers(worker["agent_id"]),
    )
    assert done.status_code == 200 and done.json()["status"] == "needs_verification"
    assert (
        await client.post(
            f"/api/containers/{container['id']}/autonomy",
            json={"level": "full", "actor_agent_id": owner["agent_id"]},
        )
    ).status_code == 410


async def test_only_owner_can_toggle_and_change_applies_to_future_actions(
    client, make_agent, make_task, db, work_headers
):
    owner = await make_agent("Owner", kind="human")
    member = await make_agent("Member", kind="human")
    worker = await make_agent("Worker")
    task = await make_task("Toggle", "Ship it", assignee_alias="Worker")

    denied = await _set(client, task["id"], member["agent_id"], "on")
    assert denied.status_code == 403
    enabled = await _set(client, task["id"], owner["agent_id"], "on")
    assert enabled.status_code == 200
    assert enabled.json()["autonomy"] == "on"
    assert enabled.json()["autonomy_revision"] == 2

    await _claim(client, worker["agent_id"], work_headers)
    plan = await client.post(
        f"/api/tasks/{task['id']}/messages",
        json={
            "author_agent_id": worker["agent_id"],
            "body": "Plan: implement and test.",
        },
    )
    assert plan.status_code == 201 and plan.json()["plan_auto_approved"] is True
    plan_record = db.execute(
        "SELECT phase,actor_kind,autonomy_at_approval,autonomy_revision "
        "FROM task_approval_records WHERE task_id=%s",
        (task["id"],),
    )[0]
    assert plan_record == {
        "phase": "plan",
        "actor_kind": "ai",
        "autonomy_at_approval": "on",
        "autonomy_revision": 2,
    }

    disabled = await _set(client, task["id"], owner["agent_id"], "off")
    assert disabled.status_code == 200 and disabled.json()["autonomy_revision"] == 3
    done = await client.post(
        f"/api/tasks/{task['id']}/done",
        json={"agent_id": worker["agent_id"], "result": "Implemented and tested."},
        headers=await work_headers(worker["agent_id"]),
    )
    assert done.status_code == 200 and done.json()["status"] == "needs_verification"
    # The earlier plan approval remains evidence of its then-current ON permission.
    assert db.execute(
        "SELECT autonomy_at_approval,autonomy_revision FROM task_approval_records "
        "WHERE task_id=%s AND phase='plan'",
        (task["id"],),
    )[0] == {"autonomy_at_approval": "on", "autonomy_revision": 2}


async def test_on_self_completes_and_off_human_completion_records_exact_authority(
    client, make_agent, make_task, db, work_headers
):
    owner = await make_agent("Owner", kind="human")
    worker = await make_agent("Worker")

    automatic = await make_task(
        "Automatic", "Meet the criteria", assignee_alias="Worker"
    )
    assert (
        await _set(client, automatic["id"], owner["agent_id"], "on")
    ).status_code == 200
    await _claim(client, worker["agent_id"], work_headers)
    completed = await client.post(
        f"/api/tasks/{automatic['id']}/done",
        json={"agent_id": worker["agent_id"], "result": "Criteria met"},
        headers=await work_headers(worker["agent_id"]),
    )
    assert completed.status_code == 200 and completed.json()["status"] == "completed"
    assert db.execute(
        "SELECT actor_kind,autonomy_at_approval,permission_source FROM task_approval_records "
        "WHERE task_id=%s AND phase='completion'",
        (automatic["id"],),
    )[0] == {
        "actor_kind": "ai",
        "autonomy_at_approval": "on",
        "permission_source": "task_autonomy",
    }

    manual = await make_task("Manual", "Meet the criteria", assignee_alias="Worker")
    await _claim(client, worker["agent_id"], work_headers)
    parked = await client.post(
        f"/api/tasks/{manual['id']}/done",
        json={"agent_id": worker["agent_id"], "result": "Ready for review"},
        headers=await work_headers(worker["agent_id"]),
    )
    assert parked.status_code == 200 and parked.json()["status"] == "needs_verification"
    accepted = await client.post(
        f"/api/tasks/{manual['id']}/verify",
        json={"approve": True, "actor_agent_id": owner["agent_id"]},
    )
    assert accepted.status_code == 200 and accepted.json()["status"] == "completed"
    assert db.execute(
        "SELECT actor_kind,autonomy_at_approval,permission_source FROM task_approval_records "
        "WHERE task_id=%s AND phase='completion'",
        (manual["id"],),
    )[0] == {
        "actor_kind": "human",
        "autonomy_at_approval": "off",
        "permission_source": "human_verification",
    }
    history = await client.get(f"/api/tasks/{manual['id']}/approvals")
    assert history.status_code == 200, history.text
    record = history.json()["approvals"][0]
    assert record["phase"] == "completion"
    assert record["work_revision"] == 1
    assert record["actor_id"] == owner["agent_id"]
    assert record["actor_alias"] == "Owner"
    assert record["actor_kind"] == "human"
    assert record["autonomy_at_approval"] == "off"
    assert record["permission_source"] == "human_verification"
    assert len(record["requirements_sha256"]) == 64
    assert len(record["submission_sha256"]) == 64
