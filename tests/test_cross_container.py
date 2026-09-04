"""Cross-container isolation (Orcha#22; multi-project since mig 037).

Historically the schema itself enforced stack:db:container = 1:1:1 (Orcha#28) via the
`containers_singleton` unique index, so leakage was impossible by construction. Mig 037
(portal multi-project) DROPPED that index: a stack's DB may now hold several containers
("projects"), and isolation rests on the cid-scoping every endpoint already carries.

These tests pin the seams that moved:
  * the 1:1:1 *default* now lives at the API layer — POST /api/containers without
    `additional: true` still 409s when a container exists (the `orcha init` contract);
  * the DB accepts a second row (the portal's New-project flow depends on it);
  * snapshots stay scoped to their own container across two LIVE containers.
"""


async def test_db_allows_second_container_since_037(db, container):
    # Mig 037 dropped `containers_singleton`: a second row is legal at the schema
    # level (the API keeps the 1:1:1 default — next test). Distinct name required
    # (containers_name_uq).
    rows = db.execute("INSERT INTO containers (name) VALUES ('second-proj') RETURNING id")
    assert rows and rows[0]["id"]


async def test_api_rejects_second_container_409(client, container):
    # The `orcha init` 1:1:1 contract: without additional=true, a second create is refused.
    r = await client.post("/api/containers", json={"name": "intruder"})
    assert r.status_code == 409, r.text


async def test_snapshot_scoped_to_its_container(client, container, make_agent):
    await make_agent("only", "eng")
    snap = await client.get(f"/api/containers/{container['id']}")
    assert {a["alias"] for a in snap.json()["agents"]} == {"only"}


async def test_two_live_containers_stay_isolated(client, container, make_agent):
    """Two LIVE containers in one DB (the multi-project reality): each snapshot sees
    only its own agents/tasks; the additional project's seeded human never leaks."""
    await make_agent("only", "eng")
    r = await client.post(
        "/api/containers", json={"name": "proj-two", "additional": True}
    )
    assert r.status_code == 201, r.text
    two = r.json()

    snap_one = (await client.get(f"/api/containers/{container['id']}")).json()
    snap_two = (await client.get(f"/api/containers/{two['container_id']}")).json()
    assert {a["alias"] for a in snap_one["agents"]} == {"only"}
    assert {a["alias"] for a in snap_two["agents"]} == {"operator"}  # seeded owner
    assert {t["id"] for t in snap_one["tasks"]}.isdisjoint(
        {t["id"] for t in snap_two["tasks"]}
    )
