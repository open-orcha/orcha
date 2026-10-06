"""PS-37: a trusted human acting on the MACHINE lane acts AS an AI agent (mint its work
token, start / finish its runs, claim its wake) — the audit trail then records the AI.
That is agent management: owner or manage_agents only. A plain member gets 403; the
header-less daemon/CLI lane is unchanged."""
import pytest

OCTO = {"X-Auth-Request-User": "octocat"}
MAYA = {"X-Auth-Request-User": "maya"}
GINA = {"X-Auth-Request-User": "gina"}


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("ORCHA_PLAN", "team")
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")


async def _setup(client, container, make_agent, db):
    cid = container["id"]
    await make_agent("root", "operator", kind="human")
    assert (await client.get(f"/api/me?cid={cid}", headers=OCTO)).json()["identity"]["member_role"] == "owner"
    for login in ("maya", "gina"):
        r = await client.post(f"/api/containers/{cid}/members",
                              json={"github_login": login, "role": "member"}, headers=OCTO)
        assert r.status_code == 201, r.text
    db.execute("""UPDATE agents SET grants='["manage_agents"]'
                   WHERE container_id=%s AND github_login='gina'""", (cid,))
    return (await make_agent("Pixel"))["agent_id"]


async def test_member_without_grant_cannot_act_as_an_ai(client, container, make_agent, db):
    pixel = await _setup(client, container, make_agent, db)
    mint = f"/api/agents/{pixel}/embodiment-tokens"
    body = {"lane": "work", "kind": "headless"}
    r = await client.post(mint, json=body, headers=MAYA)
    assert r.status_code == 403, r.text
    assert "manage_agents" in r.json()["detail"]
    assert (await client.post(mint, json=body, headers=GINA)).status_code == 201
    assert (await client.post(mint, json=body, headers=OCTO)).status_code == 201
    assert (await client.post(mint, json=body)).status_code == 201  # daemon lane

    # run start / finish
    r = await client.post(f"/api/agents/{pixel}/runs", json={"wake_kind": "ephemeral"}, headers=MAYA)
    assert r.status_code == 403, r.text
    r = await client.post(f"/api/agents/{pixel}/runs", json={"wake_kind": "ephemeral"})
    assert r.status_code == 201, r.text
    rid = r.json()["run_id"]
    r = await client.post(f"/api/runs/{rid}/finish", json={"status": "exited", "exit_code": 0}, headers=MAYA)
    assert r.status_code == 403, r.text
    r = await client.post(f"/api/runs/{rid}/finish", json={"status": "exited", "exit_code": 0}, headers=GINA)
    assert r.status_code == 200, r.text
