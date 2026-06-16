"""Info-request state machine (Orcha#22): respond/close/escalate auth, chains, sweep."""
import uuid


async def test_create_open(make_agent, make_request):
    a = await make_agent("a", "eng")
    await make_agent("b", "eng")
    r = await make_request(a["agent_id"], "question?", target_alias="b")
    assert r["status"] == "open"


async def test_respond_only_by_target(client, make_agent, make_request):
    a = await make_agent("a", "eng")
    b = await make_agent("b", "eng")
    intruder = await make_agent("c", "eng")
    req = await make_request(a["agent_id"], "q", target_alias="b")
    rid = req["request_id"]
    bad = await client.post(f"/api/requests/{rid}/respond",
                            json={"responder_agent_id": intruder["agent_id"], "response": "x"})
    assert bad.status_code == 403, bad.text
    ok = await client.post(f"/api/requests/{rid}/respond",
                           json={"responder_agent_id": b["agent_id"], "response": "answer"})
    assert ok.status_code == 200 and ok.json()["status"] == "answered"


async def test_close_only_by_requester(client, make_agent, make_request):
    a = await make_agent("a", "eng")
    b = await make_agent("b", "eng")
    req = await make_request(a["agent_id"], "q", target_alias="b")
    rid = req["request_id"]
    await client.post(f"/api/requests/{rid}/respond",
                      json={"responder_agent_id": b["agent_id"], "response": "answer"})
    bad = await client.post(f"/api/requests/{rid}/close",
                            json={"requester_agent_id": b["agent_id"]})
    assert bad.status_code == 403, bad.text
    ok = await client.post(f"/api/requests/{rid}/close",
                           json={"requester_agent_id": a["agent_id"]})
    assert ok.status_code == 200 and ok.json()["status"] == "closed"


async def test_close_requires_answered_409(client, make_agent, make_request):
    a = await make_agent("a", "eng")
    await make_agent("b", "eng")
    req = await make_request(a["agent_id"], "q", target_alias="b")
    r = await client.post(f"/api/requests/{req['request_id']}/close",
                          json={"requester_agent_id": a["agent_id"]})
    assert r.status_code == 409, "can't close a still-open request"


async def test_escalate_retargets_human(client, make_agent, make_request):
    await make_agent("human", "operator", kind="human")
    a = await make_agent("a", "eng")
    b = await make_agent("b", "eng")
    req = await make_request(a["agent_id"], "q", target_alias="b")
    r = await client.post(f"/api/requests/{req['request_id']}/escalate",
                          json={"requester_agent_id": a["agent_id"], "reason": "no answer"})
    assert r.status_code == 200, r.text
    assert r.json()["escalated"] is True
    assert r.json()["status"] == "open"


async def test_chain_increments_depth(client, container, make_agent, make_request):
    a = await make_agent("a", "eng")
    b = await make_agent("b", "eng")
    parent = await make_request(a["agent_id"], "Q1", target_alias="b")
    child = await make_request(b["agent_id"], "Q2 in service of Q1", target_alias="a",
                               parent_request_id=parent["request_id"])
    assert child["chain_depth"] == 1


async def test_chain_off_closed_parent_rejected(client, make_agent, make_request):
    a = await make_agent("a", "eng")
    b = await make_agent("b", "eng")
    parent = await make_request(a["agent_id"], "Q1", target_alias="b")
    rid = parent["request_id"]
    await client.post(f"/api/requests/{rid}/respond",
                      json={"responder_agent_id": b["agent_id"], "response": "ans"})
    await client.post(f"/api/requests/{rid}/close",
                      json={"requester_agent_id": a["agent_id"]})
    r = await client.post(f"/api/containers/{(await _cid(client))}/requests",
                          json={"requester_agent_id": b["agent_id"], "target_alias": "a",
                                "payload": "late child", "type": "info",
                                "parent_request_id": rid})
    assert r.status_code == 409, "chaining off a closed parent is meaningless"


async def _cid(client):
    return (await client.get("/api/containers")).json()["containers"][0]["id"]


async def test_sweep_escalates_expired(client, make_agent, make_request):
    human = await make_agent("human", "operator", kind="human")
    a = await make_agent("a", "eng")
    await make_agent("b", "eng")
    await make_request(a["agent_id"], "urgent", target_alias="b", expires_minutes=0)
    cid = await _cid(client)
    r = await client.post(f"/api/containers/{cid}/sweep",
                          params={"actor_agent_id": human["agent_id"]})
    assert r.status_code == 200, r.text
    assert r.json()["escalated_count"] >= 1


async def test_sweep_is_human_only(client, make_agent):
    a = await make_agent("a", "eng")
    cid = await _cid(client)
    r = await client.post(f"/api/containers/{cid}/sweep",
                          params={"actor_agent_id": a["agent_id"]})
    assert r.status_code == 403, r.text


async def test_respond_unknown_request_404(client, make_agent):
    a = await make_agent("a", "eng")
    r = await client.post(f"/api/requests/{uuid.uuid4()}/respond",
                          json={"responder_agent_id": a["agent_id"], "response": "x"})
    assert r.status_code == 404, r.text


# ---------- R2.3 idempotent mutations (safe under at-least-once replay) ----------

async def test_respond_idempotent_repeat_returns_current_state(client, make_agent, make_request):
    """A repeat respond by the target returns 200 + the original answer, not 409."""
    a = await make_agent("a", "eng")
    b = await make_agent("b", "eng")
    req = await make_request(a["agent_id"], "q", target_alias="b")
    rid = req["request_id"]
    r1 = await client.post(f"/api/requests/{rid}/respond",
                           json={"responder_agent_id": b["agent_id"], "response": "first"})
    assert r1.status_code == 200 and r1.json()["status"] == "answered"
    r2 = await client.post(f"/api/requests/{rid}/respond",
                           json={"responder_agent_id": b["agent_id"], "response": "second"})
    assert r2.status_code == 200, r2.text
    assert r2.json()["status"] == "answered"
    assert r2.json().get("already_answered") is True
    assert r2.json()["response"] == "first"   # original preserved; retry never overwrites
    # a wrong actor on an answered request is still a genuine 403
    intruder = await make_agent("c", "eng")
    bad = await client.post(f"/api/requests/{rid}/respond",
                            json={"responder_agent_id": intruder["agent_id"], "response": "x"})
    assert bad.status_code == 403, bad.text


async def test_close_idempotent_repeat_returns_closed(client, make_agent, make_request):
    """A repeat close by the requester returns 200, not 409; wrong actor stays 403."""
    a = await make_agent("a", "eng")
    b = await make_agent("b", "eng")
    req = await make_request(a["agent_id"], "q", target_alias="b")
    rid = req["request_id"]
    await client.post(f"/api/requests/{rid}/respond",
                      json={"responder_agent_id": b["agent_id"], "response": "answer"})
    c1 = await client.post(f"/api/requests/{rid}/close",
                           json={"requester_agent_id": a["agent_id"]})
    assert c1.status_code == 200 and c1.json()["status"] == "closed"
    c2 = await client.post(f"/api/requests/{rid}/close",
                           json={"requester_agent_id": a["agent_id"]})
    assert c2.status_code == 200, c2.text
    assert c2.json()["status"] == "closed" and c2.json().get("already_closed") is True
    bad = await client.post(f"/api/requests/{rid}/close",
                            json={"requester_agent_id": b["agent_id"]})
    assert bad.status_code == 403, bad.text


async def test_respond_to_closed_still_409(client, make_agent, make_request):
    """Idempotency is only for the SAME terminal op — re-answering a CLOSED request
    is a genuine illegal transition and stays 409."""
    a = await make_agent("a", "eng")
    b = await make_agent("b", "eng")
    req = await make_request(a["agent_id"], "q", target_alias="b")
    rid = req["request_id"]
    await client.post(f"/api/requests/{rid}/respond",
                      json={"responder_agent_id": b["agent_id"], "response": "answer"})
    await client.post(f"/api/requests/{rid}/close",
                      json={"requester_agent_id": a["agent_id"]})
    r = await client.post(f"/api/requests/{rid}/respond",
                          json={"responder_agent_id": b["agent_id"], "response": "again"})
    assert r.status_code == 409, r.text
