"""Capability discovery seam — clients negotiate features instead of assuming.

Companion to #211/#212/#213: GET /api/capabilities describes the deployment's
shape; downstreams extend via register_capability() at assembly. The mobile
apps pin the client half (absent capability ⇒ hide/degrade; 404 on the whole
endpoint ⇒ pre-capabilities portal ⇒ assume full vintage feature set).

Each test carries a mutation note: revert the named production line → RED.
"""
import pytest

from portal_backend import capability_routes


@pytest.fixture(autouse=True)
def _isolate():
    yield
    capability_routes.reset_capabilities()


async def test_endpoint_returns_sorted_core_set(client):
    """Mutation: drop a core capability from _CORE_CAPABILITIES → RED."""
    r = await client.get("/api/capabilities")
    assert r.status_code == 200
    caps = r.json()["capabilities"]
    assert caps == sorted(caps)
    for core in ("tasks", "conversations", "requests", "pairing", "autonomy_levels"):
        assert core in caps


async def test_downstream_registration_is_additive_and_idempotent(client):
    """Mutation: make register_capability replace instead of add → RED."""
    capability_routes.register_capability("access_model")
    capability_routes.register_capability("access_model")
    caps = (await client.get("/api/capabilities")).json()["capabilities"]
    assert caps.count("access_model") == 1
    assert "tasks" in caps  # core survives downstream registration


def test_invalid_names_rejected():
    """Mutation: drop the guard → RED."""
    with pytest.raises(ValueError):
        capability_routes.register_capability("")
    with pytest.raises(ValueError):
        capability_routes.register_capability(None)


async def test_reset_restores_core_only(client):
    """Test-isolation contract: reset drops downstream registrations."""
    capability_routes.register_capability("push_relay")
    capability_routes.reset_capabilities()
    caps = (await client.get("/api/capabilities")).json()["capabilities"]
    assert "push_relay" not in caps and "tasks" in caps
