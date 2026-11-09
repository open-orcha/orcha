"""A task's own "Send to Quality when finished": a person's choice, which beats the project's
trigger either way, and carries its platform and device to the request."""

import pytest

from portal_backend import qa_handoff
from test_qa_handoff import done, task  # noqa: F401
from test_qa_handoff import team  # noqa: F401 - the fixture


@pytest.fixture(autouse=True)
def inline(monkeypatch):
    monkeypatch.setattr(qa_handoff, "BACKGROUND", False)


async def choose(team, tid, actor=None, status=200, **body):
    r = await team["client"].put(f"/api/tasks/{tid}/qa/on-done", json={"actor_agent_id": actor or team["human"], **body})
    assert r.status_code == status, r.text
    return r.json()


async def test_a_persons_choice_sends_the_task_with_its_device_when_it_finishes(team, db):
    tid = await task(team)
    out = await choose(team, tid, enabled=True, platform="ios", device="iPhone 17 Pro")
    assert out["on_done"]["enabled"] is True and out["on_done"]["device"] == "iPhone 17 Pro" and out["on_done"]["by"] == team["human"]
    assert (await team["client"].get(f"/api/tasks/{tid}/qa")).json()["on_done"]["platform"] == "ios"
    await done(team, tid, team["dev"])
    rows = db.execute("SELECT platform, device, origin, approved_by_agent_id, acceptance FROM qa_requests WHERE source_task_id=%s", (tid,))
    assert len(rows) == 1
    assert (rows[0]["platform"], rows[0]["device"], rows[0]["origin"]) == ("ios", "iPhone 17 Pro", "handoff")
    assert str(rows[0]["approved_by_agent_id"]) == team["human"]  # the person who turned it on approved the plan
    assert "The total shows the discount" in str(rows[0]["acceptance"])


async def test_off_beats_the_projects_always_trigger_and_clearing_follows_it_again(team, db):
    await team["client"].put(f"/api/containers/{team['cid']}/qa/settings", json={"actor_agent_id": team["human"], "trigger": "always"})
    tid = await task(team)
    await choose(team, tid, enabled=False)
    await done(team, tid, team["dev"])
    assert db.execute("SELECT count(*) AS n FROM qa_requests WHERE source_task_id=%s", (tid,))[0]["n"] == 0
    other = await task(team, title="Second")
    await choose(team, other, enabled=True)
    assert (await choose(team, other, enabled=None))["on_done"] is None
    await done(team, other, team["dev"])
    assert [r["origin"] for r in db.execute("SELECT origin FROM qa_requests WHERE source_task_id=%s", (other,))] == ["trigger"]


async def test_nothing_is_sent_without_a_choice_on_a_manual_project(team, db):
    tid = await task(team)
    assert (await team["client"].get(f"/api/tasks/{tid}/qa")).json()["on_done"] is None
    await done(team, tid, team["dev"])
    assert db.execute("SELECT count(*) AS n FROM qa_requests WHERE source_task_id=%s", (tid,))[0]["n"] == 0


async def test_only_a_person_chooses_and_only_for_a_task_with_work(team, db):
    tid = await task(team)
    await choose(team, tid, actor=team["dev"], status=403, enabled=True)
    root = db.execute("SELECT id FROM tasks WHERE container_id=%s AND is_root", (team["cid"],))[0]["id"]
    await choose(team, str(root), status=409, enabled=True)
    db.execute("UPDATE tasks SET status='cancelled' WHERE id=%s", (tid,))
    await choose(team, tid, status=409, enabled=True)
