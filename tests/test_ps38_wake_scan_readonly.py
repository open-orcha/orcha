"""PS-38: containers.last_wake_scan_at is the portal's "a wake service serves this
project" signal. Only the header-less daemon poll may stamp it (and commit the wake
backoff bookkeeping). A browser read of wake-scan — any trusted login, member or
viewer — is a read-only preview: it must not flip the signal to 'Running'."""
import pytest

OCTO = {"X-Auth-Request-User": "octocat"}
VERA = {"X-Auth-Request-User": "vera"}


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("ORCHA_PLAN", "team")
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")


def _stamp(db, cid):
    return db.execute("SELECT last_wake_scan_at FROM containers WHERE id=%s", (cid,))[0]["last_wake_scan_at"]


async def test_browser_wake_scan_does_not_stamp_the_wake_service(client, container, make_agent, db):
    cid = container["id"]
    await make_agent("root", "operator", kind="human")
    assert (await client.get(f"/api/me?cid={cid}", headers=OCTO)).status_code == 200
    r = await client.post(f"/api/containers/{cid}/members",
                          json={"github_login": "vera", "role": "viewer"}, headers=OCTO)
    assert r.status_code == 201, r.text
    await make_agent("Pixel")
    db.execute("UPDATE containers SET last_wake_scan_at=NULL WHERE id=%s", (cid,))

    for who in (VERA, OCTO):
        r = await client.get(f"/api/containers/{cid}/wake-scan", headers=who)
        assert r.status_code == 200, r.text
        assert _stamp(db, cid) is None, "a browser read must not fake the wake service"

    r = await client.get(f"/api/containers/{cid}/wake-scan")  # the header-less daemon poll
    assert r.status_code == 200, r.text
    assert _stamp(db, cid) is not None
