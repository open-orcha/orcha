"""ISS-47 (#105): questions/decisions fragment across surfaces -> dangling threads +
ambiguous ownership.

Every request read surface now stamps a canonical next-action ownership
(owner_id / owner_alias / pending_action) plus an is_stale dangling-thread flag, so a
consumer no longer re-derives "who holds the ball" per surface. These tests pin that the
four data surfaces (inbox, outbox, container list, snapshot) agree.
"""
import uuid


async def _list_rows(client, cid):
    r = await client.get(f"/api/containers/{cid}/requests")
    assert r.status_code == 200, r.text
    return r.json()["requests"]


async def test_open_request_owner_is_target(client, make_agent, make_request, container):
    a = await make_agent("a", "eng")
    b = await make_agent("b", "eng")
    req = await make_request(a["agent_id"], "q", target_alias="b")
    rid = req["request_id"]

    # inbox (incoming side): the target owns the next action = 'answer'
    inb = (await client.get(f"/api/agents/{b['agent_id']}/inbox")).json()["open_requests"]
    row = next(x for x in inb if x["id"] == rid)
    assert row["owner_id"] == b["agent_id"]
    assert row["pending_action"] == "answer"
    assert row["is_stale"] is False

    # mixed all-request list: owner_alias resolves to the target while open
    lrow = next(x for x in await _list_rows(client, container["id"]) if x["id"] == rid)
    assert lrow["owner_id"] == b["agent_id"]
    assert lrow["owner_alias"] == "b"
    assert lrow["pending_action"] == "answer"


async def test_answered_request_owner_flips_to_requester(client, make_agent, make_request, container):
    a = await make_agent("a", "eng")
    b = await make_agent("b", "eng")
    req = await make_request(a["agent_id"], "q", target_alias="b")
    rid = req["request_id"]
    ok = await client.post(f"/api/requests/{rid}/respond",
                           json={"responder_agent_id": b["agent_id"], "response": "answer"})
    assert ok.status_code == 200, ok.text

    # outbox (answered side): now the requester owns the next action = 'close'
    out = (await client.get(f"/api/agents/{a['agent_id']}/outbox?status=answered")).json()["outgoing_requests"]
    row = next(x for x in out if x["id"] == rid)
    assert row["owner_id"] == a["agent_id"]
    assert row["pending_action"] == "close"
    assert row["is_stale"] is False

    # mixed list agrees: owner_alias flips to the requester
    lrow = next(x for x in await _list_rows(client, container["id"]) if x["id"] == rid)
    assert lrow["owner_id"] == a["agent_id"]
    assert lrow["owner_alias"] == "a"
    assert lrow["pending_action"] == "close"


async def test_closed_request_has_no_owner(client, make_agent, make_request, container):
    a = await make_agent("a", "eng")
    b = await make_agent("b", "eng")
    req = await make_request(a["agent_id"], "q", target_alias="b")
    rid = req["request_id"]
    await client.post(f"/api/requests/{rid}/respond",
                      json={"responder_agent_id": b["agent_id"], "response": "answer"})
    await client.post(f"/api/requests/{rid}/close",
                      json={"requester_agent_id": a["agent_id"]})

    lrow = next(x for x in await _list_rows(client, container["id"]) if x["id"] == rid)
    assert lrow["status"] == "closed"
    assert lrow["owner_id"] is None
    assert lrow["owner_alias"] is None
    assert lrow["pending_action"] is None
    assert lrow["is_stale"] is False


async def test_expired_open_request_is_stale_everywhere(client, make_agent, make_request, container, db):
    """A dangling thread: an open request whose target never answered before expiry."""
    a = await make_agent("a", "eng")
    b = await make_agent("b", "eng")
    req = await make_request(a["agent_id"], "q", target_alias="b")
    rid = req["request_id"]
    # the create endpoint clamps expires_minutes >= 0, so backdate the expiry directly to
    # simulate an open request that nobody answered before it lapsed.
    db.execute("UPDATE requests SET expires_at = now() - interval '1 hour' WHERE id=%s", (rid,))

    inb = (await client.get(f"/api/agents/{b['agent_id']}/inbox")).json()["open_requests"]
    assert next(x for x in inb if x["id"] == rid)["is_stale"] is True

    lrow = next(x for x in await _list_rows(client, container["id"]) if x["id"] == rid)
    assert lrow["is_stale"] is True
    assert lrow["pending_action"] == "answer"  # still the target's ball, just overdue


async def test_snapshot_requests_carry_ownership(client, make_agent, make_request, container):
    a = await make_agent("a", "eng")
    b = await make_agent("b", "eng")
    req = await make_request(a["agent_id"], "q", target_alias="b")
    rid = req["request_id"]

    snap = (await client.get(f"/api/containers/{container['id']}")).json()
    row = next(x for x in snap["requests"] if x["id"] == rid)
    assert row["owner_id"] == b["agent_id"]
    assert row["owner_alias"] == "b"
    assert row["pending_action"] == "answer"
    assert "is_stale" in row
