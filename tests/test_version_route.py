"""GH #258 plan PR 9 (I2): GET /api/version reports the API and installed CLI versions."""
from importlib import metadata

import pytest

from portal_backend import version_routes
from portal_backend.application import app


@pytest.mark.asyncio
async def test_reports_api_and_installed_cli_version(client, monkeypatch):
    monkeypatch.setattr(version_routes.metadata, "version", lambda name: "9.8.7")
    r = await client.get("/api/version")
    assert r.status_code == 200
    assert r.json() == {"api_version": app.version, "cli_version": "9.8.7"}


@pytest.mark.asyncio
async def test_cli_version_null_when_package_not_installed(client, monkeypatch):
    def missing(name):
        raise metadata.PackageNotFoundError(name)

    monkeypatch.setattr(version_routes.metadata, "version", missing)
    r = await client.get("/api/version")
    assert r.status_code == 200
    assert r.json() == {"api_version": app.version, "cli_version": None}


@pytest.mark.asyncio
async def test_route_is_in_the_openapi_spec(client):
    r = await client.get("/openapi.json")
    assert "/api/version" in r.json()["paths"]
