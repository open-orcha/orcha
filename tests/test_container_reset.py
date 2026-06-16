"""POST /api/containers/{cid}/reset — destructive in-place wipe (Tim's reset task).

Wipes ALL container-scoped data (agents, tasks, requests, conversations, worker runs,
memory digests, events) and recreates a single empty root task, KEEPING the containers
row so current_container_id stays valid. Doubly gated: human actor + typed confirm
(confirm == container name). In-app counterpart to the CLI `init --force --reset-data`
(which instead drops the Postgres volume).
"""
import uuid

import pytest


async def _seed(client, db, container, make_agent, make_task, make_request):
    """Populate every container-scoped table, return ids for post-reset assertions."""
    human = await make_agent("Kedar", "operator", kind="human")
    ai = await make_agent("Worker", "eng")
    cid = container["id"]
    aid = ai["agent_id"]

    task = await make_task("do a thing", "it is done", assignee_alias="Worker")
    await make_request(aid, "ping?", target_alias="Kedar")

    # conversation + turn, worker_run + line, memory digest — via direct SQL (no API path
    # needed here; we only care that reset clears them).
    conv = db.execute(
        "INSERT INTO conversations (container_id, agent_id, started_by) VALUES (%s,%s,%s) RETURNING id",
        (cid, aid, human["agent_id"]))[0]["id"]
    db.execute(
        "INSERT INTO conversation_turns (conversation_id, seq, role, author_agent_id, content) "
        "VALUES (%s,1,'human',%s,'hi')", (conv, human["agent_id"]))
    run = db.execute("INSERT INTO worker_runs (agent_id, status) VALUES (%s,'running') RETURNING run_id",
                     (aid,))[0]["run_id"]
    db.execute("INSERT INTO worker_run_lines (run_id, seq, line) VALUES (%s,1,'x')", (run,))
    db.execute(
        "INSERT INTO agent_memory_digests (container_id, agent_id, snapshot_ts, current_focus) "
        "VALUES (%s,%s,0,'d')", (cid, aid))
    return {"human": human, "ai": ai, "cid": cid, "aid": aid, "task": task}


def _counts(db, cid):
    """How many rows remain across the scoped tables (excluding the recreated root task)."""
    agents = db.execute("SELECT count(*) c FROM agents WHERE container_id=%s", (cid,))[0]["c"]
    tasks = db.execute("SELECT count(*) c FROM tasks WHERE container_id=%s", (cid,))[0]["c"]
    requests = db.execute("SELECT count(*) c FROM requests WHERE container_id=%s", (cid,))[0]["c"]
    convs = db.execute("SELECT count(*) c FROM conversations WHERE container_id=%s", (cid,))[0]["c"]
    runs = db.execute("SELECT count(*) c FROM worker_runs", ())[0]["c"]
    digests = db.execute("SELECT count(*) c FROM agent_memory_digests WHERE container_id=%s", (cid,))[0]["c"]
    return agents, tasks, requests, convs, runs, digests


@pytest.mark.asyncio
async def test_reset_wipes_everything_and_recreates_root(
        client, db, container, make_agent, make_task, make_request):
    s = await _seed(client, db, container, make_agent, make_task, make_request)
    cid = s["cid"]

    # before: data present
    agents, tasks, *_ = _counts(db, cid)
    assert agents == 2 and tasks >= 2

    r = await client.post(f"/api/containers/{cid}/reset",
                          json={"actor_agent_id": s["human"]["agent_id"], "confirm": container["name"]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["container_id"] == cid
    assert body["deleted"]["agents"] == 2
    assert body["deleted"]["requests"] == 1
    assert body["deleted"]["conversations"] == 1
    assert body["deleted"]["conversation_turns"] == 1
    assert body["deleted"]["worker_runs"] == 1
    assert body["deleted"]["worker_run_lines"] == 1
    assert body["deleted"]["agent_memory_digests"] == 1

    # after: container row KEPT, all scoped data gone
    assert db.execute("SELECT count(*) c FROM containers WHERE id=%s", (cid,))[0]["c"] == 1
    agents, tasks, requests, convs, runs, digests = _counts(db, cid)
    assert (agents, requests, convs, runs, digests) == (0, 0, 0, 0, 0)

    # exactly one task remains: the fresh, empty, ready root
    rows = db.execute("SELECT id, is_root, status FROM tasks WHERE container_id=%s", (cid,))
    assert len(rows) == 1
    assert rows[0]["is_root"] is True and rows[0]["status"] == "ready"
    assert str(rows[0]["id"]) == body["root_task_id"]
    # the container points at the new root
    rt = db.execute("SELECT root_task_id FROM containers WHERE id=%s", (cid,))[0]["root_task_id"]
    assert str(rt) == body["root_task_id"]


@pytest.mark.asyncio
async def test_reset_requires_human_actor(client, container, make_agent):
    ai = await make_agent("Bot", "eng")
    r = await client.post(f"/api/containers/{container['id']}/reset",
                          json={"actor_agent_id": ai["agent_id"], "confirm": container["name"]})
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_reset_requires_matching_confirm(client, container, make_agent):
    human = await make_agent("Kedar2", "operator", kind="human")
    r = await client.post(f"/api/containers/{container['id']}/reset",
                          json={"actor_agent_id": human["agent_id"], "confirm": "wrong-name"})
    assert r.status_code == 400, r.text
    assert container["name"] in r.text  # error names the expected confirm value


@pytest.mark.asyncio
async def test_reset_unknown_container_404(client, container, make_agent):
    human = await make_agent("Kedar3", "operator", kind="human")
    r = await client.post(f"/api/containers/{uuid.uuid4()}/reset",
                          json={"actor_agent_id": human["agent_id"], "confirm": "x"})
    assert r.status_code == 404, r.text


@pytest.mark.asyncio
async def test_reset_is_idempotent_on_empty_container(client, db, container, make_agent):
    """A reset right after another reset (no data) still succeeds with zero counts and a
    single fresh root task — no FK error, no duplicate roots."""
    human = await make_agent("Kedar4", "operator", kind="human")
    cid = container["id"]
    r1 = await client.post(f"/api/containers/{cid}/reset",
                           json={"actor_agent_id": human["agent_id"], "confirm": container["name"]})
    assert r1.status_code == 200, r1.text
    # the human used to confirm was wiped; re-register to drive a second reset
    human2 = await make_agent("Kedar5", "operator", kind="human")
    r2 = await client.post(f"/api/containers/{cid}/reset",
                           json={"actor_agent_id": human2["agent_id"], "confirm": container["name"]})
    assert r2.status_code == 200, r2.text
    assert r2.json()["deleted"]["agents"] == 1  # only Kedar5 existed at the 2nd reset
    rows = db.execute("SELECT id FROM tasks WHERE container_id=%s AND is_root=true", (cid,))
    assert len(rows) == 1
