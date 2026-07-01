"""Auth v1 (#271): the portal capability-token gate.

Covers the middleware (off|warn|enforce via ORCHA_AUTH_MODE), the #271-V2 spoof
regression (an AI token can no longer act as a human by supplying a human's
UUID), token minting on register, token management endpoints, the derived root
(daemon) credential, the browser session cookie, and the events.credential_id
audit tie-in.

Mode notes for this suite: the app-wide default is 'warn' (so the rest of the
suite — and upgraded real stacks — keep working unauthenticated). Tests flip
modes per-request via monkeypatch; fixtures (container/agents) run BEFORE the
flip, mirroring a real upgraded stack that adopts enforce after registration.
"""
import pytest

from orcha_cli import auth_tokens


async def _register(client, cid, alias, kind, prompt="You are a test agent."):
    body = {"alias": alias, "role": "worker", "kind": kind}
    if kind == "ai":
        body["prompt"] = prompt
    r = await client.post(f"/api/containers/{cid}/agents", json=body)
    assert r.status_code in (200, 201), r.text
    return r.json()


@pytest.fixture
def enforce(monkeypatch):
    """Flip to enforce AFTER setup calls made in fixtures/test bodies so far."""
    def _flip():
        monkeypatch.setenv("ORCHA_AUTH_MODE", "enforce")
    return _flip


# ---------- register mints a token ----------

async def test_register_returns_token_once_and_stores_only_hash(client, container, db):
    d = await _register(client, container["id"], "Sam", "ai")
    assert d["token"].startswith("orcha_a_")
    rows = db.execute("SELECT * FROM agent_tokens WHERE agent_id=%s", (d["agent_id"],))
    assert len(rows) == 1
    assert rows[0]["token_hash"] == auth_tokens.hash_token(d["token"])
    # the plaintext must never be persisted
    assert d["token"] not in str(rows[0].values())


async def test_register_human_token_has_human_prefix(client, container):
    d = await _register(client, container["id"], "Hussein", "human")
    assert d["token"].startswith("orcha_h_")


# ---------- mode gates ----------

async def test_enforce_blocks_unauthenticated_write(client, container, enforce):
    enforce()
    r = await client.post(f"/api/containers/{container['id']}/status",
                          json={"status": "paused", "actor_agent_id": "x"})
    assert r.status_code == 401


async def test_enforce_blocks_unauthenticated_read(client, container, enforce):
    enforce()
    r = await client.get(f"/api/containers/{container['id']}")
    assert r.status_code == 401


async def test_warn_mode_default_allows_unauthenticated(client, container):
    # no env flip: default is warn — existing flows keep working
    h = await _register(client, container["id"], "Hussein", "human")
    r = await client.post(f"/api/containers/{container['id']}/status",
                          json={"status": "paused", "actor_agent_id": h["agent_id"]})
    assert r.status_code == 200


async def test_off_mode_allows_and_stamps_events(client, container, db, monkeypatch):
    h = await _register(client, container["id"], "Hussein", "human")
    monkeypatch.setenv("ORCHA_AUTH_MODE", "off")
    r = await client.post(f"/api/containers/{container['id']}/status",
                          json={"status": "paused", "actor_agent_id": h["agent_id"]})
    assert r.status_code == 200
    rows = db.execute(
        "SELECT detail FROM events WHERE event_type='status_changed' ORDER BY id DESC LIMIT 1")
    assert rows and rows[0]["detail"].get("_auth_mode") == "off"


# ---------- the #271 spoof regression ----------

async def test_spoof_271_ai_token_cannot_claim_human_actor(client, container, enforce):
    h = await _register(client, container["id"], "Hussein", "human")
    a = await _register(client, container["id"], "Sam", "ai")
    enforce()
    # AI token claiming the human's UUID in the body: the exact #271-V2 spoof
    r = await client.post(
        f"/api/containers/{container['id']}/status",
        json={"status": "paused", "actor_agent_id": h["agent_id"]},
        headers={"Authorization": f"Bearer {a['token']}"})
    assert r.status_code == 403
    assert "match" in r.json()["detail"].lower()
    # the real human token clears the same gate
    r = await client.post(
        f"/api/containers/{container['id']}/status",
        json={"status": "paused", "actor_agent_id": h["agent_id"]},
        headers={"Authorization": f"Bearer {h['token']}"})
    assert r.status_code == 200


async def test_enforce_ai_own_actor_still_hits_kind_gate(client, container, enforce):
    a = await _register(client, container["id"], "Sam", "ai")
    enforce()
    # honest AI identity passes the middleware, then fails the human-kind gate
    r = await client.post(
        f"/api/containers/{container['id']}/status",
        json={"status": "paused", "actor_agent_id": a["agent_id"]},
        headers={"Authorization": f"Bearer {a['token']}"})
    assert r.status_code == 403
    assert "kind" in r.json()["detail"].lower()


async def test_claim_field_author_agent_id_must_match_token(client, container, enforce):
    a1 = await _register(client, container["id"], "Sam", "ai")
    a2 = await _register(client, container["id"], "Max", "ai")
    enforce()
    tid = container["root_task_id"]
    r = await client.post(f"/api/tasks/{tid}/messages",
                          json={"author_agent_id": a2["agent_id"], "body": "hi"},
                          headers={"Authorization": f"Bearer {a1['token']}"})
    assert r.status_code == 403
    r = await client.post(f"/api/tasks/{tid}/messages",
                          json={"author_agent_id": a1["agent_id"], "body": "hi"},
                          headers={"Authorization": f"Bearer {a1['token']}"})
    assert r.status_code == 201


async def test_task_done_agent_id_is_a_claim_field(client, container, enforce):
    a1 = await _register(client, container["id"], "Sam", "ai")
    a2 = await _register(client, container["id"], "Max", "ai")
    enforce()
    tid = container["root_task_id"]
    r = await client.post(f"/api/tasks/{tid}/done",
                          json={"agent_id": a2["agent_id"], "result": "done"},
                          headers={"Authorization": f"Bearer {a1['token']}"})
    assert r.status_code == 403  # middleware mismatch, before any task-state logic


async def test_enforce_ai_credential_cannot_register_agents(client, container, enforce):
    a = await _register(client, container["id"], "Sam", "ai")
    enforce()
    # "agents never create agents" — previously a convention, now enforced
    r = await client.post(
        f"/api/containers/{container['id']}/agents",
        json={"alias": "Sneaky", "role": "worker", "kind": "ai", "prompt": "x"},
        headers={"Authorization": f"Bearer {a['token']}"})
    assert r.status_code == 403


async def test_invalid_token_is_401_in_enforce(client, container, enforce):
    enforce()
    r = await client.get(f"/api/containers/{container['id']}",
                         headers={"Authorization": "Bearer orcha_a_notarealtoken"})
    assert r.status_code == 401


# ---------- derived root (daemon) credential ----------

async def test_root_token_authenticates_and_bypasses_claim_match(
        client, container, enforce, monkeypatch):
    a1 = await _register(client, container["id"], "Sam", "ai")
    monkeypatch.setenv("ORCHA_SECRET_KEY", "test-master-key")
    root = auth_tokens.derive_root("test-master-key")
    enforce()
    # daemons post AS the woken agent (notifier → task messages): no match check
    r = await client.post(f"/api/tasks/{container['root_task_id']}/messages",
                          json={"author_agent_id": a1["agent_id"], "body": "wake note"},
                          headers={"Authorization": f"Bearer {root}"})
    assert r.status_code == 201
    r = await client.get(f"/api/agents/{a1['agent_id']}/inbox",
                         headers={"Authorization": f"Bearer {root}"})
    assert r.status_code == 200


# ---------- token management ----------

async def test_token_mint_requires_human_or_daemon_principal(client, container):
    h = await _register(client, container["id"], "Hussein", "human")
    a = await _register(client, container["id"], "Sam", "ai")
    # strict regardless of mode: no credential → 401
    r = await client.post(f"/api/agents/{a['agent_id']}/tokens", json={"label": "extra"})
    assert r.status_code == 401
    # an AI credential may not manage tokens
    r = await client.post(f"/api/agents/{a['agent_id']}/tokens", json={"label": "extra"},
                          headers={"Authorization": f"Bearer {a['token']}"})
    assert r.status_code == 403
    # a human may
    r = await client.post(f"/api/agents/{a['agent_id']}/tokens", json={"label": "extra"},
                          headers={"Authorization": f"Bearer {h['token']}"})
    assert r.status_code == 201
    assert r.json()["token"].startswith("orcha_a_")


async def test_token_list_masks_secrets_and_revoke_kills_token(client, container, enforce):
    h = await _register(client, container["id"], "Hussein", "human")
    a = await _register(client, container["id"], "Sam", "ai")
    hh = {"Authorization": f"Bearer {h['token']}"}
    r = await client.get(f"/api/agents/{a['agent_id']}/tokens", headers=hh)
    assert r.status_code == 200
    toks = r.json()["tokens"]
    assert len(toks) == 1
    assert "token" not in toks[0] and "token_hash" not in toks[0]
    r = await client.post(f"/api/tokens/{toks[0]['id']}/revoke", json={}, headers=hh)
    assert r.status_code == 200
    enforce()
    r = await client.get(f"/api/containers/{container['id']}",
                         headers={"Authorization": f"Bearer {a['token']}"})
    assert r.status_code == 401  # revoked
    r = await client.get(f"/api/containers/{container['id']}", headers=hh)
    assert r.status_code == 200  # the human's own token is untouched


# ---------- browser session ----------

async def test_session_cookie_login_whoami_logout(client, container, enforce):
    h = await _register(client, container["id"], "Hussein", "human")
    r = await client.post("/api/auth/session", json={"token": h["token"]})
    assert r.status_code == 200
    assert r.json()["alias"] == "Hussein" and r.json()["kind"] == "human"
    enforce()
    # cookie (set by the login above) now authenticates reads — no header needed
    r = await client.get(f"/api/containers/{container['id']}")
    assert r.status_code == 200
    r = await client.get("/api/auth/whoami")
    assert r.status_code == 200 and r.json()["alias"] == "Hussein"
    r = await client.request("DELETE", "/api/auth/session")
    assert r.status_code == 200
    r = await client.get("/api/auth/whoami")
    assert r.status_code == 401


async def test_session_rejects_bad_token(client):
    r = await client.post("/api/auth/session", json={"token": "orcha_h_bogus"})
    assert r.status_code == 401


# ---------- audit tie-in ----------

async def test_events_row_carries_credential_id(client, container, db):
    h = await _register(client, container["id"], "Hussein", "human")
    r = await client.post(f"/api/containers/{container['id']}/status",
                          json={"status": "paused", "actor_agent_id": h["agent_id"]},
                          headers={"Authorization": f"Bearer {h['token']}"})
    assert r.status_code == 200
    tok = db.execute("SELECT id FROM agent_tokens WHERE agent_id=%s", (h["agent_id"],))
    ev = db.execute(
        "SELECT credential_id FROM events WHERE event_type='status_changed' ORDER BY id DESC LIMIT 1")
    assert ev[0]["credential_id"] == tok[0]["id"]
