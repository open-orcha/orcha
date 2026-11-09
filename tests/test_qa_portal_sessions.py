"""Orcha QA portal: the Sessions view's one read of its cards, and a person stopping a session."""
import pytest
from conftest import run_task_id


@pytest.fixture
async def people(make_agent):
    human = await make_agent("Hussein", "owner", kind="human")
    bot = await make_agent("qa-bot")
    return {"human": human["agent_id"], "bot": bot["agent_id"]}


JPEG = b"\xff\xd8\xff\xe0" + b"0" * 32


async def _session(client, cid, bot, platform="ios", kind="explore"):
    r = await client.post(f"/api/containers/{cid}/qa/sessions", json={"actor_agent_id": bot, "kind": kind, "platform": platform, "task_id": await run_task_id(client, cid, bot)})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def test_digests_hold_each_sessions_findings_and_shots(client, container, people):
    cid, bot = container["id"], people["bot"]
    sid = await _session(client, cid, bot)
    other = await _session(client, cid, bot, platform="web")
    frame = (await client.post(f"/api/qa/sessions/{sid}/frames", params={"actor_agent_id": bot}, content=JPEG,
                               headers={"content-type": "image/jpeg"})).json()["frame_id"]
    r = await client.post(f"/api/qa/sessions/{sid}/steps", json={"actor_agent_id": bot, "steps": [
        {"seq": 1, "kind": "screen", "args": {"title": "Home"}, "frame_id": frame, "screen_hash": "aa"},
        {"seq": 2, "kind": "tap", "args": {}},
    ]})
    assert r.status_code == 200, r.text
    r = await client.post(f"/api/qa/sessions/{sid}/findings", json={"actor_agent_id": bot, "severity": "major", "title": "Save does nothing"})
    assert r.status_code == 201, r.text

    r = await client.get(f"/api/containers/{cid}/qa/session-digests", params={"platform": "ios"})
    assert r.status_code == 200, r.text
    digests = r.json()["digests"]
    assert set(digests) == {sid}
    d = digests[sid]
    assert d["steps_count"] == 2
    assert d["shots"] == [{"seq": 1, "frame_id": frame, "screen_hash": "aa"}]
    assert [f["title"] for f in d["findings"]] == ["Save does nothing"]
    assert d["walks"] == [] and d["drafts"] == []

    all_of_them = (await client.get(f"/api/containers/{cid}/qa/session-digests")).json()["digests"]
    assert set(all_of_them) == {sid, other}


async def test_digests_of_a_project_with_no_sessions_are_empty(client, container):
    r = await client.get(f"/api/containers/{container['id']}/qa/session-digests")
    assert r.status_code == 200 and r.json() == {"digests": {}}


async def test_a_person_can_stop_a_running_session(client, container, people):
    sid = await _session(client, container["id"], people["bot"])
    r = await client.patch(f"/api/qa/sessions/{sid}", json={"actor_agent_id": people["human"], "status": "cancelled"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "cancelled" and r.json()["ended_at"]
