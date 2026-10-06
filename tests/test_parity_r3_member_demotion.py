"""Parity r3 (e2e-permissions-24): demoting a member to VIEWER must not leave work
parked on a read-only user.

A viewer can never answer a request or verify a task (every viewer write 403s), so
PATCH /api/containers/{cid}/members/{aid} with role=viewer now mirrors remove_member:
  * tasks naming the member as reviewer revert to reviewer=anyone;
  * their OPEN requests move to a human who can act (guards.find_actionable_human),
    stamped detail.rerouted_from_alias;
  * both are recorded on the member_role_changed audit event and echoed back.
"""

import pytest

OCTO = {"X-Auth-Request-User": "octocat"}   # bound owner


@pytest.fixture(autouse=True)
def _team_plan(monkeypatch):
    monkeypatch.setenv("ORCHA_PLAN", "team")  # member mutations are a Team-plan feature


@pytest.fixture
def trust_proxy(monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")


async def _owner_and_member(client, container, make_agent):
    await make_agent("root", "operator", kind="human")
    r = await client.get(f"/api/me?cid={container['id']}", headers=OCTO)
    assert r.status_code == 200, r.text
    owner_id = r.json()["identity"]["agent_id"]
    r = await client.post(
        f"/api/containers/{container['id']}/members",
        json={"github_login": "maya", "role": "member"},
        headers=OCTO,
    )
    assert r.status_code == 201, r.text
    return owner_id, r.json()["agent_id"]


async def test_demote_to_viewer_clears_reviews_and_reroutes_open_requests(
    client, db, container, make_agent, make_request, make_task, trust_proxy
):
    cid = container["id"]
    owner_id, maya_id = await _owner_and_member(client, container, make_agent)
    worker = await make_agent("scout", "eng")
    t = await make_task("Ship it", "shipped")
    db.execute("UPDATE tasks SET reviewer_agent_id=%s WHERE id=%s", (maya_id, t["id"]))
    ask = await make_request(worker["agent_id"], "which db?", target_alias="maya")
    done = await make_request(worker["agent_id"], "old q", target_alias="maya")
    db.execute("UPDATE requests SET status='closed' WHERE id=%s", (done["request_id"],))

    r = await client.patch(f"/api/containers/{cid}/members/{maya_id}",
                           json={"role": "viewer"}, headers=OCTO)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["member_role"] == "viewer"
    assert body["cleared_reviewer_on"] == [t["id"]]
    assert [m["request_id"] for m in body["rerouted_requests"]] == [ask["request_id"]]
    assert body["rerouted_requests"][0]["to_agent_id"] == owner_id
    assert body["unrouted_requests"] == []

    # the task's review is back to anyone; the open ask is on the owner, stamped
    row = db.execute("SELECT reviewer_agent_id FROM tasks WHERE id=%s", (t["id"],))[0]
    assert row["reviewer_agent_id"] is None
    req = db.execute("SELECT target_id, detail FROM requests WHERE id=%s", (ask["request_id"],))[0]
    assert str(req["target_id"]) == owner_id
    assert req["detail"]["rerouted_from_alias"] == "maya"
    # a closed request is history — left alone
    old = db.execute("SELECT target_id FROM requests WHERE id=%s", (done["request_id"],))[0]
    assert str(old["target_id"]) == maya_id

    # the audit event carries both
    ev = db.execute(
        "SELECT detail FROM events WHERE entity_id=%s AND event_type='member_role_changed'",
        (maya_id,),
    )[-1]["detail"]
    assert ev["to"] == "viewer"
    assert ev["cleared_reviewer_on"] == [t["id"]]
    assert ev["rerouted_requests"][0]["request_id"] == ask["request_id"]
    assert db.execute(
        "SELECT 1 FROM events WHERE entity_id=%s AND event_type='rerouted'", (ask["request_id"],)
    )


async def test_human_ask_is_not_rerouted_back_to_its_requester(
    client, db, container, make_agent, make_request, trust_proxy
):
    cid = container["id"]
    owner_id, maya_id = await _owner_and_member(client, container, make_agent)
    # a third actionable human — the owner's own ask must land on them, not "you -> you"
    r = await client.post(f"/api/containers/{cid}/members",
                          json={"github_login": "zed", "role": "member"}, headers=OCTO)
    assert r.status_code == 201, r.text
    zed_id = r.json()["agent_id"]
    ask = await make_request(owner_id, "can you check?", target_alias="maya")

    r = await client.patch(f"/api/containers/{cid}/members/{maya_id}",
                           json={"role": "viewer"}, headers=OCTO)
    assert r.status_code == 200, r.text
    req = db.execute("SELECT target_id FROM requests WHERE id=%s", (ask["request_id"],))[0]
    assert str(req["target_id"]) == zed_id


async def test_role_change_that_is_not_to_viewer_leaves_work_alone(
    client, db, container, make_agent, make_request, make_task, trust_proxy
):
    cid = container["id"]
    owner_id, maya_id = await _owner_and_member(client, container, make_agent)
    worker = await make_agent("scout", "eng")
    t = await make_task("Ship it", "shipped")
    db.execute("UPDATE tasks SET reviewer_agent_id=%s WHERE id=%s", (maya_id, t["id"]))
    ask = await make_request(worker["agent_id"], "q", target_alias="maya")

    r = await client.patch(f"/api/containers/{cid}/members/{maya_id}",
                           json={"role": "owner"}, headers=OCTO)
    assert r.status_code == 200, r.text
    assert "rerouted_requests" not in r.json()
    row = db.execute("SELECT reviewer_agent_id FROM tasks WHERE id=%s", (t["id"],))[0]
    assert str(row["reviewer_agent_id"]) == maya_id
    req = db.execute("SELECT target_id FROM requests WHERE id=%s", (ask["request_id"],))[0]
    assert str(req["target_id"]) == maya_id
