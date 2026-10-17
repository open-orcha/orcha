from conftest import ts_ago
"""PS-36: a human's untargeted ask is never routed back to the asker — it goes to
another human who can act, or 409 when nobody else can."""


async def test_human_untargeted_ask_goes_to_someone_else(client, container, make_agent, db):
    cid = container["id"]
    gina = (await make_agent("gina", kind="human"))["agent_id"]
    maya = (await make_agent("maya", kind="human"))["agent_id"]
    # gina has the freshest heartbeat — the plain ranking would pick her
    db.execute("UPDATE agents SET last_heartbeat_at=now() WHERE id=%s", (gina,))
    db.execute(f"UPDATE agents SET last_heartbeat_at={ts_ago(3600)} WHERE id=%s", (maya,))
    r = await client.post(f"/api/containers/{cid}/requests",
                          json={"requester_agent_id": gina, "payload": "who owns billing?", "type": "info"})
    assert r.status_code == 201, r.text
    row = db.execute("SELECT target_id FROM requests WHERE id=%s", (r.json()["request_id"],))[0]
    assert str(row["target_id"]) == maya


async def test_only_human_asking_untargeted_is_409(client, container, make_agent):
    cid = container["id"]
    solo = (await make_agent("solo", kind="human"))["agent_id"]
    r = await client.post(f"/api/containers/{cid}/requests",
                          json={"requester_agent_id": solo, "payload": "anyone?", "type": "info"})
    assert r.status_code == 409, r.text


async def test_ai_untargeted_ask_still_goes_to_the_human(client, container, make_agent, db):
    cid = container["id"]
    h = (await make_agent("boss", kind="human"))["agent_id"]
    ai = (await make_agent("Scout"))["agent_id"]
    r = await client.post(f"/api/containers/{cid}/requests",
                          json={"requester_agent_id": ai, "payload": "need a key", "type": "info"})
    assert r.status_code == 201, r.text
    assert str(db.execute("SELECT target_id FROM requests WHERE id=%s", (r.json()["request_id"],))[0]["target_id"]) == h
