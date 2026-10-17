"""PS-08: the agent-lane GETs that round 1 missed are project-isolated too.

GET /api/requests/{rid}, /api/agents/{aid}/inbox, /api/agents/{aid}/outbox,
/api/containers/{cid}/wake-scan and /api/containers/{cid}/active-conversations:
  * a trusted non-member -> 403, and a member of ANOTHER project -> 403;
  * a member of this project -> 200;
  * header-less (the host daemon / CLI lane) -> 200, unchanged;
  * the wake-scan never hands sealed provider keys to a browser (proxy) session.
"""
import pytest

OCTO = {"X-Auth-Request-User": "octocat"}
HUBOT = {"X-Auth-Request-User": "hubot"}
MALLORY = {"X-Auth-Request-User": "mallory"}


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("ORCHA_PLAN", "team")
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")


async def test_agent_lane_reads_are_member_only(client, container, make_agent, make_request):
    cid = container["id"]
    await make_agent("root", "operator", kind="human")
    assert (await client.get(f"/api/me?cid={cid}", headers=OCTO)).json()["identity"]["member_role"] == "owner"
    swift = (await make_agent("Swift"))["agent_id"]
    peer = (await make_agent("Peer"))["agent_id"]
    rid = (await make_request(swift, "ship it", target_alias="Peer"))["request_id"]

    # hubot is a member of ANOTHER project only
    r = await client.post("/api/containers", json={"name": "other", "additional": True})
    other = r.json()["container_id"]
    await make_agent("boss", "operator", kind="human", container_id=other)
    await client.get(f"/api/me?cid={other}", headers=HUBOT)

    urls = [
        f"/api/requests/{rid}",
        f"/api/agents/{peer}/inbox",
        f"/api/agents/{swift}/outbox",
        f"/api/containers/{cid}/wake-scan",
        f"/api/containers/{cid}/active-conversations",
    ]
    for u in urls:
        assert (await client.get(u, headers=MALLORY)).status_code == 403, u
        assert (await client.get(u, headers=HUBOT)).status_code == 403, u
        assert (await client.get(u, headers=OCTO)).status_code == 200, u
        assert (await client.get(u)).status_code == 200, u


async def test_wake_scan_hides_sealed_keys_from_browser(client, container, make_agent, monkeypatch):
    from portal_backend import wake_scan_routes as ws
    monkeypatch.setattr(ws, "provider_key_enc", lambda cur, cid, provider: "SEALED")
    cid = container["id"]
    await make_agent("root", "operator", kind="human")
    await client.get(f"/api/me?cid={cid}", headers=OCTO)
    daemon = (await client.get(f"/api/containers/{cid}/wake-scan")).json()
    assert daemon["triage_key_enc"] == "SEALED" and daemon["ack_key_enc"] == "SEALED"
    browser = (await client.get(f"/api/containers/{cid}/wake-scan", headers=OCTO)).json()
    assert browser["triage_key_enc"] is None and browser["ack_key_enc"] is None
