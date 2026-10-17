"""Configurable agent limit (mig 056 + GET/PUT /api/containers/{cid}/limits).

Contract under test:
  * New projects start with containers.max_auto_agents = 12 (mig 056 only changes the
    column DEFAULT — it never rewrites an existing row's value).
  * The snapshot `container` carries max_auto_agents + auto_agents_in_use (live AI agents
    created from suggestions — exactly what the decide cap check counts).
  * GET …/limits: any member reads (viewers too). PUT …/limits {max_auto_agents: 1..50,
    actor_agent_id}: owner or manage_agents on the trusted lane; viewers / plain members /
    strangers refused; a non-human actor refused; out-of-range 422; audit-logged.
  * The decide 409 at the cap is human-readable (no path, no status), and raising the
    limit unblocks the same approval.
"""
from pathlib import Path

import pytest

OCTO = {"X-Auth-Request-User": "octocat"}
HUBOT = {"X-Auth-Request-User": "hubot"}
VERA = {"X-Auth-Request-User": "vera"}
MALLORY = {"X-Auth-Request-User": "mallory"}

MIG = (Path(__file__).resolve().parents[1] / "orcha-cli" / "orcha_cli" / "templates"
       / "migrations" / "056_max_auto_agents_default.sql")


@pytest.fixture(autouse=True)
def _team_plan(monkeypatch):
    monkeypatch.setenv("ORCHA_PLAN", "team")


@pytest.fixture
def trust_proxy(monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")


@pytest.fixture
def no_trust_proxy(monkeypatch):
    monkeypatch.delenv("ORCHA_TRUST_PROXY_USER", raising=False)


def _task_payload(title="do work", dod="done"):
    return {"title": title, "definition_of_done": dod, "priority": 100}


async def _put(client, cid, value, actor, headers=None):
    return await client.put(
        f"/api/containers/{cid}/limits",
        json={"max_auto_agents": value, "actor_agent_id": actor},
        headers=headers or {},
    )


# ---- default (migration) -------------------------------------------------------------

def test_migration_only_changes_the_default():
    sql = "\n".join(l for l in MIG.read_text().splitlines() if not l.strip().startswith("--"))
    assert "SET DEFAULT 12" in sql
    assert "UPDATE" not in sql.upper(), "mig 056 must not rewrite existing rows"


async def test_new_project_defaults_to_12(client, container, no_trust_proxy, db):
    row = db.execute("SELECT max_auto_agents FROM containers WHERE id=%s", (container["id"],))[0]
    assert row["max_auto_agents"] == 12
    col = db.column("containers", "max_auto_agents")
    assert col["column_default"] == "12"


async def test_snapshot_exposes_limit_and_in_use(client, container, make_agent, no_trust_proxy, db):
    cid = container["id"]
    a = await make_agent("a", "eng")
    await make_agent("hand", "eng")
    await make_agent("root", "operator", kind="human")
    db.execute("UPDATE agents SET is_auto_created=true WHERE id=%s", (a["agent_id"],))
    c = (await client.get(f"/api/containers/{cid}")).json()["container"]
    assert c["max_auto_agents"] == 12
    assert c["auto_agents_in_use"] == 1  # humans / hand-made agents never count


# ---- read / write --------------------------------------------------------------------

async def test_get_and_put_round_trip_with_audit(client, container, make_agent, no_trust_proxy, db):
    cid = container["id"]
    human = await make_agent("root", "operator", kind="human")
    r = await client.get(f"/api/containers/{cid}/limits")
    assert r.status_code == 200, r.text
    assert r.json()["max_auto_agents"] == 12 and r.json()["auto_agents_in_use"] == 0

    r = await _put(client, cid, 20, human["agent_id"])
    assert r.status_code == 200, r.text
    assert r.json()["max_auto_agents"] == 20
    assert db.execute("SELECT max_auto_agents FROM containers WHERE id=%s", (cid,))[0]["max_auto_agents"] == 20
    snap = (await client.get(f"/api/containers/{cid}")).json()["container"]
    assert snap["max_auto_agents"] == 20

    ev = db.execute(
        "SELECT actor_id, detail FROM events WHERE container_id=%s AND event_type='agent_limit_changed'",
        (cid,),
    )
    assert len(ev) == 1
    assert ev[0]["detail"] == {"max_auto_agents": 20, "previous": 12}
    assert str(ev[0]["actor_id"]) == human["agent_id"]


@pytest.mark.parametrize("value", [0, -1, 51, 1000, "many", None])
async def test_out_of_range_is_422(client, container, make_agent, no_trust_proxy, db, value):
    cid = container["id"]
    human = await make_agent("root", "operator", kind="human")
    r = await _put(client, cid, value, human["agent_id"])
    assert r.status_code == 422, r.text
    assert db.execute("SELECT max_auto_agents FROM containers WHERE id=%s", (cid,))[0]["max_auto_agents"] == 12


async def test_bounds_accepted(client, container, make_agent, no_trust_proxy):
    human = await make_agent("root", "operator", kind="human")
    for v in (1, 50):
        r = await _put(client, container["id"], v, human["agent_id"])
        assert r.status_code == 200 and r.json()["max_auto_agents"] == v


async def test_an_agent_cannot_raise_its_own_cap(client, container, make_agent, no_trust_proxy, db):
    ai = await make_agent("a", "eng")
    r = await _put(client, container["id"], 50, ai["agent_id"])
    assert r.status_code == 403, r.text
    r = await client.put(f"/api/containers/{container['id']}/limits", json={"max_auto_agents": 50})
    assert r.status_code == 422, "actor_agent_id is required"
    assert db.execute("SELECT max_auto_agents FROM containers WHERE id=%s",
                      (container["id"],))[0]["max_auto_agents"] == 12


async def test_bad_container_ids(client, container, make_agent, no_trust_proxy):
    human = await make_agent("root", "operator", kind="human")
    assert (await _put(client, "nope", 5, human["agent_id"])).status_code == 400
    r = await _put(client, "3f2b8c1e-5a4d-4e0b-9c7a-1d2e3f4a5b6c", 5, human["agent_id"])
    assert r.status_code == 404


async def _bind_owner(client, container, make_agent):
    owner = await make_agent("root", "operator", kind="human")
    r = await client.get(f"/api/me?cid={container['id']}", headers=OCTO)
    assert r.status_code == 200, r.text
    return owner


async def _invite(client, cid, login, role="member"):
    r = await client.post(f"/api/containers/{cid}/members",
                          json={"github_login": login, "role": role}, headers=OCTO)
    assert r.status_code == 201, r.text
    return r.json()["agent_id"]


async def test_trusted_lane_gate(client, container, make_agent, trust_proxy, db):
    cid = container["id"]
    owner = await _bind_owner(client, container, make_agent)
    r = await _put(client, cid, 15, owner["agent_id"], OCTO)
    assert r.status_code == 200, r.text

    hubot = await _invite(client, cid, "hubot")
    r = await _put(client, cid, 30, hubot, HUBOT)
    assert r.status_code == 403, "a plain member may not change the agent limit"
    # manage_autonomy is NOT enough — the limit governs agent creation (manage_agents)
    r = await client.patch(f"/api/containers/{cid}/members/{hubot}",
                           json={"grants": ["manage_autonomy"]}, headers=OCTO)
    assert r.status_code == 200, r.text
    assert (await _put(client, cid, 30, hubot, HUBOT)).status_code == 403
    r = await client.patch(f"/api/containers/{cid}/members/{hubot}",
                           json={"grants": ["manage_agents"]}, headers=OCTO)
    assert r.status_code == 200, r.text
    r = await _put(client, cid, 30, hubot, HUBOT)
    assert r.status_code == 200, r.text

    vera = await _invite(client, cid, "vera", role="viewer")
    assert (await _put(client, cid, 40, vera, VERA)).status_code == 403
    assert (await _put(client, cid, 40, owner["agent_id"], MALLORY)).status_code == 403
    assert db.execute("SELECT max_auto_agents FROM containers WHERE id=%s", (cid,))[0]["max_auto_agents"] == 30

    # viewers still READ it; strangers don't
    r = await client.get(f"/api/containers/{cid}/limits", headers=VERA)
    assert r.status_code == 200 and r.json()["max_auto_agents"] == 30
    assert (await client.get(f"/api/containers/{cid}/limits", headers=MALLORY)).status_code == 403


# ---- the decide 409 ------------------------------------------------------------------

async def test_decide_at_cap_is_readable_and_raising_unblocks(
        client, container, make_agent, make_request, no_trust_proxy, db):
    cid = container["id"]
    human = await make_agent("root", "operator", kind="human")
    a = await make_agent("a", "eng")
    b = await make_agent("b", "eng")
    db.execute("UPDATE agents SET is_auto_created=true WHERE id IN (%s, %s)", (a["agent_id"], b["agent_id"]))
    assert (await _put(client, cid, 2, human["agent_id"])).status_code == 200
    req = await make_request(a["agent_id"], "build", target_alias="b", type="task", task=_task_payload())
    await client.post(f"/api/requests/{req['request_id']}/reject-task",
                      json={"responder_agent_id": b["agent_id"], "reason": "no"})
    await client.post(f"/api/requests/{req['request_id']}/suggest-agent",
                      json={"requester_agent_id": a["agent_id"], "proposed_alias": "overflow",
                            "proposed_role": "eng", "proposed_prompt": "p", "rationale": "r"})
    d = await client.post(f"/api/agent-suggestions/{req['request_id']}/decide",
                          json={"kind": "create", "actor_agent_id": human["agent_id"]})
    assert d.status_code == 409, d.text
    msg = d.json()["detail"]
    assert "already has 2 suggested agents" in msg and "the limit is 2" in msg
    assert "/api/" not in msg and "409" not in msg

    assert (await _put(client, cid, 3, human["agent_id"])).status_code == 200
    d = await client.post(f"/api/agent-suggestions/{req['request_id']}/decide",
                          json={"kind": "create", "actor_agent_id": human["agent_id"]})
    assert d.status_code == 200, d.text
    lim = (await client.get(f"/api/containers/{cid}/limits")).json()
    assert lim == {"container_id": cid, "max_auto_agents": 3, "auto_agents_in_use": 3,
                   "min_max_auto_agents": 1, "max_max_auto_agents": 50}


async def test_routes_are_in_openapi(client):
    spec = (await client.get("/openapi.json")).json()
    ops = spec["paths"]["/api/containers/{cid}/limits"]
    assert "get" in ops and "requestBody" in ops["put"]
