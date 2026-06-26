"""#294 (SETTINGS epic) — per-use-case universal-client model selection: store + catalog + wiring.

Four surfaces, all exercised here:
  * llm_util catalog + registry (provider_catalog / use_case_registry / is_catalog_choice) —
    pure unit, no DB, no network.
  * the HTTP routes GET .../settings/providers, GET/PUT .../settings/models — human-gating,
    catalog validation (no stubbed-provider / bogus-model writes), and FULL-REPLACE semantics.
  * GET /wake-scan surfaces the resolved per-container `triage_model` (the efficiency hook).
  * notifier wiring (_triage_config_from_scan + _triage_wake config forwarding) — the daemon
    triages with the CONFIGURED model, fail-open to the #290 default.

Same committed-isolation harness as the other route suites (conftest applies every migration,
including 022).
"""
import pathlib
import sys
import uuid

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "orcha-cli"))
from orcha_cli import llm_util  # noqa: E402
from orcha_cli import notifier  # noqa: E402


# ============================ llm_util catalog + registry (unit) ============================

def test_provider_catalog_shape():
    cat = llm_util.provider_catalog()
    by_id = {p["id"]: p for p in cat}
    assert by_id["anthropic"]["available"] is True
    assert by_id["xai"]["available"] is True  # Grok is a live universal-client provider
    assert by_id["openai"]["available"] is False and by_id["gemini"]["available"] is False
    # Anthropic lists the live Claude family; xAI lists the Grok family; stubs list no models.
    anth_models = {m["id"] for m in by_id["anthropic"]["models"]}
    assert {llm_util.MODEL_HAIKU, llm_util.MODEL_SONNET, llm_util.MODEL_OPUS} <= anth_models
    assert llm_util.MODEL_GROK_4 in {m["id"] for m in by_id["xai"]["models"]}
    assert by_id["openai"]["models"] == []


def test_provider_catalog_is_a_copy():
    """Mutating the returned catalog must not corrupt the module constant."""
    cat = llm_util.provider_catalog()
    cat[0]["models"].clear()
    assert llm_util.provider_catalog()[0]["models"], "module constant was mutated"


def test_is_catalog_choice():
    assert llm_util.is_catalog_choice("anthropic", llm_util.MODEL_HAIKU) is True
    assert llm_util.is_catalog_choice("anthropic", "claude-made-up-99") is False  # bogus model
    assert llm_util.is_catalog_choice("xai", llm_util.MODEL_GROK_4) is True        # live Grok model
    assert llm_util.is_catalog_choice("openai", "gpt-x") is False                 # stubbed provider
    assert llm_util.is_catalog_choice("nope", llm_util.MODEL_HAIKU) is False      # unknown provider


def test_use_case_registry_defaults_match_resolver():
    """The page's 'default: X' chip must be exactly what resolve_spec falls back to."""
    reg = {uc["key"]: uc for uc in llm_util.use_case_registry()}
    assert reg["triage"]["default_model"] == llm_util.resolve_spec("triage").model
    assert reg["onboarding"]["default_model"] == llm_util.resolve_spec("onboarding").model
    assert reg["triage"]["default_model"] == llm_util.MODEL_HAIKU  # cheap triage default


# ============================ routes (DB + ASGI) ============================

async def _human(make_agent):
    h = await make_agent("Operator", kind="human")
    return h["agent_id"]


async def _ai(make_agent):
    a = await make_agent("Bot", kind="ai")
    return a["agent_id"]


@pytest.mark.asyncio
async def test_get_providers(client, container):
    r = await client.get(f"/api/containers/{container['id']}/settings/providers")
    assert r.status_code == 200, r.text
    ids = {p["id"] for p in r.json()["providers"]}
    assert {"anthropic", "xai", "openai", "gemini"} == ids


@pytest.mark.asyncio
async def test_get_models_initial_all_default(client, container):
    r = await client.get(f"/api/containers/{container['id']}/settings/models")
    assert r.status_code == 200, r.text
    ucs = {u["key"]: u for u in r.json()["use_cases"]}
    # #307 registered the cheap 'ack' use-case (graded-wake T2) — it appears on the Settings page
    # with zero page edits, the same way triage/onboarding do.
    assert set(ucs) == {"onboarding", "triage", "ack"}
    for u in ucs.values():
        assert u["is_set"] is False and u["provider"] is None and u["model"] is None
        assert u["default_provider"] == "anthropic" and u["default_model"]
        assert u["label"] and u["purpose"]   # registered copy ships with the row


@pytest.mark.asyncio
async def test_put_then_get_override(client, container, make_agent):
    hid = await _human(make_agent)
    r = await client.put(
        f"/api/containers/{container['id']}/settings/models",
        json={"actor_agent_id": hid,
              "use_cases": [{"key": "triage", "provider": "anthropic", "model": llm_util.MODEL_SONNET}]},
    )
    assert r.status_code == 200, r.text
    triage = next(u for u in r.json()["use_cases"] if u["key"] == "triage")
    assert triage["is_set"] is True and triage["model"] == llm_util.MODEL_SONNET

    g = await client.get(f"/api/containers/{container['id']}/settings/models")
    triage = next(u for u in g.json()["use_cases"] if u["key"] == "triage")
    assert triage["is_set"] is True and triage["provider"] == "anthropic"
    # the untouched use-case stays on its default
    onb = next(u for u in g.json()["use_cases"] if u["key"] == "onboarding")
    assert onb["is_set"] is False


@pytest.mark.asyncio
async def test_put_requires_human(client, container, make_agent):
    aid = await _ai(make_agent)
    r = await client.put(
        f"/api/containers/{container['id']}/settings/models",
        json={"actor_agent_id": aid,
              "use_cases": [{"key": "triage", "provider": "anthropic", "model": llm_util.MODEL_HAIKU}]},
    )
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_put_rejects_stubbed_provider(client, container, make_agent):
    hid = await _human(make_agent)
    r = await client.put(
        f"/api/containers/{container['id']}/settings/models",
        json={"actor_agent_id": hid,
              "use_cases": [{"key": "triage", "provider": "openai", "model": "gpt-x"}]},
    )
    assert r.status_code == 400, r.text


@pytest.mark.asyncio
async def test_put_rejects_bogus_model(client, container, make_agent):
    hid = await _human(make_agent)
    r = await client.put(
        f"/api/containers/{container['id']}/settings/models",
        json={"actor_agent_id": hid,
              "use_cases": [{"key": "triage", "provider": "anthropic", "model": "claude-not-real"}]},
    )
    assert r.status_code == 400, r.text


@pytest.mark.asyncio
async def test_put_rejects_unknown_use_case(client, container, make_agent):
    hid = await _human(make_agent)
    r = await client.put(
        f"/api/containers/{container['id']}/settings/models",
        json={"actor_agent_id": hid,
              "use_cases": [{"key": "not-a-use-case", "provider": "anthropic", "model": llm_util.MODEL_HAIKU}]},
    )
    assert r.status_code == 400, r.text


@pytest.mark.asyncio
async def test_put_rejects_partial_pair(client, container, make_agent):
    """provider set but model missing (and vice versa) is a 400 — both or neither."""
    hid = await _human(make_agent)
    r = await client.put(
        f"/api/containers/{container['id']}/settings/models",
        json={"actor_agent_id": hid, "use_cases": [{"key": "triage", "provider": "anthropic"}]},
    )
    assert r.status_code == 400, r.text


@pytest.mark.asyncio
async def test_put_full_replace_resets_omitted(client, container, make_agent):
    """SPEC §2.2 full-replace: a key omitted from the next PUT is reset to default."""
    hid = await _human(make_agent)
    await client.put(
        f"/api/containers/{container['id']}/settings/models",
        json={"actor_agent_id": hid,
              "use_cases": [{"key": "triage", "provider": "anthropic", "model": llm_util.MODEL_SONNET}]},
    )
    # second PUT with an EMPTY set must clear the prior override
    r = await client.put(
        f"/api/containers/{container['id']}/settings/models",
        json={"actor_agent_id": hid, "use_cases": []},
    )
    assert r.status_code == 200, r.text
    triage = next(u for u in r.json()["use_cases"] if u["key"] == "triage")
    assert triage["is_set"] is False


@pytest.mark.asyncio
async def test_put_null_entry_resets(client, container, make_agent):
    """An explicit {key, null, null} entry is a reset (same as omission)."""
    hid = await _human(make_agent)
    await client.put(
        f"/api/containers/{container['id']}/settings/models",
        json={"actor_agent_id": hid,
              "use_cases": [{"key": "triage", "provider": "anthropic", "model": llm_util.MODEL_SONNET}]},
    )
    r = await client.put(
        f"/api/containers/{container['id']}/settings/models",
        json={"actor_agent_id": hid, "use_cases": [{"key": "triage", "provider": None, "model": None}]},
    )
    triage = next(u for u in r.json()["use_cases"] if u["key"] == "triage")
    assert triage["is_set"] is False


# ============================ wake-scan surfaces triage_model (the wiring) ============================

@pytest.mark.asyncio
async def test_wake_scan_triage_model_null_when_unset(client, container):
    r = await client.get(f"/api/containers/{container['id']}/wake-scan")
    assert r.status_code == 200, r.text
    assert r.json()["triage_model"] is None


@pytest.mark.asyncio
async def test_wake_scan_surfaces_configured_triage_model(client, container, make_agent):
    hid = await _human(make_agent)
    await client.put(
        f"/api/containers/{container['id']}/settings/models",
        json={"actor_agent_id": hid,
              "use_cases": [{"key": "triage", "provider": "anthropic", "model": llm_util.MODEL_SONNET}]},
    )
    r = await client.get(f"/api/containers/{container['id']}/wake-scan")
    tm = r.json()["triage_model"]
    assert tm == {"provider": "anthropic", "model": llm_util.MODEL_SONNET}


# ============================ migration 022 shape ============================

def test_migration_022_table_exists(db):
    cols = {row["column_name"] for row in db.execute(
        "SELECT column_name FROM information_schema.columns WHERE table_name='container_model_settings'")}
    assert {"container_id", "use_case_key", "provider", "model", "set_at"} <= cols


# ============================ notifier wiring (unit) ============================

def test_triage_config_from_scan_maps_to_resolve_spec_shape():
    scan = {"triage_model": {"provider": "anthropic", "model": llm_util.MODEL_SONNET}}
    cfg = notifier._triage_config_from_scan(scan)
    assert cfg == {"triage": {"provider": "anthropic", "model": llm_util.MODEL_SONNET}}
    # and that shape actually swaps the model in resolve_spec (the whole point)
    assert llm_util.resolve_spec("triage", config=cfg).model == llm_util.MODEL_SONNET


def test_triage_config_from_scan_none_when_unset():
    assert notifier._triage_config_from_scan({"triage_model": None}) is None
    assert notifier._triage_config_from_scan({}) is None
    assert notifier._triage_config_from_scan({"triage_model": {}}) is None  # malformed -> default


def test_triage_wake_forwards_config(monkeypatch):
    """_triage_wake must thread `config` into llm_util.triage_wake so the configured model is used."""
    captured = {}

    def _fake_triage(event_text, *, config=None):
        captured["config"] = config
        return {"wake": True, "reason": "stub"}

    monkeypatch.setattr(notifier._llm_util, "triage_wake", _fake_triage)
    cfg = {"triage": {"provider": "anthropic", "model": llm_util.MODEL_OPUS}}
    notifier._triage_wake("hello", config=cfg)
    assert captured["config"] == cfg


# ============================ runtime tick binding (Gate 2nd-pass tooth) ============================

def test_tick_binds_scan_triage_model_into_suppression_triage(monkeypatch):
    """TOOTH (Gate 2nd-pass P1 gap): the unit tests above prove _triage_config_from_scan and
    _triage_wake INDIVIDUALLY thread the override, but NOTHING exercised the runtime tick binding
    at notifier.py:1741-1742 that actually wires them together for the #288 suppression path:

        _triage_config = _triage_config_from_scan(scan)
        _scan_triage_fn = (lambda text: _triage_wake(text, config=_triage_config))
        ... decide_wake_suppression(cand, triage_fn=_scan_triage_fn)

    This drives a real EPHEMERAL candidate carrying an llm-tier triage_hint through tick(), with the
    scan carrying a configured per-container `triage_model`, and asserts the config that reaches
    llm_util.triage_wake is exactly {triage: <scan triage_model>}. So a CONFIGURED triage model is
    proven to reach the wake-suppression triage end-to-end, not just in isolation.

    MUTATION: drop `config=_triage_config` from the _scan_triage_fn binding (the exact mutation Gate
    ran) -> triage_wake is called with config=None -> captured["config"] is None -> RED. With the
    binding intact -> the scan override is threaded through -> GREEN."""
    captured = {}

    def _fake_triage(event_text, *, config=None):
        captured["config"] = config
        return {"wake": False, "reason": "pure ack"}   # suppress -> no spawn, stays off the network

    monkeypatch.setattr(notifier._llm_util, "triage_wake", _fake_triage)
    monkeypatch.setattr(notifier, "select_transport", lambda c: "ephemeral")
    # _suppress_wake only POSTs (triage-close + wake-ack); stub the network so tick stays hermetic.
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: {})

    triage_model = {"provider": "anthropic", "model": llm_util.MODEL_SONNET}
    cand = {"agent_id": "00000000-0000-0000-0000-000000000001", "alias": "E",
            "should_wake": True, "headless_cwd": "/tmp/x", "tmux_target": None,
            "wake_enabled": True, "pending_events": 1, "auto_start_task_ids": [],
            "reason": "wake", "latest_event": "request_answered", "max_event_ts": 5.0,
            "ack_through_ts": 5.0, "headless_flags": None,
            # an llm-tier hint decide_wake_suppression routes through triage_fn (the bound lambda)
            "triage_hint": {"tier": "llm", "text": "thanks, no action", "request_id": "req-1"}}
    monkeypatch.setattr(notifier, "_get_json",
                        lambda url, **k: {"active": True, "candidates": [cand],
                                          "triage_model": triage_model})

    out = notifier.tick("http://x", "cid", dry_run=False, cooldown=15, min_idle=0, quiet=True)

    # the configured scan triage_model was threaded all the way into the triage call...
    assert captured["config"] == {"triage": triage_model}
    # ...and the (wake=False) verdict took effect: the ephemeral spawn was suppressed, not woken.
    assert out["woke"][0]["sent"] is False
    assert out["woke"][0]["kind"] == "skipped"
