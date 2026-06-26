"""Per-provider LLM API keys (multi-provider settings, follow-on to #294 Item 1).

Migration 020 gave a container ONE key (implicitly Anthropic). With >1 live provider in the #290
catalog (Anthropic + xAI/Grok), a use-case pointed at xAI needs its own key. These routes manage
one key per AVAILABLE catalog provider:

  * GET    /api/containers/{cid}/settings/provider-keys              -> one status row per provider
  * PUT    /api/containers/{cid}/settings/provider-keys/{provider}   -> seal + store (human-gated)
  * DELETE /api/containers/{cid}/settings/provider-keys/{provider}   -> clear (human-gated)
  * POST   /api/containers/{cid}/settings/provider-keys/{provider}/test -> credential ping

Covers: catalog-scoped listing, per-provider isolation (an xAI key never shows as Anthropic and
vice-versa), Anthropic stored in the same unified table (migration 027), human-gating, availability
+ master-key validation, env-override shadowing, and the /test ping (provider monkeypatched).

Same committed-isolation harness as the other route suites (conftest applies every migration,
including 027).
"""
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "orcha-cli"))
from orcha_cli import llm_util  # noqa: E402

ANTHROPIC_KEY = "sk-ant-api03-EXAMPLE-1234"
XAI_KEY = "xai-EXAMPLE-grok-key-9876"


async def _human(make_agent):
    h = await make_agent("Operator", kind="human")
    return h["agent_id"]


async def _ai(make_agent):
    a = await make_agent("Bot", kind="ai")
    return a["agent_id"]


def _by_provider(payload):
    return {k["provider"]: k for k in payload["keys"]}


@pytest.mark.asyncio
async def test_list_covers_available_providers_unconfigured(client, container, monkeypatch):
    monkeypatch.delenv("ORCHA_LLM_API_KEY", raising=False)
    r = await client.get(f"/api/containers/{container['id']}/settings/provider-keys")
    assert r.status_code == 200, r.text
    by = _by_provider(r.json())
    # every AVAILABLE catalog provider appears; stubbed (openai/gemini) do not
    assert "anthropic" in by and "xai" in by
    assert "openai" not in by and "gemini" not in by
    for entry in by.values():
        assert entry["configured"] is False and entry["masked"] is None


@pytest.mark.asyncio
async def test_put_xai_then_get_is_isolated_from_anthropic(client, container, make_agent, monkeypatch):
    monkeypatch.delenv("ORCHA_LLM_API_KEY", raising=False)
    monkeypatch.setenv("ORCHA_SECRET_KEY", "route-master-key")
    hid = await _human(make_agent)
    r = await client.put(f"/api/containers/{container['id']}/settings/provider-keys/xai",
                         json={"actor_agent_id": hid, "api_key": XAI_KEY})
    assert r.status_code == 200, r.text
    assert r.json()["provider"] == "xai" and r.json()["masked"] == "sk-...9876"

    by = _by_provider((await client.get(
        f"/api/containers/{container['id']}/settings/provider-keys")).json())
    # xai is configured; anthropic is NOT — the two keys are independent slots
    assert by["xai"]["configured"] is True and by["xai"]["source"] == "db"
    assert by["anthropic"]["configured"] is False


@pytest.mark.asyncio
async def test_anthropic_put_via_llm_key_route_surfaces_in_unified_list(client, container, make_agent, monkeypatch):
    """An Anthropic key set via the /settings/llm-key route surfaces in the unified provider-keys
    list — proving Anthropic now lives in container_provider_keys too (migration 027), read uniformly."""
    monkeypatch.delenv("ORCHA_LLM_API_KEY", raising=False)
    monkeypatch.setenv("ORCHA_SECRET_KEY", "route-master-key")
    hid = await _human(make_agent)
    r = await client.put(f"/api/containers/{container['id']}/settings/llm-key",
                         json={"actor_agent_id": hid, "api_key": ANTHROPIC_KEY})
    assert r.status_code == 200, r.text
    by = _by_provider((await client.get(
        f"/api/containers/{container['id']}/settings/provider-keys")).json())
    assert by["anthropic"]["configured"] is True and by["xai"]["configured"] is False


@pytest.mark.asyncio
async def test_put_requires_human(client, container, make_agent, monkeypatch):
    monkeypatch.setenv("ORCHA_SECRET_KEY", "route-master-key")
    aid = await _ai(make_agent)
    r = await client.put(f"/api/containers/{container['id']}/settings/provider-keys/xai",
                         json={"actor_agent_id": aid, "api_key": XAI_KEY})
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_put_rejects_unavailable_provider(client, container, make_agent, monkeypatch):
    monkeypatch.setenv("ORCHA_SECRET_KEY", "route-master-key")
    hid = await _human(make_agent)
    r = await client.put(f"/api/containers/{container['id']}/settings/provider-keys/openai",
                         json={"actor_agent_id": hid, "api_key": "sk-x"})
    assert r.status_code == 400, r.text  # stubbed provider is not a catalog choice


@pytest.mark.asyncio
async def test_put_without_master_key_503(client, container, make_agent, monkeypatch):
    monkeypatch.delenv("ORCHA_SECRET_KEY", raising=False)
    monkeypatch.delenv("ORCHA_LLM_API_KEY", raising=False)
    hid = await _human(make_agent)
    r = await client.put(f"/api/containers/{container['id']}/settings/provider-keys/xai",
                         json={"actor_agent_id": hid, "api_key": XAI_KEY})
    assert r.status_code == 503, r.text


@pytest.mark.asyncio
async def test_delete_clears_only_that_provider(client, container, make_agent, monkeypatch):
    monkeypatch.delenv("ORCHA_LLM_API_KEY", raising=False)
    monkeypatch.setenv("ORCHA_SECRET_KEY", "route-master-key")
    hid = await _human(make_agent)
    await client.put(f"/api/containers/{container['id']}/settings/provider-keys/xai",
                     json={"actor_agent_id": hid, "api_key": XAI_KEY})
    d = await client.request("DELETE",
                             f"/api/containers/{container['id']}/settings/provider-keys/xai",
                             json={"actor_agent_id": hid})
    assert d.status_code == 200, d.text
    assert d.json()["configured"] is False
    by = _by_provider((await client.get(
        f"/api/containers/{container['id']}/settings/provider-keys")).json())
    assert by["xai"]["configured"] is False


@pytest.mark.asyncio
async def test_env_override_shadows_all_providers(client, container, make_agent, monkeypatch):
    monkeypatch.setenv("ORCHA_LLM_API_KEY", "sk-env-override-7777")
    by = _by_provider((await client.get(
        f"/api/containers/{container['id']}/settings/provider-keys")).json())
    # the global env override is reported as source='env' for every provider
    assert by["xai"]["source"] == "env" and by["anthropic"]["source"] == "env"
    assert by["xai"]["masked"] == "sk-...7777"


# ---- /test ping (provider monkeypatched: no live network, no real key) ----

class _FakeOK:
    def complete(self, **_):
        return {"text": "ok", "tool_calls": [], "usage": {}, "stop_reason": "end_turn"}


class _FakeBad:
    def complete(self, **_):
        raise llm_util.LLMError("HTTP 401 from xai: invalid key")


@pytest.mark.asyncio
async def test_test_route_ok_uses_selected_provider(client, container, make_agent, monkeypatch):
    monkeypatch.setattr(llm_util, "get_provider", lambda name: _FakeOK())
    hid = await _human(make_agent)
    r = await client.post(f"/api/containers/{container['id']}/settings/provider-keys/xai/test",
                          json={"actor_agent_id": hid, "api_key": XAI_KEY})
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True and "xAI" in r.json()["detail"]


@pytest.mark.asyncio
async def test_test_route_bad_key(client, container, make_agent, monkeypatch):
    monkeypatch.setattr(llm_util, "get_provider", lambda name: _FakeBad())
    hid = await _human(make_agent)
    r = await client.post(f"/api/containers/{container['id']}/settings/provider-keys/xai/test",
                          json={"actor_agent_id": hid, "api_key": "bad"})
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is False
