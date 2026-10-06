"""TG-13b: after a plan REJECT the agent often posts a short ack ("revising now") before
the real revision. The gate must show the revision (the LATEST agent post of the
post-reject round), not the ack. The opening round still shows the EARLIEST post.
Mirrors the Needs-you counter (attention_counts.plan_author)."""
import asyncio


async def _post(client, tid, aid, body):
    r = await client.post(f"/api/tasks/{tid}/messages", json={"author_agent_id": aid, "body": body})
    assert r.status_code == 201, r.text
    await asyncio.sleep(0.01)  # distinct created_at


async def _plan(client, cid, tid):
    r = await client.get(f"/api/containers/{cid}/tasks")
    assert r.status_code == 200, r.text
    body = r.json()
    rows = body["tasks"] if isinstance(body, dict) else body
    return next(t for t in rows if t["id"] == tid)


async def test_post_reject_round_shows_latest_agent_post(client, container, make_agent, make_task):
    cid = container["id"]
    human = await make_agent("Boss", kind="human")
    worker = await make_agent("Forge", kind="ai")
    task = await make_task("limits", "done when limited", assignee_alias="Forge")
    tid = task["id"]

    await _post(client, tid, worker["agent_id"], "Plan: step 1, step 2")
    await _post(client, tid, worker["agent_id"], "progress note")
    t = await _plan(client, cid, tid)
    assert t["plan_message"]["body"] == "Plan: step 1, step 2"  # opening round: earliest

    r = await client.post("/api/decisions", json={
        "subject_type": "plan_approval", "subject_id": tid, "decision": "reject",
        "reason": "split step 2", "actor_agent_id": human["agent_id"],
        "target_agent_id": worker["agent_id"],
    })
    assert r.status_code == 201, r.text
    await asyncio.sleep(0.01)
    await _post(client, tid, worker["agent_id"], "Ack — revising the plan now.")
    await _post(client, tid, worker["agent_id"], "Revised plan: step 1, step 2a, step 2b")

    t = await _plan(client, cid, tid)
    assert t["plan_decision"] is None
    assert t["previous_plan_decision"]["decision"] == "reject"
    assert t["plan_message"]["body"] == "Revised plan: step 1, step 2a, step 2b"
