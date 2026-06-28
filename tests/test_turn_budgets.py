"""Turn budgets: GH#39 removed the budget gate — turns_used is telemetry only and never
blocks a claim. The counter still bumps on work (Orcha#22) and not on reads."""


async def test_exhausted_budget_still_allows_claim(client, make_agent, make_task, db):
    """GH#39: an exhausted turn budget no longer 429s an agent off its own assigned+ready task."""
    human = await make_agent("op", "operator", kind="human")
    a = await make_agent("burned", "eng")
    t = await make_task("work", "done")
    ar = await client.post(f"/api/tasks/{t['id']}/assign",
                           json={"actor_agent_id": human["agent_id"], "agent_id": a["agent_id"]})
    assert ar.status_code == 200 and ar.json()["status"] == "ready", ar.text
    db.execute("UPDATE agents SET turns_used=turn_budget WHERE id=%s", (a["agent_id"],))
    r = await client.post(f"/api/agents/{a['agent_id']}/next")
    assert r.status_code == 200 and r.json()["task"] is not None, r.text


async def test_budget_with_headroom_allows_claim(client, make_agent, make_task, db):
    human = await make_agent("op", "operator", kind="human")
    a = await make_agent("fresh", "eng")
    t = await make_task("work", "done")
    ar = await client.post(f"/api/tasks/{t['id']}/assign",
                           json={"actor_agent_id": human["agent_id"], "agent_id": a["agent_id"]})
    assert ar.status_code == 200 and ar.json()["status"] == "ready", ar.text
    db.execute("UPDATE agents SET turns_used=0, turn_budget=10 WHERE id=%s", (a["agent_id"],))
    r = await client.post(f"/api/agents/{a['agent_id']}/next")
    assert r.status_code == 200 and r.json()["task"] is not None


async def _turns(db, aid):
    return db.execute("SELECT turns_used FROM agents WHERE id=%s", (aid,))[0]["turns_used"]


async def test_posting_a_message_bumps_turns(client, make_agent, make_task, db):
    dev = await make_agent("poster", "eng")
    t = await make_task("t", "done", assignee_alias="dev" if False else "poster")
    before = await _turns(db, dev["agent_id"])
    await client.post(f"/api/tasks/{t['task_id']}/messages",
                      json={"author_agent_id": dev["agent_id"], "body": "progress note"})
    after = await _turns(db, dev["agent_id"])
    assert after == before + 1, "posting a message is work → bumps the turn counter"


async def test_reading_does_not_bump_turns(client, make_agent, make_task, db):
    dev = await make_agent("reader", "eng")
    before = await _turns(db, dev["agent_id"])
    await client.get(f"/api/agents/{dev['agent_id']}/inbox")
    await client.get(f"/api/agents/{dev['agent_id']}/outbox")
    after = await _turns(db, dev["agent_id"])
    assert after == before, "read-only endpoints must not consume a turn"
