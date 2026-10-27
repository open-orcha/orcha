"""Task-only ON/OFF autonomy across owner controls, plans and completion."""

import pytest


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


async def test_human_verification_preserves_legacy_task_without_saved_result(
    client, make_agent, make_task, db
):
    owner = await make_agent("Owner", kind="human")
    task = await make_task("Legacy manual task", "The owner confirms completion")
    db.execute(
        "UPDATE tasks SET status='needs_verification', result=NULL WHERE id=%s",
        (task["id"],),
    )

    accepted = await client.post(
        f"/api/tasks/{task['id']}/verify",
        json={"approve": True, "actor_agent_id": owner["agent_id"]},
    )

    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["status"] == "completed"
    record = db.execute(
        "SELECT actor_kind,autonomy_at_approval,permission_source,submission_sha256 "
        "FROM task_approval_records WHERE task_id=%s AND phase='completion'",
        (task["id"],),
    )[0]
    assert record["actor_kind"] == "human"
    assert record["autonomy_at_approval"] == "off"
    assert record["permission_source"] == "human_verification"
    assert len(record["submission_sha256"]) == 64


async def test_ordinary_opening_post_is_not_a_self_approved_plan(
    client, container, make_agent, make_task, db, work_headers
):
    owner = await make_agent("Owner", kind="human")
    worker = await make_agent("Worker")
    task = await make_task("Merge website", "Merged", assignee_alias="Worker")
    tid = task["id"]
    assert (await _set(client, tid, owner["agent_id"], "on")).status_code == 200
    await _claim(client, worker["agent_id"], work_headers)
    for note in ("Nothing to merge yet.", "Planning to inspect this.", "Update: ready.\nPlan: this is not the opening line."):
        response = await client.post(f"/api/tasks/{tid}/messages", json={"author_agent_id": worker["agent_id"], "body": note})
        assert response.status_code == 201, response.text
        assert response.json()["plan_auto_approved"] is False
    assert not db.execute("SELECT * FROM task_approval_records WHERE task_id=%s", (tid,))
    assert not db.execute("SELECT * FROM decisions WHERE subject_id=%s", (tid,))
    snapshot = (await client.get(f"/api/containers/{container['id']}")).json()
    row = next(t for t in snapshot["tasks"] if t["id"] == tid)
    assert row["plan_message"] is None
    assert row["plan_decision"] is None
    messages = (await client.get(f"/api/tasks/{tid}/messages")).json()["messages"]
    assert len(messages) == 3
    assert messages[0]["body"] == "Nothing to merge yet."

    plan = "Plan: check the website change and merge the approved version."
    response = await client.post(f"/api/tasks/{tid}/messages", json={"author_agent_id": worker["agent_id"], "body": plan})
    assert response.json()["plan_auto_approved"] is True
    row = next(t for t in (await client.get(f"/api/containers/{container['id']}")).json()["tasks"] if t["id"] == tid)
    assert row["plan_message"]["body"] == plan
    response = await client.post(f"/api/tasks/{tid}/messages", json={"author_agent_id": worker["agent_id"], "body": "Merged; the site redeploys."})
    assert response.json()["plan_auto_approved"] is False
    assert len(db.execute("SELECT * FROM task_approval_records WHERE task_id=%s", (tid,))) == 1


async def test_autonomy_off_keeps_human_plan_selection(client, container, make_agent, make_task, work_headers):
    worker = await make_agent("Worker")
    task = await make_task("Human approval", "Reviewed", assignee_alias="Worker")
    await _claim(client, worker["agent_id"], work_headers)
    body = "I will inspect the change and ask for approval."
    posted = await client.post(f"/api/tasks/{task['id']}/messages", json={"author_agent_id": worker["agent_id"], "body": body})
    assert posted.json()["plan_auto_approved"] is False
    row = next(t for t in (await client.get(f"/api/containers/{container['id']}")).json()["tasks"] if t["id"] == task["id"])
    assert row["plan_message"]["body"] == body
    assert row["plan_decision"] is None


@pytest.mark.parametrize("body,is_plan", [
    ("Plan", True), ("PLAN\nInspect the change", True), ("  \tPlan — inspect it", True),
    ("Plan for approval", True), ("Plan1 update", False), ("Plan_update", False),
    ("Planning the work", False), ("\nPlan: later line", False),
])
async def test_autonomy_on_plan_word_boundary(client, make_agent, make_task, work_headers, body, is_plan):
    owner = await make_agent("Owner", kind="human")
    worker = await make_agent("Worker")
    task = await make_task("Plan detection", "Checked", assignee_alias="Worker")
    await _set(client, task["id"], owner["agent_id"], "on")
    await _claim(client, worker["agent_id"], work_headers)
    response = await client.post(f"/api/tasks/{task['id']}/messages", json={"author_agent_id": worker["agent_id"], "body": body})
    assert response.status_code == 201, response.text
    assert response.json()["plan_auto_approved"] is is_plan


async def test_autonomy_on_note_after_rejection_does_not_replace_plan(client, container, make_agent, make_task, db, work_headers):
    owner = await make_agent("Owner", kind="human")
    worker = await make_agent("Worker")
    task = await make_task("Revise plan", "Checked", assignee_alias="Worker")
    tid = task["id"]
    await _set(client, tid, owner["agent_id"], "on")
    await _claim(client, worker["agent_id"], work_headers)
    await client.post(f"/api/tasks/{tid}/messages", json={"author_agent_id": worker["agent_id"], "body": "Plan: original approach"})
    rejection = await client.post("/api/decisions", json={"actor_agent_id": owner["agent_id"], "target_agent_id": worker["agent_id"], "subject_type": "plan_approval", "subject_id": tid, "decision": "reject", "reason": "Use a smaller change"})
    assert rejection.status_code == 201, rejection.text
    note = await client.post(f"/api/tasks/{tid}/messages", json={"author_agent_id": worker["agent_id"], "body": "I am investigating the feedback."})
    assert note.json()["plan_auto_approved"] is False
    row = next(t for t in (await client.get(f"/api/containers/{container['id']}")).json()["tasks"] if t["id"] == tid)
    assert row["plan_decision"]["decision"] == "reject"
    assert row["plan_message"]["body"] == "Plan: original approach"
    revised = await client.post(f"/api/tasks/{tid}/messages", json={"author_agent_id": worker["agent_id"], "body": "Plan: smaller change"})
    assert revised.json()["plan_auto_approved"] is True
    row = next(t for t in (await client.get(f"/api/containers/{container['id']}")).json()["tasks"] if t["id"] == tid)
    assert row["plan_message"]["body"] == "Plan: smaller change"
