"""Project objective editing — PUT /api/containers/{cid}/objective.

Contract under test:
  * {objective: "<text>"} stores the objective on containers.description (what the
    Overview summary and the snapshot `container.description` show) and mirrors it onto
    the root task's description, as template apply does; the goal chain reads it.
  * {objective: null} / blank clears it; the root description falls back to the project
    name, which the goal chain treats as "no objective".
  * Authorised like the other project-setting writes (the icon): trusted lane = owner or a
    manage_autonomy holder; plain members, viewers and non-members are refused (403) and
    nothing changes. Trust off stays open. Every real change is audit-logged.
  * The route is part of the API contract (/openapi.json).
"""
import pytest


OCTO = {"X-Auth-Request-User": "octocat"}
HUBOT = {"X-Auth-Request-User": "hubot"}
VERA = {"X-Auth-Request-User": "vera"}
MALLORY = {"X-Auth-Request-User": "mallory"}


@pytest.fixture(autouse=True)
def _team_plan(monkeypatch):
    monkeypatch.setenv("ORCHA_PLAN", "team")


@pytest.fixture
def trust_proxy(monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")


@pytest.fixture
def no_trust_proxy(monkeypatch):
    monkeypatch.delenv("ORCHA_TRUST_PROXY_USER", raising=False)


async def _bind_owner(client, container, make_agent):
    await make_agent("root", "operator", kind="human")
    r = await client.get(f"/api/me?cid={container['id']}", headers=OCTO)
    assert r.status_code == 200, r.text


async def _invite(client, cid, login, role="member"):
    r = await client.post(
        f"/api/containers/{cid}/members", json={"github_login": login, "role": role}, headers=OCTO,
    )
    assert r.status_code == 201, r.text
    return r.json()["agent_id"]


async def _put(client, cid, objective, headers=None):
    return await client.put(
        f"/api/containers/{cid}/objective", json={"objective": objective}, headers=headers or {},
    )


def _stored(db, cid):
    return db.execute(
        "SELECT c.description, rt.description AS root_desc FROM containers c "
        "LEFT JOIN tasks rt ON rt.id = c.root_task_id WHERE c.id=%s", (cid,),
    )[0]


async def test_set_shows_on_snapshot_goal_chain_and_root(client, container, make_task, no_trust_proxy, db):
    cid = container["id"]
    r = await _put(client, cid, "  Ship a checkout that never oversells.  ")
    assert r.status_code == 200, r.text
    assert r.json() == {"container_id": cid, "objective": "Ship a checkout that never oversells."}
    row = _stored(db, cid)
    assert row["description"] == "Ship a checkout that never oversells."
    assert row["root_desc"] == "Ship a checkout that never oversells."

    snap = (await client.get(f"/api/containers/{cid}")).json()
    assert snap["container"]["description"] == "Ship a checkout that never oversells."

    tid = (await make_task("Clamp cart qty", "qty never exceeds 10"))["id"]
    chain = (await client.get(f"/api/tasks/{tid}/goal-chain")).json()["goal_chain"]
    obj = next(n for n in chain if n["kind"] == "objective")
    assert obj["text"] == "Ship a checkout that never oversells."
    assert obj["source"] == "project_description"

    # edit again, then clear: the goal chain says "no objective" instead of the old text
    r = await _put(client, cid, "Ship checkout v2")
    assert r.json()["objective"] == "Ship checkout v2"
    r = await _put(client, cid, None)
    assert r.status_code == 200 and r.json()["objective"] is None
    row = _stored(db, cid)
    assert row["description"] is None and row["root_desc"] == container["name"]
    chain = (await client.get(f"/api/tasks/{tid}/goal-chain")).json()["goal_chain"]
    assert next(n for n in chain if n["kind"] == "objective")["text"] is None

    r = await _put(client, cid, "   ")
    assert r.status_code == 200 and r.json()["objective"] is None

    events = db.execute(
        "SELECT detail FROM events WHERE container_id=%s AND event_type='project_objective_changed' ORDER BY id",
        (cid,),
    )
    # the blank write after a clear changed nothing, so it is not logged
    assert [e["detail"]["to"] for e in events] == ["Ship a checkout that never oversells.", "Ship checkout v2", None]


async def test_too_long_is_413_and_bad_ids(client, container, no_trust_proxy, db):
    # the app answers over-length fields with a concise 413 (application_lifecycle)
    r = await _put(client, container["id"], "x" * 4001)
    assert r.status_code == 413
    assert (await _put(client, container["id"], "x" * 4000)).status_code == 200
    assert (await _put(client, container["id"], None)).status_code == 200
    assert _stored(db, container["id"])["description"] is None
    assert (await _put(client, "not-a-uuid", "x")).status_code == 400
    assert (await _put(client, "3f2b8c1e-5a4d-4e0b-9c7a-1d2e3f4a5b6c", "x")).status_code == 404


async def test_trusted_lane_owner_and_grant_holder_may_set(client, container, make_agent, trust_proxy):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    assert (await _put(client, cid, "Owner's objective", OCTO)).status_code == 200

    hubot = await _invite(client, cid, "hubot")
    r = await _put(client, cid, "member edit", HUBOT)
    assert r.status_code == 403, "a plain member may not change the project objective"
    r = await client.patch(
        f"/api/containers/{cid}/members/{hubot}", json={"grants": ["manage_autonomy"]}, headers=OCTO,
    )
    assert r.status_code == 200, r.text
    r = await _put(client, cid, "Granted member's objective", HUBOT)
    assert r.status_code == 200, r.text
    snap = (await client.get(f"/api/containers/{cid}", headers=OCTO)).json()
    assert snap["container"]["description"] == "Granted member's objective"


async def test_trusted_lane_viewer_and_stranger_refused(client, container, make_agent, trust_proxy, db):
    cid = container["id"]
    await _bind_owner(client, container, make_agent)
    await _invite(client, cid, "vera", role="viewer")
    assert (await _put(client, cid, "viewer edit", VERA)).status_code == 403
    assert (await _put(client, cid, "stranger edit", MALLORY)).status_code == 403
    assert _stored(db, cid)["description"] is None


async def test_route_is_in_openapi(client):
    spec = (await client.get("/openapi.json")).json()
    op = spec["paths"]["/api/containers/{cid}/objective"]["put"]
    assert "requestBody" in op
    schemas = spec["components"]["schemas"]
    assert "objective" in schemas["ContainerObjectiveUpdate"]["properties"]
    assert "objective" in schemas["ContainerObjectiveResponse"]["properties"]
