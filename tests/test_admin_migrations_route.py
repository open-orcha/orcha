"""GH #258 PR 6 (plan R-D1): GET /api/admin/migrations, the read-only input to the native
`orcha upgrade` DB-tip guard."""
import pytest

import main
from portal_backend import database


def _sql(q, params=()):
    with database.db_cursor() as (_c, cur):
        cur.execute(q, params)


@pytest.fixture(autouse=True)
def _no_schema_migrations():
    _sql("DROP TABLE IF EXISTS schema_migrations")
    yield
    _sql("DROP TABLE IF EXISTS schema_migrations")


@pytest.mark.asyncio
async def test_never_migrated_database_reports_empty(client):
    r = await client.get("/api/admin/migrations")
    assert r.status_code == 200
    assert r.json() == {"applied": [], "count": 0, "tip": 0}


@pytest.mark.asyncio
async def test_lists_recorded_versions_and_tip(client):
    _sql("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ)")
    for v in ("071_provider_key_agent_use.sql", "001_init.sql", "009_x.sql"):
        _sql("INSERT INTO schema_migrations(version) VALUES (%s)", (v,))
    r = await client.get("/api/admin/migrations")
    assert r.status_code == 200
    assert r.json() == {
        "applied": ["001_init.sql", "009_x.sql", "071_provider_key_agent_use.sql"],
        "count": 3,
        "tip": 71,
    }


def test_route_is_in_openapi_with_its_response_model():
    spec = main.app.openapi()
    op = spec["paths"]["/api/admin/migrations"]["get"]
    ref = op["responses"]["200"]["content"]["application/json"]["schema"]["$ref"]
    assert ref.endswith("/MigrationsResponse")
    assert set(spec["components"]["schemas"]["MigrationsResponse"]["properties"]) == {
        "applied", "count", "tip"}
