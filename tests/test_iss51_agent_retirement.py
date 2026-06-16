"""ISS-51 — agent retirement: retire action + roster excludes retired.

POST /api/agents/{aid}/retire (human-gated) sets agents.terminated_at + status, the
container roster now filters terminated_at IS NULL (retired agents disappear), and any
task the agent was actively working is released back to 'ready' (thread retained). A
task with other active assignees stays in_progress.
"""
import uuid

import pytest


async def _container(client, cid):
    r = await client.get(f"/api/containers/{cid}")
    assert r.status_code == 200, r.text
    return r.json()


def _aliases(payload):
    return {a["alias"] for a in payload["agents"]}


def _task(payload, tid):
    return next((t for t in payload["tasks"] if t["id"] == tid), None)


@pytest.mark.asyncio
async def test_retire_sets_terminated_and_excludes_from_roster(client, container, make_agent):
    human = await make_agent("Boss", "human", kind="human")
    a = await make_agent("Gone", "eng")
    aid = a["agent_id"]

    assert "Gone" in _aliases(await _container(client, container["id"]))   # present before

    r = await client.post(f"/api/agents/{aid}/retire", json={"actor_agent_id": human["agent_id"]})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "terminated"

    assert "Gone" not in _aliases(await _container(client, container["id"]))  # gone after
    assert "Boss" in _aliases(await _container(client, container["id"]))      # others unaffected


@pytest.mark.asyncio
async def test_retire_requires_human_actor(client, container, make_agent):
    ai_actor = await make_agent("Bot", "eng")
    victim = await make_agent("Victim", "eng")
    r = await client.post(f"/api/agents/{victim['agent_id']}/retire",
                          json={"actor_agent_id": ai_actor["agent_id"]})
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_retire_unknown_agent_404(client, container, make_agent):
    human = await make_agent("Boss2", "human", kind="human")
    r = await client.post(f"/api/agents/{uuid.uuid4()}/retire",
                          json={"actor_agent_id": human["agent_id"]})
    assert r.status_code == 404, r.text


@pytest.mark.asyncio
async def test_retire_bad_uuid_400(client, container, make_agent):
    human = await make_agent("Boss3", "human", kind="human")
    r = await client.post("/api/agents/not-a-uuid/retire",
                          json={"actor_agent_id": human["agent_id"]})
    assert r.status_code == 400, r.text


@pytest.mark.asyncio
async def test_retire_idempotent(client, container, make_agent):
    human = await make_agent("Boss4", "human", kind="human")
    a = await make_agent("Twice", "eng")
    aid = a["agent_id"]
    r1 = await client.post(f"/api/agents/{aid}/retire", json={"actor_agent_id": human["agent_id"]})
    assert r1.status_code == 200
    r2 = await client.post(f"/api/agents/{aid}/retire", json={"actor_agent_id": human["agent_id"]})
    assert r2.status_code == 200 and r2.json().get("already_retired") is True


@pytest.mark.asyncio
async def test_retire_releases_in_progress_task_to_ready(client, container, make_agent, make_task, db):
    human = await make_agent("Boss5", "human", kind="human")
    a = await make_agent("Worker", "eng")
    aid = a["agent_id"]
    t = await make_task("important work", "dod", assignee_alias="Worker")  # starts in_progress
    tid = t["id"]
    db.execute("UPDATE agent_tasks SET assignment_status='working' WHERE agent_id=%s AND task_id=%s",
               (aid, tid))
    # leave a thread message to confirm it survives retirement
    await client.post(f"/api/tasks/{tid}/messages", json={"author_agent_id": aid, "body": "progress note"})

    r = await client.post(f"/api/agents/{aid}/retire", json={"actor_agent_id": human["agent_id"]})
    assert r.status_code == 200, r.text
    assert tid in r.json()["released_tasks"]

    payload = await _container(client, container["id"])
    task = _task(payload, tid)
    assert task["status"] == "ready"                       # released, reclaimable
    # ISS-68: the snapshot no longer embeds the full thread; the message_summary still
    # reflects it (count + latest), and the full thread persists via GET /tasks/{tid}/messages.
    assert task["message_summary"]["count"] >= 1
    assert task["message_summary"]["last"]["body"] == "progress note"   # thread retained
    msgs = (await client.get(f"/api/tasks/{tid}/messages")).json()["messages"]   # still readable lazily
    assert any(m["body"] == "progress note" for m in msgs)
    # the agent's assignment is gone
    rows = db.execute("SELECT 1 FROM agent_tasks WHERE agent_id=%s AND task_id=%s", (aid, tid))
    assert not rows


@pytest.mark.asyncio
async def test_retired_agent_cannot_claim_next(client, container, make_agent, make_task):
    """[P1 review fix] a retired agent must be ineligible to claim new work via /next."""
    human = await make_agent("Boss7", "human", kind="human")
    a = await make_agent("Done4Now", "eng")
    aid = a["agent_id"]
    t = await make_task("free task", "dod")                # unassigned -> ready
    ar = await client.post(f"/api/tasks/{t['id']}/assign",
                           json={"actor_agent_id": human["agent_id"], "agent_id": aid})
    assert ar.status_code == 200 and ar.json()["status"] == "ready", ar.text
    # before retirement the agent can claim
    assert (await client.post(f"/api/agents/{aid}/next")).status_code == 200

    await client.post(f"/api/agents/{aid}/retire", json={"actor_agent_id": human["agent_id"]})
    r = await client.post(f"/api/agents/{aid}/next")
    assert r.status_code == 409, r.text
    assert "retired" in r.text


@pytest.mark.asyncio
async def test_retired_agent_blocked_on_work_paths(client, container, make_agent, make_task):
    """[P1] retired agents are rejected from creating requests / accepting tasks too."""
    human = await make_agent("Boss8", "human", kind="human")
    a = await make_agent("Ex", "eng")
    other = await make_agent("Other", "eng")
    aid = a["agent_id"]
    await client.post(f"/api/agents/{aid}/retire", json={"actor_agent_id": human["agent_id"]})
    # create_request as a retired requester -> 409
    r = await client.post(f"/api/containers/{container['id']}/requests",
                          json={"requester_agent_id": aid, "payload": "hi", "type": "info",
                                "target_alias": "Other"})
    assert r.status_code == 409, r.text


@pytest.mark.asyncio
async def test_retire_preserves_done_assignment_history(client, container, make_agent, make_task, db):
    """[P2 review fix] retiring must NOT erase terminal ('done') assignment rows —
    completed-task assignee history (task.assignees) must survive."""
    human = await make_agent("Boss9", "human", kind="human")
    a = await make_agent("Veteran", "eng")
    aid = a["agent_id"]
    t = await make_task("shipped feature", "dod", assignee_alias="Veteran")
    tid = t["id"]
    db.execute("UPDATE agent_tasks SET assignment_status='done' WHERE agent_id=%s AND task_id=%s",
               (aid, tid))

    await client.post(f"/api/agents/{aid}/retire", json={"actor_agent_id": human["agent_id"]})

    # the done assignment row survives
    rows = db.execute("SELECT assignment_status FROM agent_tasks WHERE agent_id=%s AND task_id=%s",
                      (aid, tid))
    assert rows and rows[0]["assignment_status"] == "done"
    # and the task still credits the (now-retired) agent as an assignee
    task = _task(await _container(client, container["id"]), tid)
    assert "Veteran" in (task["assignees"] or [])


@pytest.mark.asyncio
async def test_retire_keeps_task_with_other_active_assignee(client, container, make_agent, make_task, db):
    human = await make_agent("Boss6", "human", kind="human")
    a = await make_agent("Leaver", "eng")
    b = await make_agent("Stayer", "eng")
    t = await make_task("shared work", "dod", assignee_alias="Leaver")
    tid = t["id"]
    # add Stayer as a second active assignee
    db.execute("INSERT INTO agent_tasks (agent_id, task_id, assignment_status) VALUES (%s,%s,'working')",
               (b["agent_id"], tid))
    db.execute("UPDATE agent_tasks SET assignment_status='working' WHERE task_id=%s", (tid,))

    r = await client.post(f"/api/agents/{a['agent_id']}/retire", json={"actor_agent_id": human["agent_id"]})
    assert r.status_code == 200, r.text
    assert tid not in r.json()["released_tasks"]            # NOT released — Stayer still on it

    task = _task(await _container(client, container["id"]), tid)
    assert task["status"] == "in_progress"
    assert "Stayer" in (task["assignees"] or [])
