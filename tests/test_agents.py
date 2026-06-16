"""Agent state machine (Orcha#22): registration, initial-task, status derivation."""
import uuid


async def _agent_status(client, cid, alias):
    snap = await client.get(f"/api/containers/{cid}")
    for a in snap.json()["agents"]:
        if a["alias"] == alias:
            return a["status"]
    return None


async def test_register_ai_and_human(client, container):
    cid = container["id"]
    r = await client.post(f"/api/containers/{cid}/agents",
                          json={"alias": "bot", "role": "worker", "kind": "ai",
                                "prompt": "You are a bot."})
    assert r.status_code in (200, 201), r.text
    h = await client.post(f"/api/containers/{cid}/agents",
                          json={"alias": "kedar", "role": "operator", "kind": "human"})
    assert h.status_code in (200, 201), h.text


async def test_ai_without_prompt_rejected_400(client, container):
    r = await client.post(f"/api/containers/{container['id']}/agents",
                          json={"alias": "bot", "role": "worker", "kind": "ai"})
    assert r.status_code == 400, r.text


async def test_human_with_initial_task_rejected_400(client, container):
    r = await client.post(f"/api/containers/{container['id']}/agents",
                          json={"alias": "h", "role": "op", "kind": "human",
                                "initial_task": {"title": "x", "definition_of_done": "y"}})
    assert r.status_code == 400, r.text


async def test_duplicate_alias_409(client, container, make_agent):
    await make_agent("dup", "worker")
    r = await client.post(f"/api/containers/{container['id']}/agents",
                          json={"alias": "dup", "role": "worker", "kind": "ai",
                                "prompt": "p"})
    assert r.status_code == 409, r.text


async def test_initial_task_is_claimed(client, container, make_agent, db):
    a = await make_agent("worker", "eng",
                         initial_task={"title": "kickoff", "definition_of_done": "done"})
    assert a["initial_task"] is not None
    # Claiming an initial task flips the STORED (ownership-derived) status to 'working'.
    # ISS-16/#89: the SNAPSHOT `status` is now liveness-derived (working requires a live
    # lease too), so this transition is asserted against the persisted column directly.
    stored = db.execute("SELECT status FROM agents WHERE id=%s", (a["agent_id"],))[0]["status"]
    assert stored == "working"


async def test_status_idle_then_awaiting_request(client, container, make_agent):
    a = await make_agent("solo", "eng")
    assert await _agent_status(client, container["id"], "solo") == "idle"
    b = await make_agent("other", "eng")
    # an open OUTGOING request flips the requester to awaiting_request
    await client.post(f"/api/containers/{container['id']}/requests",
                      json={"requester_agent_id": a["agent_id"], "target_alias": "other",
                            "payload": "q", "type": "info"})
    assert await _agent_status(client, container["id"], "solo") == "awaiting_request"


async def test_terminated_never_auto_revived(client, container, make_agent, db):
    a = await make_agent("zombie", "eng")
    db.execute("UPDATE agents SET status='terminated' WHERE id=%s", (a["agent_id"],))
    # an action that recomputes the agent's status must NOT revive it
    await make_agent("peer", "eng")
    await client.post(f"/api/containers/{container['id']}/requests",
                      json={"requester_agent_id": a["agent_id"], "target_alias": "peer",
                            "payload": "q", "type": "info"})
    assert await _agent_status(client, container["id"], "zombie") == "terminated"


async def test_register_into_unknown_container_404(client):
    r = await client.post(f"/api/containers/{uuid.uuid4()}/agents",
                          json={"alias": "x", "role": "r", "kind": "ai", "prompt": "p"})
    assert r.status_code == 404, r.text
