"""Container lifecycle state machine (Orcha#22)."""
import pytest


async def test_create_returns_ids(client):
    r = await client.post("/api/containers", json={"name": "proj"})
    assert r.status_code == 201, r.text
    d = r.json()
    assert d["container_id"] and d["root_task_id"]


async def test_second_container_rejected_409(client, container):
    # Orcha#28: stack:db:container is 1:1:1
    r = await client.post("/api/containers", json={"name": "second"})
    assert r.status_code == 409, r.text


async def test_status_flip_active_paused_active(client, container, make_agent):
    human = await make_agent("op", "operator", kind="human")
    for target in ("paused", "active"):
        r = await client.post(
            f"/api/containers/{container['id']}/status",
            json={"status": target, "actor_agent_id": human["agent_id"]},
        )
        assert r.status_code == 200, r.text
        assert r.json()["status"] == target


async def test_invalid_status_rejected_400(client, container, make_agent):
    human = await make_agent("op", "operator", kind="human")
    r = await client.post(
        f"/api/containers/{container['id']}/status",
        json={"status": "banana", "actor_agent_id": human["agent_id"]},
    )
    assert r.status_code == 400, r.text


async def test_status_flip_is_human_only(client, container, make_agent):
    ai = await make_agent("bot", "worker")  # kind='ai'
    r = await client.post(
        f"/api/containers/{container['id']}/status",
        json={"status": "paused", "actor_agent_id": ai["agent_id"]},
    )
    assert r.status_code == 403, r.text  # Orcha#30: only humans flip container status


async def test_unknown_container_404(client):
    import uuid
    r = await client.get(f"/api/containers/{uuid.uuid4()}")
    assert r.status_code == 404, r.text


async def test_root_task_verification_completes_container(client, container, make_agent):
    human = await make_agent("op", "operator", kind="human")
    # verifying the root task (a sentinel) completes the whole container
    r = await client.post(
        f"/api/tasks/{container['root_task_id']}/verify",
        json={"approve": True, "actor_agent_id": human["agent_id"]},
    )
    assert r.status_code == 200, r.text
    snap = await client.get(f"/api/containers/{container['id']}")
    assert snap.json()["container"]["status"] == "completed"


@pytest.mark.xfail(reason="Orcha#24: paused container does not yet block mutating endpoints")
async def test_paused_blocks_mutations(client, container, make_agent):
    human = await make_agent("op", "operator", kind="human")
    await client.post(
        f"/api/containers/{container['id']}/status",
        json={"status": "paused", "actor_agent_id": human["agent_id"]},
    )
    r = await client.post(
        f"/api/containers/{container['id']}/tasks",
        json={"title": "t", "definition_of_done": "d", "depends_on": []},
    )
    assert r.status_code == 409, "a paused container should reject new tasks"
