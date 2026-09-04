"""Plan gating (Orcha Cloud local run — docs/orcha-cloud-local-run.md,
'Addendum — plan gating').

Local run is the free SOLO tier (default, no env set); hosted boxes set
ORCHA_PLAN=team. GET /api/plan reports the active plan + feature flags +
upgrade_url; the three member MUTATION routes (POST/PATCH/DELETE) 402 under
solo with the {premium, message, upgrade_url} detail shape, and work
unchanged under team. Roster GET stays open under both plans.
"""
import pytest


@pytest.fixture
def solo_plan(monkeypatch):
    monkeypatch.delenv("ORCHA_PLAN", raising=False)


@pytest.fixture
def team_plan(monkeypatch):
    monkeypatch.setenv("ORCHA_PLAN", "team")


async def _make_human(make_agent):
    return await make_agent("root", "operator", kind="human")


# ---------- GET /api/plan ----------

async def test_plan_solo_default(client, solo_plan):
    r = await client.get("/api/plan")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["plan"] == "solo"
    assert body["features"] == {"members": False}
    assert body["upgrade_url"] == "https://orcha.nursoftai.com/#pricing"


async def test_plan_team(client, team_plan):
    r = await client.get("/api/plan")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["plan"] == "team"
    assert body["features"] == {"members": True}
    assert body["upgrade_url"] == "https://orcha.nursoftai.com/#pricing"


async def test_plan_unknown_value_defaults_solo(client, monkeypatch):
    monkeypatch.setenv("ORCHA_PLAN", "enterprise-deluxe")
    r = await client.get("/api/plan")
    assert r.status_code == 200, r.text
    assert r.json()["plan"] == "solo"


async def test_plan_custom_upgrade_url(client, monkeypatch):
    monkeypatch.setenv("ORCHA_UPGRADE_URL", "https://example.com/upgrade")
    r = await client.get("/api/plan")
    assert r.status_code == 200, r.text
    assert r.json()["upgrade_url"] == "https://example.com/upgrade"


# ---------- member mutations: 402 under solo ----------

async def test_member_invite_402_under_solo(client, container, make_agent, solo_plan):
    root = await _make_human(make_agent)
    r = await client.post(
        f"/api/containers/{container['id']}/members",
        json={"github_login": "hubot", "role": "member", "actor_agent_id": root["agent_id"]},
    )
    assert r.status_code == 402, r.text
    detail = r.json()["detail"]
    assert detail["premium"] == "members"
    assert isinstance(detail["message"], str) and "Team" in detail["message"]
    assert detail["upgrade_url"] == "https://orcha.nursoftai.com/#pricing"


async def test_member_patch_402_under_solo(client, container, make_agent, solo_plan):
    root = await _make_human(make_agent)
    # some aid — the 402 must fire before any DB lookup / 404 path
    r = await client.patch(
        f"/api/containers/{container['id']}/members/{root['agent_id']}",
        json={"role": "viewer", "actor_agent_id": root["agent_id"]},
    )
    assert r.status_code == 402, r.text
    assert r.json()["detail"]["premium"] == "members"


async def test_member_delete_402_under_solo(client, container, make_agent, solo_plan):
    root = await _make_human(make_agent)
    r = await client.request(
        "DELETE",
        f"/api/containers/{container['id']}/members/{root['agent_id']}",
        json={"actor_agent_id": root["agent_id"]},
    )
    assert r.status_code == 402, r.text
    assert r.json()["detail"]["premium"] == "members"


async def test_roster_get_stays_open_under_solo(client, container, make_agent, solo_plan):
    root = await _make_human(make_agent)
    r = await client.get(f"/api/containers/{container['id']}/members")
    assert r.status_code == 200, r.text
    logins = [m["agent_id"] for m in r.json()["members"]]
    assert root["agent_id"] in logins


# ---------- member mutations: unchanged under team ----------

async def test_member_invite_works_under_team(client, container, make_agent, team_plan):
    root = await _make_human(make_agent)
    r = await client.post(
        f"/api/containers/{container['id']}/members",
        json={"github_login": "hubot", "role": "member", "actor_agent_id": root["agent_id"]},
    )
    assert r.status_code == 201, r.text
    assert r.json()["github_login"] == "hubot"


async def test_member_patch_works_under_team(client, container, make_agent, team_plan):
    root = await _make_human(make_agent)
    r = await client.post(
        f"/api/containers/{container['id']}/members",
        json={"github_login": "hubot", "role": "member", "actor_agent_id": root["agent_id"]},
    )
    assert r.status_code == 201, r.text
    aid = r.json()["agent_id"]
    r = await client.patch(
        f"/api/containers/{container['id']}/members/{aid}",
        json={"role": "viewer", "actor_agent_id": root["agent_id"]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["member_role"] == "viewer"


async def test_member_delete_works_under_team(client, container, make_agent, team_plan):
    root = await _make_human(make_agent)
    r = await client.post(
        f"/api/containers/{container['id']}/members",
        json={"github_login": "hubot", "role": "member", "actor_agent_id": root["agent_id"]},
    )
    assert r.status_code == 201, r.text
    aid = r.json()["agent_id"]
    r = await client.request(
        "DELETE",
        f"/api/containers/{container['id']}/members/{aid}",
        json={"actor_agent_id": root["agent_id"]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "terminated"


async def test_roster_get_stays_open_under_team(client, container, make_agent, team_plan):
    root = await _make_human(make_agent)
    r = await client.get(f"/api/containers/{container['id']}/members")
    assert r.status_code == 200, r.text
    logins = [m["agent_id"] for m in r.json()["members"]]
    assert root["agent_id"] in logins
