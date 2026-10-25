"""Reproduce nested-plan misrouting and duplicate deliveries of one result/closure."""

import asyncio

import pytest

from conftest import ts_ago


async def post_message(client, task, author, body):
    response = await client.post(f"/api/tasks/{task}/messages", json={
        "author_agent_id": author, "body": body,
    })
    assert response.status_code == 201, response.text
    return response.json()["message_id"]


async def candidate(client, cid, aid):
    response = await client.get(f"/api/containers/{cid}/wake-scan?cooldown=0&min_idle=0")
    assert response.status_code == 200, response.text
    return next(c for c in response.json()["candidates"] if c["agent_id"] == aid)


async def test_child_plan_ignores_coordinator_brief(client, container, make_agent, make_task):
    parent = await make_agent("Coordinator")
    child = await make_agent("Child")
    task = await make_task("child work", "tested", assignee_alias="Child")
    await post_message(client, task["id"], parent["agent_id"], "Opening brief: investigate this")
    await post_message(client, task["id"], child["agent_id"], "Plan: reproduce, fix, test")
    response = await client.get(f"/api/containers/{container['id']}/tasks")
    row = next(t for t in response.json()["tasks"] if t["id"] == task["id"])
    assert row["plan_message"]["author_alias"] == "Child"
    assert row["plan_message"]["body"] == "Plan: reproduce, fix, test"


async def test_only_child_revision_reopens_rejected_plan(client, container, make_agent, make_task):
    human = await make_agent("Owner", kind="human")
    parent = await make_agent("Coordinator")
    child = await make_agent("Child")
    task = await make_task("child work", "tested", assignee_alias="Child")
    tid = task["id"]
    await post_message(client, tid, child["agent_id"], "Plan: implement")
    response = await client.post("/api/decisions", json={
        "subject_type": "plan_approval", "subject_id": tid, "decision": "reject",
        "reason": "Add tests", "actor_agent_id": human["agent_id"],
    })
    assert response.status_code == 201, response.text
    await post_message(client, tid, parent["agent_id"], "Please address the feedback")

    async def current():
        rows = (await client.get(f"/api/containers/{container['id']}/tasks")).json()["tasks"]
        return next(t for t in rows if t["id"] == tid)

    assert (await current())["plan_decision"]["decision"] == "reject"
    await post_message(client, tid, child["agent_id"], "Revised plan: implement with tests")
    await post_message(client, tid, parent["agent_id"], "Thanks for updating")
    row = await current()
    assert row["plan_decision"] is None
    assert row["plan_message"]["body"] == "Revised plan: implement with tests"


@pytest.mark.parametrize("stale_target", [True, False])
async def test_approval_routes_to_child_even_with_stale_or_missing_target(
    client, container, make_agent, make_task, db, stale_target,
):
    human = await make_agent("Owner", kind="human")
    parent = await make_agent("Coordinator")
    child = await make_agent("Child")
    task = await make_task("child work", "tested", assignee_alias="Child")
    await post_message(client, task["id"], parent["agent_id"], "Opening brief")
    await post_message(client, task["id"], child["agent_id"], "Plan: implement")
    body = {"subject_type": "plan_approval", "subject_id": task["id"],
            "decision": "approve", "actor_agent_id": human["agent_id"]}
    if stale_target:
        body["target_agent_id"] = parent["agent_id"]
    response = await client.post("/api/decisions", json=body)
    assert response.status_code == 201, response.text
    assert response.json()["target_agent_id"] == child["agent_id"]
    assert not [e for e in db.event_rows(parent["agent_id"]) if e["event_name"] == "decision_made"]
    decisions = [e for e in db.event_rows(child["agent_id"]) if e["event_name"] == "decision_made"]
    assert len(decisions) == 1
    assert decisions[0]["payload"]["subject_id"] == task["id"]


@pytest.mark.parametrize("message_first", [True, False])
async def test_exact_result_mirror_has_one_alert_and_one_pending_delivery(
    client, container, make_agent, make_task, make_request, db, message_first,
):
    parent = await make_agent("Coordinator")
    reviewer = await make_agent("Reviewer")
    task = await make_task("parent work", "reviewed", assignee_alias="Coordinator")
    tid, aid, rid = task["id"], parent["agent_id"], reviewer["agent_id"]
    request = await make_request(aid, "Is the result ready?", target_alias="Reviewer", originating_task_id=tid)
    # Isolate the result from the earlier assignment. This is an event ack, not a read cursor.
    await client.post(f"/api/agents/{aid}/events/ack-handled", json={
        "event_ids": [e["id"] for e in db.event_rows(aid)],
    })
    result = "CLEAN: the final package passes the agreed checks."

    async def respond():
        r = await client.post(f"/api/requests/{request['id']}/respond", json={
            "responder_agent_id": rid, "response": result,
        })
        assert r.status_code == 200, r.text

    if message_first:
        await post_message(client, tid, rid, result)
        await respond()
    else:
        await respond()
        await post_message(client, tid, rid, result)
    feed = (await client.get(f"/api/agents/{aid}/notifications")).json()["notifications"]
    alerts = [n for n in feed if n["event_name"] in ("task_message", "request_answered")]
    assert [n["event_name"] for n in alerts] == ["request_answered"]
    wake = await candidate(client, container["id"], aid)
    assert wake["pending_events"] == 1
    assert wake["wake_task_id"] == tid  # parent still unblocks on its originating task
    assert wake["should_wake"] is True
    await client.post(f"/api/agents/{aid}/events/ack-handled", json={"event_ids": wake["handled_event_ids"]})
    assert (await candidate(client, container["id"], aid))["pending_events"] == 0
    thread = (await client.get(f"/api/tasks/{tid}/messages")).json()["messages"]
    assert any(m["body"] == result for m in thread)
    outbox = (await client.get(f"/api/agents/{aid}/outbox?status=answered")).json()["outgoing_requests"]
    assert any(r["id"] == request["id"] for r in outbox)
    # A late copy after the answer was drained does not restart the same work.
    await post_message(client, tid, rid, result)
    assert (await candidate(client, container["id"], aid))["pending_events"] == 0


@pytest.mark.parametrize("case", ["different_body", "different_author", "different_task", "old_message", "human"])
async def test_independent_thread_messages_are_not_coalesced(
    client, make_agent, make_task, make_request, db, case,
):
    parent = await make_agent("Coordinator")
    reviewer = await make_agent("Reviewer", kind="human" if case == "human" else "ai")
    other = await make_agent("Other")
    task = await make_task("parent work", "reviewed", assignee_alias="Coordinator")
    task2 = await make_task("other work", "reviewed", assignee_alias="Coordinator")
    aid, tid = parent["agent_id"], task["id"]
    req = await make_request(aid, "Is this ready?", target_alias="Reviewer", originating_task_id=tid)
    # Same preview is deliberately insufficient: compare full text.
    result = "A detailed review: " + "x" * 150 + " passed"
    mid = await post_message(
        client, task2["id"] if case == "different_task" else tid,
        other["agent_id"] if case == "different_author" else reviewer["agent_id"],
        result + " with additional instructions" if case == "different_body" else result,
    )
    if case == "old_message":
        db.execute("UPDATE task_messages SET created_at=%s WHERE id=%s", (ts_ago(120), mid))
    response = await client.post(f"/api/requests/{req['id']}/respond", json={
        "responder_agent_id": reviewer["agent_id"], "response": result,
    })
    assert response.status_code == 200, response.text
    rows = db.event_rows(aid)
    assert len([e for e in rows if e["event_name"] == "task_message"]) == 1
    assert len([e for e in rows if e["event_name"] == "request_answered"]) == 1


async def test_other_assignees_and_direct_requests_still_receive_work(
    client, container, make_agent, make_task, make_request, db,
):
    parent = await make_agent("Coordinator")
    teammate = await make_agent("Teammate")
    reviewer = await make_agent("Reviewer")
    task = await make_task("shared parent", "reviewed", assignee_alias="Coordinator")
    tid, aid = task["id"], parent["agent_id"]
    db.execute("INSERT INTO agent_tasks (task_id, agent_id, assignment_status) VALUES (%s,%s,'working')",
               (tid, teammate["agent_id"]))
    req = await make_request(aid, "Is it ready?", target_alias="Reviewer", originating_task_id=tid)
    result = "CLEAN: shared review completed"
    response = await client.post(f"/api/requests/{req['id']}/respond", json={
        "responder_agent_id": reviewer["agent_id"], "response": result,
    })
    assert response.status_code == 200, response.text
    await post_message(client, tid, reviewer["agent_id"], result)
    assert len([e for e in db.event_rows(teammate["agent_id"]) if e["event_name"] == "task_message"]) == 1
    assert not [e for e in db.event_rows(aid) if e["event_name"] == "task_message"]
    direct = await make_request(reviewer["agent_id"], "What should happen next?", target_alias="Coordinator")
    assert any(e["event_name"] == "request_created" and e["payload"]["request_id"] == direct["id"]
               for e in db.event_rows(aid))
    assert (await candidate(client, container["id"], aid))["should_wake"] is True


async def test_concurrent_result_posts_preserve_one_delivery(
    client, make_agent, make_task, make_request, db,
):
    parent = await make_agent("Coordinator")
    reviewer = await make_agent("Reviewer")
    task = await make_task("parent work", "reviewed", assignee_alias="Coordinator")
    aid, rid, tid = parent["agent_id"], reviewer["agent_id"], task["id"]
    for attempt in range(3):
        req = await make_request(aid, "Is this ready?", target_alias="Reviewer", originating_task_id=tid)
        result = f"CLEAN: result for review round {attempt}"
        _, response = await asyncio.gather(
            post_message(client, tid, rid, result),
            client.post(f"/api/requests/{req['id']}/respond", json={
                "responder_agent_id": rid, "response": result,
            }),
        )
        assert response.status_code == 200, response.text
    rows = db.event_rows(aid)
    assert not [e for e in rows if e["event_name"] == "task_message"]
    # Separate requests stay separate, even when they share a task and recipient.
    assert len([e for e in rows if e["event_name"] == "request_answered"]) == 3


async def test_forced_cancel_sends_one_stop_signal(client, container, make_agent, make_task, db):
    human = await make_agent("Owner", kind="human")
    worker = await make_agent("Worker")
    task = await make_task("obsolete work", "done", assignee_alias="Worker")
    aid = worker["agent_id"]
    before = max(e["id"] for e in db.event_rows(aid))
    response = await client.post(f"/api/tasks/{task['id']}/cancel", json={
        "actor_agent_id": human["agent_id"], "reason": "Superseded; stop this work",
    })
    assert response.status_code == 200, response.text
    events = [e for e in db.event_rows(aid) if e["id"] > before]
    assert len(events) == 1
    wake = await candidate(client, container["id"], aid)
    assert wake["should_wake"] is True
    assert any("Superseded; stop this work" in m for m in wake["prompt_messages"])
    assert any("no further work" in m for m in wake["prompt_messages"])
    assert db.execute("SELECT id FROM decisions WHERE subject_id=%s", (task["id"],))
    assert wake["notifications"][0]["rank_label"] == "interrupt"
    await client.post(f"/api/agents/{aid}/events/ack-handled", json={"event_ids": wake["handled_event_ids"]})
    assert (await candidate(client, container["id"], aid))["should_wake"] is False
