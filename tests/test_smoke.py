"""Smoke test — proves the harness boots: app imports, DB schema loads, a
container is created and reads back. If this fails, fix the fixtures before
debugging any module test."""


async def test_container_roundtrips(client, container):
    r = await client.get(f"/api/containers/{container['id']}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["container"]["id"] == container["id"]
    assert body["container"]["root_task_id"] == container["root_task_id"]
    # a fresh arena has only the root task and no agents/requests yet
    assert [t for t in body["tasks"] if t["is_root"]]
    assert body["agents"] == []
    assert body["requests"] == []


async def test_db_fixture_reads_rows(db, container):
    rows = db.execute("SELECT name FROM containers WHERE id=%s", (container["id"],))
    assert rows and rows[0]["name"] == "test-arena"


async def test_truncation_between_tests(client):
    # _clean_db ran before this test, so the 1:1:1 guard lets us create a container
    r = await client.post("/api/containers", json={"name": "fresh"})
    assert r.status_code == 201, r.text
