"""Cross-container isolation (Orcha#22).

In this build, isolation is enforced **structurally**: the schema carries a
`containers_singleton` unique constraint, so a database holds at most ONE
container (stack:db:container = 1:1:1, Orcha#28). Cross-container leakage is
therefore impossible by construction — there is never a second container in the
same DB to leak into.

These tests pin that guarantee. Exercising per-endpoint rejection across two
*live* containers would require two separate stacks/databases, which is out of
scope for the single-DB harness (and unreachable: the constraint below forbids
a second container outright).
"""
import psycopg
import pytest


async def test_db_enforces_single_container(db, container):
    # The container fixture already created one; a second insert must be refused
    # by the schema, not just by the API.
    with pytest.raises(psycopg.errors.UniqueViolation):
        db.execute("INSERT INTO containers (name) VALUES ('intruder')")


async def test_api_rejects_second_container_409(client, container):
    r = await client.post("/api/containers", json={"name": "intruder"})
    assert r.status_code == 409, r.text


async def test_snapshot_scoped_to_its_container(client, container, make_agent):
    await make_agent("only", "eng")
    snap = await client.get(f"/api/containers/{container['id']}")
    assert {a["alias"] for a in snap.json()["agents"]} == {"only"}
