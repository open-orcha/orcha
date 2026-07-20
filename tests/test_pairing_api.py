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


async def test_pairing_includes_remote_url_when_configured(client, container, make_agent, monkeypatch):
    """ORCHA_REMOTE_URL (e.g. the host's Tailscale IP, auto-detected by `orcha up`)
    rides the payload + QR as remoteBaseUrl so one scan configures the phone's
    local↔remote failover. A bare host inherits the portal's scheme/port like the
    LAN baseUrl does; absent env keeps the payload exactly as before."""
    monkeypatch.setenv("ORCHA_PAIRING_HOST", "192.168.1.24")
    human = await make_agent("Kedar", "operator", kind="human")
    url = f"/api/containers/{container['id']}/pairing?human_agent_id={human['agent_id']}"

    # bare host → inherits request scheme + port
    monkeypatch.setenv("ORCHA_REMOTE_URL", "100.113.140.69")
    r = await client.get(url, headers={"host": "localhost:8001"})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["remoteBaseUrl"] == "http://100.113.140.69:8001"
    assert json.loads(data["qrText"])["remoteBaseUrl"] == "http://100.113.140.69:8001"

    # explicit port and MagicDNS-style names pass through
    monkeypatch.setenv("ORCHA_REMOTE_URL", "my-mac.tailnet.ts.net:9999")
    r = await client.get(url, headers={"host": "localhost:8001"})
    assert r.json()["remoteBaseUrl"] == "http://my-mac.tailnet.ts.net:9999"

    # local-only values are ignored (a misconfigured env can't poison the QR)
    monkeypatch.setenv("ORCHA_REMOTE_URL", "localhost:8001")
    r = await client.get(url, headers={"host": "localhost:8001"})
    assert "remoteBaseUrl" not in r.json()
    assert "remoteBaseUrl" not in json.loads(r.json()["qrText"])

    # absent env → payload unchanged from the pre-remote contract
    monkeypatch.delenv("ORCHA_REMOTE_URL", raising=False)
    r = await client.get(url, headers={"host": "localhost:8001"})
    assert "remoteBaseUrl" not in r.json()
