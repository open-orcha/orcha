"""PS-39: the work-lane routes (/done, /next, accept-task, self-wake) act AS an AI agent.
A trusted human login holding a leaked / locally minted work token must pass the same
PS-37 machine-lane gate (owner or manage_agents) — a plain member gets 403 and the task
does not move. The header-less agent lane is unchanged."""
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
    db.execute("""UPDATE agents SET grants='["manage_agents"]'::jsonb
                   WHERE container_id=%s AND github_login='gina'""", (cid,))
    return (await make_agent("Pixel"))["agent_id"]


def _status(db, tid):
    return db.execute("SELECT status FROM tasks WHERE id=%s", (tid,))[0]["status"]


async def _claimed_task(client, make_task, pixel, tok, title, db):
    t = await make_task(title, "dod", assignee_alias="Pixel")
    r = await client.post(f"/api/agents/{pixel}/next", headers=tok)  # header-less agent lane
    assert r.status_code == 200, r.text
    assert _status(db, t['id']) == "in_progress"
    return t["id"]


async def test_member_with_leaked_token_cannot_complete_an_ai_task(
        client, container, make_agent, make_task, work_headers, db):
    pixel = await _setup(client, container, make_agent, db)
    tok = await work_headers(pixel)  # minted header-less (the daemon lane)
    tid = await _claimed_task(client, make_task, pixel, tok, "t1", db)
    done = {"agent_id": pixel, "result": "done"}

    r = await client.post(f"/api/tasks/{tid}/done", json=done, headers={**MAYA, **tok})
    assert r.status_code == 403, r.text
    assert "manage_agents" in r.json()["detail"]
    assert _status(db, tid) == "in_progress"

    # an authorized human (manage_agents) with the token may
    r = await client.post(f"/api/tasks/{tid}/done", json=done, headers={**GINA, **tok})
    assert r.status_code == 200, r.text
    assert _status(db, tid) == "needs_verification"


async def test_header_less_agent_lane_unchanged(
        client, container, make_agent, make_task, work_headers, db):
    pixel = await _setup(client, container, make_agent, db)
    tok = await work_headers(pixel)
    tid = await _claimed_task(client, make_task, pixel, tok, "t2", db)
    r = await client.post(f"/api/tasks/{tid}/done", json={"agent_id": pixel, "result": "ok"},
                          headers=tok)
    assert r.status_code == 200, r.text


async def test_member_with_leaked_token_cannot_claim_or_self_wake(
        client, container, make_agent, make_task, work_headers, db):
    pixel = await _setup(client, container, make_agent, db)
    tok = await work_headers(pixel)
    t3 = await make_task("t3", "dod", assignee_alias="Pixel")
    r = await client.post(f"/api/agents/{pixel}/next", headers={**MAYA, **tok})
    assert r.status_code == 403, r.text
    r = await client.post(f"/api/agents/{pixel}/next", headers={**OCTO, **tok})  # owner ok
    assert r.status_code == 200, r.text
    tid = t3["id"]  # assigning an AI auto-starts it (in_progress)
    wake = {"task_id": tid, "context": "resume", "delay_secs": 120}
    r = await client.post(f"/api/agents/{pixel}/self-wake", json=wake, headers={**MAYA, **tok})
    assert r.status_code == 403, r.text
    r = await client.post(f"/api/agents/{pixel}/self-wake", json=wake, headers=tok)
    assert r.status_code == 200, r.text
    r = await client.delete(f"/api/agents/{pixel}/self-wake?all=true", headers={**MAYA, **tok})
    assert r.status_code == 403, r.text
