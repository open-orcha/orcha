"""GH #24 — /orcha-pause and /orcha-stop must actually block mutating AGENT endpoints.

Container status (paused/stopped) was settable but decorative: mutating agent endpoints
still succeeded. `_require_container_active(cur, cid, actor)` now rejects AI-actor mutations
with 409 on a paused ('paused') or stopped ('completed'/'cancelled'/'failed') container,
while still allowing: reads, the human/resume path, and human-actor mutations (the human
stays authoritative). Unattributed human free-text posts (author None) also stay allowed.
"""
import uuid

import pytest


async def _set_status(client, cid, status, human_id):
    r = await client.post(f"/api/containers/{cid}/status",
                          json={"status": status, "actor_agent_id": human_id})
    assert r.status_code == 200, r.text
    return r


# ---------- paused blocks the core agent-mutation set ----------

@pytest.mark.asyncio
async def test_paused_blocks_agent_next_then_resume_restores(client, container, make_agent, make_task):
    human = await make_agent("Boss", "human", kind="human")
    a = await make_agent("Worker", "eng")
    aid = a["agent_id"]
    t = await make_task("free task", "dod")                  # unassigned -> ready
    ar = await client.post(f"/api/tasks/{t['id']}/assign",
                           json={"actor_agent_id": human["agent_id"], "agent_id": aid})
    assert ar.status_code == 200 and ar.json()["status"] == "ready", ar.text

    await _set_status(client, container["id"], "paused", human["agent_id"])
    r = await client.post(f"/api/agents/{aid}/next")
    assert r.status_code == 409, r.text
    assert "paused" in r.text and "resumed" in r.text

    await _set_status(client, container["id"], "active", human["agent_id"])  # resume
    r2 = await client.post(f"/api/agents/{aid}/next")
    assert r2.status_code == 200, r2.text                    # claim works again


@pytest.mark.asyncio
async def test_paused_blocks_create_request_by_agent(client, container, make_agent):
    human = await make_agent("Boss2", "human", kind="human")
    a = await make_agent("Asker", "eng")
    await make_agent("Other", "eng")

    await _set_status(client, container["id"], "paused", human["agent_id"])
    r = await client.post(f"/api/containers/{container['id']}/requests",
                          json={"requester_agent_id": a["agent_id"], "payload": "hi",
                                "type": "info", "target_alias": "Other"})
    assert r.status_code == 409, r.text

    await _set_status(client, container["id"], "active", human["agent_id"])
    r2 = await client.post(f"/api/containers/{container['id']}/requests",
                           json={"requester_agent_id": a["agent_id"], "payload": "hi",
                                 "type": "info", "target_alias": "Other"})
    assert r2.status_code == 201, r2.text


@pytest.mark.asyncio
async def test_paused_blocks_respond(client, container, make_agent):
    human = await make_agent("Boss3", "human", kind="human")
    a = await make_agent("Asker3", "eng")
    b = await make_agent("Answerer3", "eng")
    # ask while still active
    rq = await client.post(f"/api/containers/{container['id']}/requests",
                           json={"requester_agent_id": a["agent_id"], "payload": "q?",
                                 "type": "info", "target_alias": "Answerer3"})
    assert rq.status_code == 201, rq.text
    rid = rq.json()["request_id"]

    await _set_status(client, container["id"], "paused", human["agent_id"])
    r = await client.post(f"/api/requests/{rid}/respond",
                          json={"responder_agent_id": b["agent_id"], "response": "a!"})
    assert r.status_code == 409, r.text


@pytest.mark.asyncio
async def test_paused_blocks_accept_task(client, container, make_agent):
    human = await make_agent("Boss4", "human", kind="human")
    a = await make_agent("Dispatcher", "eng")
    b = await make_agent("Doer", "eng")
    rq = await client.post(f"/api/containers/{container['id']}/requests",
                           json={"requester_agent_id": a["agent_id"], "type": "task",
                                 "target_alias": "Doer", "payload": "please build X",
                                 "task": {"title": "build X", "definition_of_done": "done",
                                          "priority": 100}})
    assert rq.status_code == 201, rq.text
    rid = rq.json()["request_id"]

    await _set_status(client, container["id"], "paused", human["agent_id"])
    r = await client.post(f"/api/requests/{rid}/accept-task",
                          json={"responder_agent_id": b["agent_id"]})
    assert r.status_code == 409, r.text


@pytest.mark.asyncio
async def test_paused_blocks_done(client, container, make_agent, make_task, db):
    human = await make_agent("Boss5", "human", kind="human")
    a = await make_agent("Builder", "eng")
    aid = a["agent_id"]
    t = await make_task("ship it", "dod", assignee_alias="Builder")   # in_progress
    tid = t["id"]
    db.execute("UPDATE agent_tasks SET assignment_status='working' WHERE agent_id=%s AND task_id=%s",
               (aid, tid))

    await _set_status(client, container["id"], "paused", human["agent_id"])
    r = await client.post(f"/api/tasks/{tid}/done",
                          json={"agent_id": aid, "result": "done"})
    assert r.status_code == 409, r.text


# ---------- stopped (completed) also blocks ----------

@pytest.mark.asyncio
async def test_stopped_blocks_agent_mutation(client, container, make_agent):
    human = await make_agent("Boss6", "human", kind="human")
    a = await make_agent("Late", "eng")
    await make_agent("Peer", "eng")
    await _set_status(client, container["id"], "completed", human["agent_id"])  # /orcha-stop
    r = await client.post(f"/api/containers/{container['id']}/requests",
                          json={"requester_agent_id": a["agent_id"], "payload": "hi",
                                "type": "info", "target_alias": "Peer"})
    assert r.status_code == 409, r.text
    assert "completed" in r.text


# ---------- reads + human/resume actions stay usable while paused ----------

@pytest.mark.asyncio
async def test_reads_work_while_paused(client, container, make_agent):
    human = await make_agent("Boss7", "human", kind="human")
    a = await make_agent("Reader", "eng")
    await _set_status(client, container["id"], "paused", human["agent_id"])
    assert (await client.get(f"/api/containers/{container['id']}")).status_code == 200
    assert (await client.get(f"/api/agents/{a['agent_id']}/inbox")).status_code == 200


@pytest.mark.asyncio
async def test_human_can_cancel_task_while_paused(client, container, make_agent, make_task):
    """Human stays authoritative on a paused container — can cancel; the agent cannot."""
    human = await make_agent("Boss8", "human", kind="human")
    a = await make_agent("Owner", "eng")
    t = await make_task("scrap me", "dod", assignee_alias="Owner")
    tid = t["id"]
    await _set_status(client, container["id"], "paused", human["agent_id"])

    # the assigned AGENT is blocked
    r_ai = await client.post(f"/api/tasks/{tid}/cancel",
                             json={"actor_agent_id": a["agent_id"], "reason": "nope"})
    assert r_ai.status_code == 409, r_ai.text
    # the HUMAN still cancels
    r_h = await client.post(f"/api/tasks/{tid}/cancel",
                            json={"actor_agent_id": human["agent_id"], "reason": "container paused"})
    assert r_h.status_code == 200, r_h.text


@pytest.mark.asyncio
async def test_human_freetext_post_allowed_while_paused(client, container, make_agent, make_task):
    """post_message with author None (human free-text) is allowed; an AI author is blocked."""
    human = await make_agent("Boss9", "human", kind="human")
    a = await make_agent("Poster", "eng")
    aid = a["agent_id"]
    t = await make_task("threaded", "dod", assignee_alias="Poster")
    tid = t["id"]
    await _set_status(client, container["id"], "paused", human["agent_id"])

    # AI author blocked
    r_ai = await client.post(f"/api/tasks/{tid}/messages",
                             json={"author_agent_id": aid, "body": "agent note"})
    assert r_ai.status_code == 409, r_ai.text
    # human free-text (author None) still posts
    r_h = await client.post(f"/api/tasks/{tid}/messages",
                            json={"author_agent_id": None, "body": "human note"})
    assert r_h.status_code == 201, r_h.text


@pytest.mark.asyncio
async def test_resume_path_itself_works_while_paused(client, container, make_agent):
    """The status endpoint (the resume mechanism) is human-gated and never self-blocks."""
    human = await make_agent("Boss10", "human", kind="human")
    await _set_status(client, container["id"], "paused", human["agent_id"])
    # resume back to active succeeds even though the container is currently paused
    r = await client.post(f"/api/containers/{container['id']}/status",
                          json={"status": "active", "actor_agent_id": human["agent_id"]})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "active"
