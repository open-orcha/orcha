"""#294 Item 1 — encrypted per-container Anthropic API-key storage + read path.

Three surfaces, all exercised here:
  * secret_box crypto (seal/unseal round-trip, authentication, scheme dispatch, master-key gating)
    — pure unit tests, no DB, no network, env injected explicitly.
  * secret_box.resolve_llm_key read path — env override > stored > none precedence (the #294
    deliverable the downstream #288/#290 triage wiring will call).
  * the HTTP routes GET/PUT/DELETE/test under /api/containers/{cid}/settings/llm-key — human-gating,
    masking-never-leaks-plaintext, 503-when-no-master-key, env-shadows-stored, and the /test ping
    (provider monkeypatched so no live network / no real key).

Same committed-isolation harness as the other route suites (conftest bootstraps the test DB with
every migration applied, including 020).
"""
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "orcha-cli"))
from orcha_cli import secret_box  # noqa: E402
from orcha_cli import llm_util  # noqa: E402

MASTER = {"ORCHA_SECRET_KEY": "unit-test-master-key-0123456789"}
KEY = "sk-ant-api03-EXAMPLEKEY-do-not-use-1234"


# ============================ secret_box crypto (unit) ============================

def test_seal_unseal_round_trip():
    blob = secret_box.seal(KEY, env=MASTER)
    assert blob.startswith("v1:")            # self-describing scheme prefix
    assert KEY not in blob                    # plaintext never appears in the blob
    assert secret_box.unseal(blob, env=MASTER) == KEY


def test_seal_is_nondeterministic():
    """Fresh random nonce per seal ⇒ two seals of the same key differ, yet both decrypt."""
    a = secret_box.seal(KEY, env=MASTER)
    b = secret_box.seal(KEY, env=MASTER)
    assert a != b
    assert secret_box.unseal(a, env=MASTER) == secret_box.unseal(b, env=MASTER) == KEY


def test_unseal_wrong_master_key_fails_closed():
    blob = secret_box.seal(KEY, env=MASTER)
    with pytest.raises(secret_box.DecryptionError):
        secret_box.unseal(blob, env={"ORCHA_SECRET_KEY": "a-different-master-key"})


def test_unseal_tampered_ciphertext_fails_closed():
    import base64
    blob = secret_box.seal(KEY, env=MASTER)
    raw = bytearray(base64.b64decode(blob[len("v1:"):]))
    raw[-1] ^= 0x01                            # flip a tag bit
    tampered = "v1:" + base64.b64encode(bytes(raw)).decode()
    with pytest.raises(secret_box.DecryptionError):
        secret_box.unseal(tampered, env=MASTER)


def test_unseal_unknown_scheme_rejected():
    # Harden vs a malformed-blob false-pass: seal a REAL v1 blob and relabel only its scheme
    # prefix to "v2". Its nonce/ciphertext/tag are all valid, and the MAC binds the module
    # constant _SCHEME ("v1") — so WITHOUT the scheme-dispatch guard, unseal would happily
    # authenticate and decrypt this v2-labelled blob back to KEY. The guard is the only thing
    # rejecting it, so dropping the guard makes this RED (a true mutation tooth).
    real = secret_box.seal(KEY, env=MASTER)
    assert real.startswith("v1:")
    relabelled = "v2:" + real[len("v1:"):]
    with pytest.raises(secret_box.DecryptionError):
        secret_box.unseal(relabelled, env=MASTER)


def test_unseal_malformed_blob_rejected():
    for bad in ("no-prefix-at-all", "v1:!!!not-base64!!!", "v1:AAAA"):
        with pytest.raises(secret_box.DecryptionError):
            secret_box.unseal(bad, env=MASTER)


def test_seal_without_master_key_raises():
    with pytest.raises(secret_box.MissingMasterKey):
        secret_box.seal(KEY, env={})


def test_master_key_present():
    assert secret_box.master_key_present(env=MASTER) is True
    assert secret_box.master_key_present(env={}) is False
    assert secret_box.master_key_present(env={"ORCHA_SECRET_KEY": ""}) is False


def test_last4():
    assert secret_box.last4(KEY) == "1234"
    assert secret_box.last4("") == ""


# ============================ resolve_llm_key read path (unit) ============================

def test_resolve_env_override_wins_over_stored():
    blob = secret_box.seal(KEY, env=MASTER)
    env = {**MASTER, "ORCHA_LLM_API_KEY": "sk-override-zzzz"}
    assert secret_box.resolve_llm_key(blob, env=env) == "sk-override-zzzz"


def test_resolve_decrypts_stored_when_no_override():
    blob = secret_box.seal(KEY, env=MASTER)
    assert secret_box.resolve_llm_key(blob, env=MASTER) == KEY


def test_resolve_none_when_nothing_set():
    assert secret_box.resolve_llm_key(None, env=MASTER) is None
    assert secret_box.resolve_llm_key(None, env={}) is None


def test_resolve_corrupt_blob_degrades_to_none_not_raise():
    """A bad/undecryptable stored blob must NOT break reads — it falls back to env/None."""
    assert secret_box.resolve_llm_key("v1:garbage", env=MASTER) is None
    # ...but an env override still resolves even if the stored blob is junk.
    env = {**MASTER, "ORCHA_LLM_API_KEY": "sk-override"}
    assert secret_box.resolve_llm_key("v1:garbage", env=env) == "sk-override"


# ============================ routes (DB + ASGI) ============================

async def _human(make_agent):
    h = await make_agent("Operator", kind="human")
    return h["agent_id"]


async def _ai(make_agent):
    a = await make_agent("Bot", kind="ai")
    return a["agent_id"]


@pytest.mark.asyncio
async def test_get_unconfigured(client, container, monkeypatch):
    monkeypatch.delenv("ORCHA_LLM_API_KEY", raising=False)
    r = await client.get(f"/api/containers/{container['id']}/settings/llm-key")
    assert r.status_code == 200, r.text
    assert r.json() == {"configured": False, "source": None, "masked": None, "set_at": None}


@pytest.mark.asyncio
async def test_put_then_get_db_source(client, container, make_agent, monkeypatch):
    monkeypatch.delenv("ORCHA_LLM_API_KEY", raising=False)
    monkeypatch.setenv("ORCHA_SECRET_KEY", "route-master-key")
    hid = await _human(make_agent)
    r = await client.put(f"/api/containers/{container['id']}/settings/llm-key",
                         json={"actor_agent_id": hid, "api_key": KEY})
    assert r.status_code == 200, r.text
    assert r.json() == {"configured": True, "source": "db", "masked": "sk-...1234"}

    g = await client.get(f"/api/containers/{container['id']}/settings/llm-key")
    body = g.json()
    assert body["configured"] is True and body["source"] == "db"
    assert body["masked"] == "sk-...1234"
    assert body["set_at"] is not None


@pytest.mark.asyncio
async def test_stored_value_is_sealed_not_plaintext(client, container, make_agent, db, monkeypatch):
    monkeypatch.delenv("ORCHA_LLM_API_KEY", raising=False)
    monkeypatch.setenv("ORCHA_SECRET_KEY", "route-master-key")
    hid = await _human(make_agent)
    await client.put(f"/api/containers/{container['id']}/settings/llm-key",
                     json={"actor_agent_id": hid, "api_key": KEY})
    rows = db.execute("SELECT llm_api_key_enc, llm_api_key_hint FROM containers WHERE id=%s",
                      (container["id"],))
    enc = rows[0]["llm_api_key_enc"]
    assert enc.startswith("v1:") and KEY not in enc        # at-rest value is sealed, not the key
    assert rows[0]["llm_api_key_hint"] == "1234"


@pytest.mark.asyncio
async def test_put_requires_human(client, container, make_agent, monkeypatch):
    monkeypatch.setenv("ORCHA_SECRET_KEY", "route-master-key")
    aid = await _ai(make_agent)
    r = await client.put(f"/api/containers/{container['id']}/settings/llm-key",
                         json={"actor_agent_id": aid, "api_key": KEY})
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_put_without_master_key_503(client, container, make_agent, monkeypatch):
    monkeypatch.delenv("ORCHA_SECRET_KEY", raising=False)
    hid = await _human(make_agent)
    r = await client.put(f"/api/containers/{container['id']}/settings/llm-key",
                         json={"actor_agent_id": hid, "api_key": KEY})
    assert r.status_code == 503, r.text
    assert "ORCHA_SECRET_KEY" in r.json()["detail"]


@pytest.mark.asyncio
async def test_put_blank_key_rejected(client, container, make_agent, monkeypatch):
    monkeypatch.setenv("ORCHA_SECRET_KEY", "route-master-key")
    hid = await _human(make_agent)
    r = await client.put(f"/api/containers/{container['id']}/settings/llm-key",
                         json={"actor_agent_id": hid, "api_key": "   "})
    assert r.status_code == 400, r.text


@pytest.mark.asyncio
async def test_delete_clears(client, container, make_agent, monkeypatch):
    monkeypatch.delenv("ORCHA_LLM_API_KEY", raising=False)
    monkeypatch.setenv("ORCHA_SECRET_KEY", "route-master-key")
    hid = await _human(make_agent)
    await client.put(f"/api/containers/{container['id']}/settings/llm-key",
                     json={"actor_agent_id": hid, "api_key": KEY})
    d = await client.request("DELETE", f"/api/containers/{container['id']}/settings/llm-key",
                             json={"actor_agent_id": hid})
    assert d.status_code == 200, d.text
    assert d.json() == {"configured": False, "source": None, "masked": None}
    g = await client.get(f"/api/containers/{container['id']}/settings/llm-key")
    assert g.json()["configured"] is False


@pytest.mark.asyncio
async def test_delete_requires_human(client, container, make_agent):
    aid = await _ai(make_agent)
    d = await client.request("DELETE", f"/api/containers/{container['id']}/settings/llm-key",
                             json={"actor_agent_id": aid})
    assert d.status_code == 403, d.text


@pytest.mark.asyncio
async def test_env_override_shadows_stored_in_get(client, container, make_agent, monkeypatch):
    monkeypatch.setenv("ORCHA_SECRET_KEY", "route-master-key")
    hid = await _human(make_agent)
    await client.put(f"/api/containers/{container['id']}/settings/llm-key",
                     json={"actor_agent_id": hid, "api_key": KEY})
    # Now an env override is present → GET must report source='env', masked from the env value.
    monkeypatch.setenv("ORCHA_LLM_API_KEY", "sk-env-override-9999")
    g = await client.get(f"/api/containers/{container['id']}/settings/llm-key")
    body = g.json()
    assert body["source"] == "env" and body["configured"] is True
    assert body["masked"] == "sk-...9999"
    assert body["set_at"] is None


@pytest.mark.asyncio
async def test_get_404_unknown_container(client):
    import uuid
    r = await client.get(f"/api/containers/{uuid.uuid4()}/settings/llm-key")
    assert r.status_code == 404, r.text


# ---- /test ping (provider monkeypatched: no live network, no real key) ----

class _FakeOK(llm_util.Provider):
    name = "anthropic"

    def complete(self, **_):
        return {"text": "ok", "tool_calls": [], "usage": {}, "stop_reason": "end_turn"}


class _Fake401(llm_util.Provider):
    name = "anthropic"

    def complete(self, **_):
        raise llm_util.LLMError("HTTP 401 from .../v1/messages: invalid x-api-key")


@pytest.mark.asyncio
async def test_test_route_ok(client, container, make_agent, monkeypatch):
    monkeypatch.setattr(llm_util, "get_provider", lambda name: _FakeOK())
    hid = await _human(make_agent)
    r = await client.post(f"/api/containers/{container['id']}/settings/llm-key/test",
                          json={"actor_agent_id": hid, "api_key": KEY})
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True


@pytest.mark.asyncio
async def test_test_route_bad_key(client, container, make_agent, monkeypatch):
    monkeypatch.setattr(llm_util, "get_provider", lambda name: _Fake401())
    hid = await _human(make_agent)
    r = await client.post(f"/api/containers/{container['id']}/settings/llm-key/test",
                          json={"actor_agent_id": hid, "api_key": "sk-bad"})
    body = r.json()
    assert r.status_code == 200 and body["ok"] is False
    assert "401" in body["detail"]


@pytest.mark.asyncio
async def test_test_route_no_key_to_test(client, container, make_agent, monkeypatch):
    monkeypatch.delenv("ORCHA_LLM_API_KEY", raising=False)
    hid = await _human(make_agent)
    r = await client.post(f"/api/containers/{container['id']}/settings/llm-key/test",
                          json={"actor_agent_id": hid})
    body = r.json()
    assert r.status_code == 200 and body["ok"] is False
    assert "no API key" in body["detail"]


@pytest.mark.asyncio
async def test_test_route_requires_human(client, container, make_agent):
    aid = await _ai(make_agent)
    r = await client.post(f"/api/containers/{container['id']}/settings/llm-key/test",
                          json={"actor_agent_id": aid, "api_key": KEY})
    assert r.status_code == 403, r.text


# ---- migration 020 shape + install copy ----

def test_migration_020_added_columns(db):
    cols = {row["column_name"] for row in db.execute(
        "SELECT column_name FROM information_schema.columns WHERE table_name='containers'")}
    assert {"llm_api_key_enc", "llm_api_key_hint", "llm_api_key_set_at"} <= cols


def test_install_copies_secret_box_byte_identical(tmp_path):
    """The portal build dir must get a byte-identical copy of the single git source (same
    single-source guarantee llm_util has — so the portal `import secret_box` can't drift)."""
    from orcha_cli.__main__ import _install_llm_util, PKG_ROOT
    _install_llm_util(tmp_path)
    copied = (tmp_path / "portal" / "secret_box.py").read_bytes()
    assert copied == (PKG_ROOT / "secret_box.py").read_bytes()
