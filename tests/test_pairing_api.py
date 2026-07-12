import json
from datetime import datetime, timezone

import pytest

pytestmark = pytest.mark.asyncio


async def test_pairing_payload_uses_lan_base_url_and_qr(client, container, make_agent, monkeypatch):
    monkeypatch.setenv("ORCHA_PAIRING_HOST", "192.168.1.24")
    human = await make_agent("Kedar", "operator", kind="human")

    r = await client.get(
        f"/api/containers/{container['id']}/pairing?human_agent_id={human['agent_id']}",
        headers={"host": "localhost:8001"},
    )

    assert r.status_code == 200, r.text
    data = r.json()
    assert data["v"] == 1
    assert data["kind"] == "orcha-pair"
    assert data["baseUrl"] == "http://192.168.1.24:8001"
    assert "localhost" not in data["baseUrl"]
    assert data["containerId"] == container["id"]
    assert data["containerName"] == container["name"]
    assert data["humanAgentId"] == human["agent_id"]
    assert data["humanAgentAlias"] == "Kedar"
    assert data["token"]
    assert data["shortCode"] and "-" in data["shortCode"]
    assert data["tokenExchange"]["status"] == "follow_up"
    assert data["tokenExchange"]["endpoint"] == "POST /api/pair/device-token"
    assert "<svg" in data["qrSvg"]

    qr_payload = json.loads(data["qrText"])
    assert qr_payload["kind"] == "orcha-pair"
    assert qr_payload["baseUrl"] == data["baseUrl"]
    assert qr_payload["humanAgentId"] == human["agent_id"]
    assert "qrSvg" not in qr_payload
    expires = datetime.fromisoformat(data["expiresAt"].replace("Z", "+00:00"))
    assert expires > datetime.now(timezone.utc)


async def test_pairing_warns_when_only_localhost_is_available(client, container, make_agent, monkeypatch):
    monkeypatch.delenv("ORCHA_PAIRING_HOST", raising=False)
    human = await make_agent("Kedar", "operator", kind="human")

    r = await client.get(
        f"/api/containers/{container['id']}/pairing?human_agent_id={human['agent_id']}",
        headers={"host": "localhost:8001"},
    )

    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail["title"] == "Phones can't reach this Orcha yet"
    assert detail["reason"] == "no_lan_address"
    assert "orcha up" in detail["remedy"]
    assert "--host" not in detail["remedy"]


async def test_pairing_requires_human_choice_when_multiple_humans(client, container, make_agent, monkeypatch):
    monkeypatch.setenv("ORCHA_PAIRING_HOST", "192.168.1.24")
    h1 = await make_agent("Kedar", "operator", kind="human")
    h2 = await make_agent("Dana", "designer", kind="human")

    r = await client.get(f"/api/containers/{container['id']}/pairing")
    assert r.status_code == 400, r.text
    detail = r.json()["detail"]
    assert detail["reason"] == "choose_human"
    assert {h["alias"] for h in detail["humans"]} == {"Kedar", "Dana"}

    ok = await client.get(f"/api/containers/{container['id']}/pairing?human_agent_id={h2['agent_id']}")
    assert ok.status_code == 200, ok.text
    assert ok.json()["humanAgentId"] == h2["agent_id"]
    assert ok.json()["humanAgentId"] != h1["agent_id"]


async def test_pairing_endpoint_is_in_openapi(client):
    r = await client.get("/openapi.json")
    assert r.status_code == 200, r.text
    assert "/api/containers/{cid}/pairing" in r.json()["paths"]
