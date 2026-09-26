"""Device-token auth (Orcha Cloud) — per-device bearer tokens minted behind the OAuth
proxy, validated by the perimeter's forward_auth lane (GET /api/auth/check).

Trust model under test: mint/list/revoke require the TRUSTED proxy identity
(ORCHA_TRUST_PROXY_USER=1 + X-Auth-Request-User resolving to a live member — match
only; the binding rule stays /api/me's side effect). /api/auth/check is the validator
Caddy calls: it needs ONLY the bearer token, never the trusted header — it's what
MAKES that header for the device lane.
"""
import hashlib
import uuid

import pytest


@pytest.fixture(autouse=True)
def _team_plan(monkeypatch):
    """This suite exercises Team-plan features (members/device identity) under the
    plan-gating addendum (docs/orcha-cloud-local-run.md) — same idiom as
    tests/test_access_model.py. Solo-tier 402 behavior is covered by
    tests/test_plan_gating.py, so nothing here masks the gate itself."""
    monkeypatch.setenv("ORCHA_PLAN", "team")


OCTO = {"X-Auth-Request-User": "octocat"}
FRIEND = {"X-Auth-Request-User": "friend"}


@pytest.fixture
def trust_proxy(monkeypatch):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")


@pytest.fixture
def no_trust_proxy(monkeypatch):
    monkeypatch.delenv("ORCHA_TRUST_PROXY_USER", raising=False)


async def _bind_owner(client, container, make_agent):
    """Found the container: create the root human; octocat's arrival binds as owner."""
    await make_agent("root", "operator", kind="human")
    r = await client.get(f"/api/me?cid={container['id']}", headers=OCTO)
    assert r.status_code == 200, r.text
    ident = r.json()["identity"]
    assert ident and ident["member_role"] == "owner"
    return ident


async def _invite(client, cid, login):
    r = await client.post(
        f"/api/containers/{cid}/members", json={"github_login": login}, headers=OCTO
    )
    assert r.status_code == 201, r.text
    return r.json()


async def _mint(client, headers, label=None):
    r = await client.post("/api/device-tokens", json={"label": label}, headers=headers)
    assert r.status_code == 201, r.text
    return r.json()


# ---------- POST /api/device-tokens (mint) ----------

async def test_mint_403_anonymous(client, container, make_agent, trust_proxy):
    await _bind_owner(client, container, make_agent)
    r = await client.post("/api/device-tokens", json={})
    assert r.status_code == 403, r.text


async def test_mint_403_untrusted_header(client, container, make_agent, monkeypatch):
    """Without ORCHA_TRUST_PROXY_USER=1 the header is inert — even a real member's
    login mints nothing (self-hosters never expose this surface)."""
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")
    await _bind_owner(client, container, make_agent)
    monkeypatch.delenv("ORCHA_TRUST_PROXY_USER")
    r = await client.post("/api/device-tokens", json={}, headers=OCTO)
    assert r.status_code == 403, r.text


async def test_mint_403_non_member(client, container, make_agent, trust_proxy):
    await _bind_owner(client, container, make_agent)
    r = await client.post(
        "/api/device-tokens", json={}, headers={"X-Auth-Request-User": "rando"}
    )
    assert r.status_code == 403, r.text
    assert "not a member" in r.json()["detail"]


async def test_mint_403_unbound_identity_never_binds(
    client, container, make_agent, trust_proxy, db
):
    """Mint is MATCH-ONLY: an identity that never resolved through /api/me is refused,
    and minting must not run the binding rule as a side effect."""
    await make_agent("root", "operator", kind="human")  # unmapped founding human
    r = await client.post("/api/device-tokens", json={}, headers=OCTO)
    assert r.status_code == 403, r.text
    row = db.execute("SELECT github_login FROM agents WHERE kind='human'")[0]
    assert row["github_login"] is None  # still unbound — /api/me owns binding


async def test_mint_returns_token_once_stores_hash_only(
    client, container, make_agent, trust_proxy, db
):
    ident = await _bind_owner(client, container, make_agent)
    d = await _mint(client, OCTO, label="Hussein's iPhone")
    assert d["agent_id"] == ident["agent_id"] and d["label"] == "Hussein's iPhone"
    token = d["token"]
    assert len(token) >= 32

    rows = db.execute("SELECT * FROM device_tokens")
    assert len(rows) == 1
    row = rows[0]
    # hash-only storage: the row carries sha256(token), never the raw token
    assert row["token_hash"] == hashlib.sha256(token.encode()).hexdigest()
    assert token not in {str(v) for v in row.values()}
    assert str(row["agent_id"]) == ident["agent_id"]
    assert str(row["container_id"]) == container["id"]
    assert row["created_at"] is not None
    assert row["last_used_at"] is None and row["revoked_at"] is None


# ---------- GET /api/auth/check (the perimeter validator) ----------

async def test_check_valid_token_202_with_identity_header(
    client, container, make_agent, monkeypatch, db
):
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")
    await _bind_owner(client, container, make_agent)
    token = (await _mint(client, OCTO))["token"]

    # The validator must not depend on the trusted-header env — Caddy calls it
    # BEFORE any identity exists on the request.
    monkeypatch.delenv("ORCHA_TRUST_PROXY_USER")
    r = await client.get(
        "/api/auth/check", headers={"Authorization": f"Bearer {token}"}
    )
    assert r.status_code == 202, r.text
    assert r.headers["X-Auth-Request-User"] == "octocat"
    # first use stamps last_used_at
    assert db.execute("SELECT last_used_at FROM device_tokens")[0]["last_used_at"]


async def test_check_401_paths(client, container, make_agent, trust_proxy):
    await _bind_owner(client, container, make_agent)
    r = await client.get("/api/auth/check")
    assert r.status_code == 401                       # no Authorization at all
    r = await client.get("/api/auth/check", headers={"Authorization": "Basic abc"})
    assert r.status_code == 401                       # not a bearer scheme
    r = await client.get("/api/auth/check", headers={"Authorization": "Bearer "})
    assert r.status_code == 401                       # empty token
    r = await client.get(
        "/api/auth/check", headers={"Authorization": "Bearer not-a-real-token"}
    )
    assert r.status_code == 401                       # unknown token


async def test_check_revoked_token_401(client, container, make_agent, trust_proxy, db):
    await _bind_owner(client, container, make_agent)
    token = (await _mint(client, OCTO))["token"]
    tok_id = str(db.execute("SELECT id FROM device_tokens")[0]["id"])
    r = await client.delete(f"/api/device-tokens/{tok_id}", headers=OCTO)
    assert r.status_code == 200 and r.json()["revoked"] is True
    r = await client.get(
        "/api/auth/check", headers={"Authorization": f"Bearer {token}"}
    )
    assert r.status_code == 401, r.text


async def test_check_retired_member_token_401(
    client, container, make_agent, trust_proxy, db
):
    """Tokens die with their human: removing the member kills the device too."""
    await _bind_owner(client, container, make_agent)
    friend = await _invite(client, container["id"], "friend")
    token = (await _mint(client, FRIEND))["token"]
    r = await client.delete(
        f"/api/containers/{container['id']}/members/{friend['agent_id']}",
        headers=OCTO,
    )
    assert r.status_code == 200, r.text
    r = await client.get(
        "/api/auth/check", headers={"Authorization": f"Bearer {token}"}
    )
    assert r.status_code == 401, r.text


async def test_check_reinvited_member_old_token_stays_revoked(
    client, container, make_agent, trust_proxy, db
):
    """PR #223 review: removal is a PERMANENT credential boundary. Re-inviting the
    same login reactivates the retired agent row — the pre-removal token must NOT
    come back to life with it (revoked at removal, not merely masked by
    terminated_at). A token minted AFTER the re-invite works normally."""
    await _bind_owner(client, container, make_agent)
    friend = await _invite(client, container["id"], "friend")
    old_token = (await _mint(client, FRIEND))["token"]
    hdr = {"Authorization": f"Bearer {old_token}"}
    assert (await client.get("/api/auth/check", headers=hdr)).status_code == 202

    r = await client.delete(
        f"/api/containers/{container['id']}/members/{friend['agent_id']}",
        headers=OCTO,
    )
    assert r.status_code == 200, r.text
    assert (await client.get("/api/auth/check", headers=hdr)).status_code == 401
    # the removal itself revoked the row — not just masked it via terminated_at
    assert db.execute("SELECT revoked_at FROM device_tokens")[0]["revoked_at"]

    reinvited = await _invite(client, container["id"], "friend")
    assert reinvited["agent_id"] == friend["agent_id"]  # same reactivated row
    assert (await client.get("/api/auth/check", headers=hdr)).status_code == 401

    fresh = (await _mint(client, FRIEND))["token"]
    r = await client.get(
        "/api/auth/check", headers={"Authorization": f"Bearer {fresh}"}
    )
    assert r.status_code == 202, r.text
    assert r.headers["X-Auth-Request-User"] == "friend"


async def test_check_touch_throttled(client, container, make_agent, trust_proxy, db):
    """last_used_at advances at most once per 60s — a polling phone is one UPDATE a
    minute, not one per request."""
    await _bind_owner(client, container, make_agent)
    token = (await _mint(client, OCTO))["token"]
    hdr = {"Authorization": f"Bearer {token}"}

    assert (await client.get("/api/auth/check", headers=hdr)).status_code == 202
    t1 = db.execute("SELECT last_used_at FROM device_tokens")[0]["last_used_at"]
    assert t1 is not None
    assert (await client.get("/api/auth/check", headers=hdr)).status_code == 202
    t2 = db.execute("SELECT last_used_at FROM device_tokens")[0]["last_used_at"]
    assert t2 == t1                                    # inside the window: no write

    db.execute(
        "UPDATE device_tokens SET last_used_at = now() - interval '2 minutes'"
    )
    assert (await client.get("/api/auth/check", headers=hdr)).status_code == 202
    t3 = db.execute("SELECT last_used_at FROM device_tokens")[0]["last_used_at"]
    assert t3 > t1                                     # window elapsed: touched again


# ---------- GET /api/device-tokens (list) + DELETE (revoke) ----------

async def test_list_requires_identity_and_shows_own_only(
    client, container, make_agent, trust_proxy
):
    await _bind_owner(client, container, make_agent)
    await _invite(client, container["id"], "friend")
    await _mint(client, OCTO, label="phone")
    await _mint(client, OCTO, label="tablet")
    await _mint(client, FRIEND, label="friend-phone")

    r = await client.get("/api/device-tokens")
    assert r.status_code == 403                        # anonymous: refused

    mine = (await client.get("/api/device-tokens", headers=OCTO)).json()["tokens"]
    assert {t["label"] for t in mine} == {"phone", "tablet"}
    assert set(mine[0]) == {"id", "label", "created_at", "last_used_at"}

    theirs = (await client.get("/api/device-tokens", headers=FRIEND)).json()["tokens"]
    assert [t["label"] for t in theirs] == ["friend-phone"]


async def test_revoke_member_own_yes_others_no(
    client, container, make_agent, trust_proxy, db
):
    await _bind_owner(client, container, make_agent)
    await _invite(client, container["id"], "friend")
    await _mint(client, OCTO, label="owner-phone")
    await _mint(client, FRIEND, label="friend-phone")
    ids = {
        r["label"]: str(r["id"])
        for r in db.execute("SELECT id, label FROM device_tokens")
    }

    # member revoking the OWNER's token: refused
    r = await client.delete(
        f"/api/device-tokens/{ids['owner-phone']}", headers=FRIEND
    )
    assert r.status_code == 403, r.text

    # member revoking their own: allowed, and it disappears from their list
    r = await client.delete(
        f"/api/device-tokens/{ids['friend-phone']}", headers=FRIEND
    )
    assert r.status_code == 200 and r.json()["revoked"] is True
    left = (await client.get("/api/device-tokens", headers=FRIEND)).json()["tokens"]
    assert left == []

    # idempotent: re-revoking answers revoked=false, not an error
    r = await client.delete(
        f"/api/device-tokens/{ids['friend-phone']}", headers=FRIEND
    )
    assert r.status_code == 200 and r.json()["revoked"] is False


async def test_revoke_owner_may_revoke_any_members(
    client, container, make_agent, trust_proxy, db
):
    await _bind_owner(client, container, make_agent)
    await _invite(client, container["id"], "friend")
    token = (await _mint(client, FRIEND, label="friend-phone"))["token"]
    tok_id = str(db.execute("SELECT id FROM device_tokens")[0]["id"])

    r = await client.delete(f"/api/device-tokens/{tok_id}", headers=OCTO)
    assert r.status_code == 200 and r.json()["revoked"] is True
    r = await client.get(
        "/api/auth/check", headers={"Authorization": f"Bearer {token}"}
    )
    assert r.status_code == 401                        # revocation is immediate


async def test_revoke_unknown_and_invalid_ids(
    client, container, make_agent, trust_proxy
):
    await _bind_owner(client, container, make_agent)
    r = await client.delete(f"/api/device-tokens/{uuid.uuid4()}", headers=OCTO)
    assert r.status_code == 404, r.text
    r = await client.delete("/api/device-tokens/not-a-uuid", headers=OCTO)
    assert r.status_code == 400, r.text


# ---------- GET /auth/device (the pairing page) ----------

async def test_device_page_serves_redirect_js_and_fallback(client):
    r = await client.get("/auth/device")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/html")
    # React port: the route serves the SPA shell; the pairing behaviors live in
    # src/cloud/device/DevicePage.tsx (Vitest: DevicePage.test.tsx covers the
    # one-POST mint, clipboard copy, and 403 remedy behaviorally).
    assert '<div id="root">' in r.text and "/assets/dist/" in r.text
    import pathlib
    src = (pathlib.Path(__file__).resolve().parent.parent / "orcha-cli" / "orcha_cli"
           / "templates" / "portal" / "frontend" / "src" / "cloud" / "device" / "DevicePage.tsx").read_text()
    # mints through the same-origin API (the proxy session carries the identity)
    assert "/api/device-tokens" in src
    # hands the token to the app via the registered URL scheme, host included
    assert "orcha://auth/callback?host=" in src
    assert "location.host" in src
    # manual fallback: visible token + copy button + "app should have opened" copy
    assert "should have opened automatically" in src
    assert "Copy token" in src
    # mint failure (non-member) renders an actionable message
    assert "must be a member" in src
