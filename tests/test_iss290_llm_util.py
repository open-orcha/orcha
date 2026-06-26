"""Orcha#290 — universal LLM utility client.

Pure unit tests, no network and no live key: a FakeProvider is injected via the ``provider=``
override on every call shape. Covers spec resolution + config override, credential precedence,
the two call shapes (one-shot structured classify / triage fail-open; streaming tool-use +
collect), provider stubs, Anthropic response/stream normalisation, and the portal scaffold copy.
"""
import json
import logging

import pytest

from orcha_cli import llm_util as L


# --------------------------------------------------------------- fakes / helpers


class FakeProvider(L.Provider):
    """Records the last request and replays canned output. No network."""

    name = "fake"

    def __init__(self, *, complete_result=None, stream_events=None, raise_exc=None):
        self._complete_result = complete_result
        self._stream_events = stream_events or []
        self._raise = raise_exc
        self.calls = []

    def complete(self, *, spec, system, messages, tools=None, tool_choice=None, api_key):
        self.calls.append({"kind": "complete", "spec": spec, "system": system,
                           "messages": messages, "tools": tools, "tool_choice": tool_choice,
                           "api_key": api_key})
        if self._raise:
            raise self._raise
        return self._complete_result

    def stream(self, *, spec, system, messages, tools=None, tool_choice=None, api_key):
        self.calls.append({"kind": "stream", "spec": spec, "tools": tools})
        if self._raise:
            raise self._raise
        yield from self._stream_events


def _tool_response(name, payload, *, usage=None):
    return {"text": "", "tool_calls": [{"name": name, "input": payload}],
            "usage": usage or {"input_tokens": 10, "output_tokens": 5}, "stop_reason": "tool_use"}


# ----------------------------------------------------------------- model specs


def test_use_case_defaults_triage_is_cheap_haiku():
    spec = L.resolve_spec("triage")
    assert spec.provider == "anthropic" and spec.model == L.MODEL_HAIKU
    assert spec.max_tokens <= 256  # tightly bounded for high volume


def test_use_case_defaults_onboarding_is_capable():
    spec = L.resolve_spec("onboarding")
    assert spec.model == L.MODEL_SONNET and spec.max_tokens >= 8192


def test_unknown_use_case_falls_back_not_crash():
    spec = L.resolve_spec("totally-unknown")
    assert spec.provider == "anthropic" and spec.model  # a usable default


def test_config_override_is_partial_swap():
    # Only model overridden; provider/budget keep the default.
    spec = L.resolve_spec("triage", config={"triage": {"model": "claude-opus-4-8"}})
    assert spec.model == "claude-opus-4-8"
    assert spec.provider == "anthropic" and spec.max_tokens == L.resolve_spec("triage").max_tokens


def test_modelspec_swap_ignores_none():
    base = L.ModelSpec(model="m", max_tokens=100)
    assert base.swap(model=None, max_tokens=200) == L.ModelSpec(model="m", max_tokens=200)


# ----------------------------------------------------------------- credentials


def test_api_key_precedence(monkeypatch):
    monkeypatch.delenv("ORCHA_LLM_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    # explicit wins
    assert L.resolve_api_key("anthropic", explicit="X") == "X"
    # ORCHA key is provider-neutral and preferred over the provider env var
    monkeypatch.setenv("ANTHROPIC_API_KEY", "anth")
    monkeypatch.setenv("ORCHA_LLM_API_KEY", "orcha")
    assert L.resolve_api_key("anthropic") == "orcha"
    # fall back to the provider's conventional env var
    monkeypatch.delenv("ORCHA_LLM_API_KEY", raising=False)
    assert L.resolve_api_key("anthropic") == "anth"


def test_api_key_missing_raises(monkeypatch):
    monkeypatch.delenv("ORCHA_LLM_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(L.LLMError):
        L.resolve_api_key("anthropic")


# -------------------------------------------------------- call shape (a) classify


def test_classify_returns_tool_input_and_forces_tool():
    prov = FakeProvider(complete_result=_tool_response("emit_result", {"label": "spam"}))
    out = L.classify("triage", system="sys", user="hello", schema={"type": "object"}, provider=prov)
    assert out == {"label": "spam"}
    sent = prov.calls[0]
    # forces a single tool + tool_choice so the model MUST return structured JSON
    assert sent["tool_choice"] == {"type": "tool", "name": "emit_result"}
    assert sent["tools"][0]["name"] == "emit_result"


def test_classify_no_tool_call_raises():
    prov = FakeProvider(complete_result={"text": "no tool", "tool_calls": [], "usage": {}})
    with pytest.raises(L.LLMError):
        L.classify("triage", system=None, user="x", schema={}, provider=prov)


def test_classify_wrong_tool_name_raises_no_positional_fallback():
    # A forced tool call must match the EXACT requested tool. A wrong-named tool's
    # output must NOT be accepted via a positional fallback (calls[0]) — that would
    # let malformed {wake:false} slip through as valid. Mutation guard: restore the
    # old `calls[0] if calls else None` fallback and this test goes RED.
    prov = FakeProvider(complete_result=_tool_response("WRONG_TOOL", {"wake": False}))
    with pytest.raises(L.LLMError):
        L.classify("triage", system=None, user="x", schema={}, tool_name="emit_result", provider=prov)


def test_classify_with_injected_provider_needs_no_key(monkeypatch):
    # provider injected -> resolve_api_key must NOT be consulted (no env key present)
    monkeypatch.delenv("ORCHA_LLM_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    prov = FakeProvider(complete_result=_tool_response("emit_result", {"ok": True}))
    assert L.classify("triage", system=None, user="x", schema={}, provider=prov) == {"ok": True}


# ------------------------------------------------------------- triage_wake


def test_triage_wake_success_passthrough():
    prov = FakeProvider(complete_result=_tool_response(
        "emit_result", {"wake": False, "reason": "pure ack"}))
    assert L.triage_wake("k thx", provider=prov) == {"wake": False, "reason": "pure ack"}


def test_triage_wake_fails_open_on_error():
    prov = FakeProvider(raise_exc=RuntimeError("boom"))
    out = L.triage_wake("anything", provider=prov)
    assert out["wake"] is True and out["reason"].startswith("fail-open:")


def test_triage_wake_fails_open_on_garbage_tool():
    # model returns no tool call -> classify raises -> triage still fails OPEN
    prov = FakeProvider(complete_result={"text": "", "tool_calls": [], "usage": {}})
    assert L.triage_wake("x", provider=prov)["wake"] is True


def test_triage_wake_defaults_wake_true_if_field_absent():
    prov = FakeProvider(complete_result=_tool_response("emit_result", {"reason": "no wake field"}))
    assert L.triage_wake("x", provider=prov)["wake"] is True


def test_triage_wake_fails_open_on_wrong_tool_carrying_false():
    # Malformed: model emits a WRONG-named tool whose payload says {wake:false}.
    # classify() must reject the wrong tool (LLMError) -> triage fails OPEN, NOT skip.
    # Mutation guard: positional fallback in classify() would make this {wake:False}.
    prov = FakeProvider(complete_result=_tool_response("WRONG_TOOL", {"wake": False}))
    assert L.triage_wake("x", provider=prov)["wake"] is True


def test_triage_wake_fails_open_on_null_wake():
    # {wake: null} is malformed. bool(None) is False would SUPPRESS a wake — the exact
    # expensive failure mode. Only an explicit boolean False may skip. Mutation guard:
    # `bool(result.get("wake", True))` makes this RED ({wake:False}).
    prov = FakeProvider(complete_result=_tool_response("emit_result", {"wake": None, "reason": "r"}))
    assert L.triage_wake("x", provider=prov)["wake"] is True


def test_triage_wake_fails_open_on_nonbool_wake():
    # A truthy-but-non-bool value ("false" string, 0, etc.) is still malformed output.
    # Anything that isn't literally False wakes. The string "false" is truthy in Python,
    # so the old bool() coercion happened to wake — but 0 would have skipped; assert both.
    for bad in ("false", 0, "", []):
        prov = FakeProvider(complete_result=_tool_response("emit_result", {"wake": bad}))
        assert L.triage_wake("x", provider=prov)["wake"] is True, f"non-bool {bad!r} must fail open"


# ------------------------------------------------------------- providers


def test_stub_providers_raise_not_implemented():
    for name in ("openai", "gemini"):
        prov = L.get_provider(name)
        with pytest.raises(L.ProviderNotImplemented):
            prov.complete(spec=L.resolve_spec("triage"), system=None, messages=[], api_key="k")


def test_get_provider_unknown_raises():
    with pytest.raises(L.LLMError):
        L.get_provider("nope")


def test_get_provider_anthropic_is_live_class():
    assert isinstance(L.get_provider("anthropic"), L.AnthropicProvider)


# ------------------------------------------------------------- xAI / Grok provider


def test_get_provider_xai_is_live_class():
    assert isinstance(L.get_provider("xai"), L.GrokProvider)


def test_resolve_api_key_xai_fallback(monkeypatch):
    # No Orcha-managed key -> the provider's conventional env var (XAI_API_KEY) is used.
    monkeypatch.delenv("ORCHA_LLM_API_KEY", raising=False)
    monkeypatch.setenv("XAI_API_KEY", "xai-secret")
    assert L.resolve_api_key("xai") == "xai-secret"


def test_grok_request_translates_to_openai_framing(monkeypatch):
    # Forced tool call: Anthropic-shaped tools/tool_choice must become OpenAI function framing,
    # and the system prompt must lead the messages as a {"role":"system"} turn.
    captured = {}

    def fake_post(url, headers, body, *, timeout_s):
        captured["url"] = url
        captured["headers"] = headers
        captured["body"] = body
        return {"choices": [{"message": {"content": "", "tool_calls": [
            {"function": {"name": "emit_result",
                          "arguments": json.dumps({"label": "spam"})}}]},
            "finish_reason": "tool_calls"}],
            "usage": {"prompt_tokens": 11, "completion_tokens": 7}}

    monkeypatch.setattr(L, "_http_post_json", fake_post)
    prov = L.GrokProvider()
    resp = prov.complete(
        spec=L.resolve_spec("triage"), system="sys",
        messages=[{"role": "user", "content": "hi"}],
        tools=[{"name": "emit_result", "description": "d", "input_schema": {"type": "object"}}],
        tool_choice={"type": "tool", "name": "emit_result"}, api_key="k")
    assert captured["url"].endswith("/chat/completions")
    assert captured["headers"]["authorization"] == "Bearer k"
    assert captured["body"]["messages"][0] == {"role": "system", "content": "sys"}
    assert captured["body"]["tools"][0]["type"] == "function"
    assert captured["body"]["tools"][0]["function"]["name"] == "emit_result"
    assert captured["body"]["tool_choice"] == {"type": "function",
                                               "function": {"name": "emit_result"}}
    # OpenAI response normalises to the module's shape (text/tool_calls/usage).
    assert resp["tool_calls"] == [{"name": "emit_result", "input": {"label": "spam"}}]
    assert resp["usage"] == {"input_tokens": 11, "output_tokens": 7}


def test_grok_classify_end_to_end_via_live_provider(monkeypatch):
    # classify() over the real GrokProvider transport (HTTP faked) returns the tool input dict.
    monkeypatch.setattr(L, "_http_post_json", lambda *a, **k: {
        "choices": [{"message": {"tool_calls": [
            {"function": {"name": "emit_result", "arguments": '{"wake": true, "reason": "q"}'}}]},
            "finish_reason": "tool_calls"}],
        "usage": {"prompt_tokens": 5, "completion_tokens": 3}})
    out = L.classify("triage", system="s", user="u", schema=L.TRIAGE_SCHEMA,
                     provider=L.GrokProvider(), api_key="k")
    assert out == {"wake": True, "reason": "q"}


def test_grok_stream_normalises_openai_tool_deltas(monkeypatch):
    # OpenAI streams the tool name once, arguments as fragments, and closes via finish_reason.
    # The normalised events must reassemble via collect_tool_call.
    chunks = [
        {"choices": [{"delta": {"tool_calls": [
            {"index": 0, "id": "c1", "function": {"name": "propose", "arguments": '{"a":'}}]}}]},
        {"choices": [{"delta": {"tool_calls": [
            {"index": 0, "function": {"arguments": '1}'}}]}}]},
        {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]},
        {"choices": [], "usage": {"completion_tokens": 4}},
    ]
    monkeypatch.setattr(L, "_http_post_sse", lambda *a, **k: iter(chunks))
    events = list(L.GrokProvider().stream(
        spec=L.resolve_spec("onboarding"), system=None,
        messages=[{"role": "user", "content": "x"}],
        tools=[{"name": "propose", "input_schema": {}}],
        tool_choice={"type": "tool", "name": "propose"}, api_key="k"))
    assert L.collect_tool_call(events, "propose") == {"name": "propose", "input": {"a": 1}}
    assert any(e["type"] == "usage" and e.get("output_tokens") == 4 for e in events)


# --------------------------------------------- call shape (b) stream + tool-use


def _roster_stream(partials, *, index=0):
    yield {"type": "tool_start", "index": index, "name": "propose_roster", "id": "t1"}
    for frag in partials:
        yield {"type": "tool_input_delta", "index": index, "partial_json": frag}
    yield {"type": "tool_stop", "index": index}
    yield {"type": "usage", "output_tokens": 42}


def test_stream_and_collect_tool_call_assembles_input():
    events = list(_roster_stream(['{"roles":', ' ["dev",', ' "qa"]}']))
    prov = FakeProvider(stream_events=events)
    streamed = list(L.stream_tool_call("onboarding", system="s", messages=[{"role": "user", "content": "x"}],
                                       tools=[{"name": "propose_roster", "input_schema": {}}], provider=prov))
    call = L.collect_tool_call(streamed, "propose_roster")
    assert call == {"name": "propose_roster", "input": {"roles": ["dev", "qa"]}}


def test_collect_tool_call_filters_by_name():
    events = list(_roster_stream(['{}']))
    assert L.collect_tool_call(events, "other_tool") is None


def test_collect_tool_call_incomplete_returns_none():
    # no tool_stop -> not assembled
    events = [{"type": "tool_start", "index": 0, "name": "propose_roster"},
              {"type": "tool_input_delta", "index": 0, "partial_json": '{"a":1}'}]
    assert L.collect_tool_call(events) is None


def test_tool_call_diagnostics_reports_incomplete_and_bad_json():
    incomplete = [{"type": "tool_start", "index": 0, "name": "propose_roster"},
                  {"type": "tool_input_delta", "index": 0, "partial_json": '{"a":1}'}]
    d1 = L.tool_call_diagnostics(incomplete, "propose_roster")
    assert d1["started"] is True and d1["completed"] is False

    bad_json = [{"type": "tool_start", "index": 0, "name": "propose_roster"},
                {"type": "tool_input_delta", "index": 0, "partial_json": '{"a":'},
                {"type": "tool_stop", "index": 0},
                {"type": "usage", "output_tokens": 8192, "stop_reason": "max_tokens"}]
    d2 = L.tool_call_diagnostics(bad_json, "propose_roster")
    assert d2["started"] is True and d2["completed"] is True
    assert d2["json_error"] is True
    assert d2["stop_reason"] == "max_tokens"
    assert d2["output_tokens"] == 8192


def test_stream_tool_call_propagates_error():
    prov = FakeProvider(raise_exc=RuntimeError("stream boom"))
    with pytest.raises(RuntimeError):
        list(L.stream_tool_call("onboarding", system=None, messages=[], tools=[], provider=prov))


# ------------------------------------------------- Anthropic normalisation


def test_normalise_response_splits_text_and_tools():
    raw = {"content": [{"type": "text", "text": "hi "}, {"type": "text", "text": "there"},
                       {"type": "tool_use", "name": "emit_result", "input": {"a": 1}}],
           "usage": {"input_tokens": 7, "output_tokens": 3}, "stop_reason": "tool_use"}
    out = L._normalise_anthropic_response(raw)
    assert out["text"] == "hi there"
    assert out["tool_calls"] == [{"name": "emit_result", "input": {"a": 1}}]
    assert out["usage"] == {"input_tokens": 7, "output_tokens": 3}


def test_normalise_stream_events_map_to_normalised():
    raw_seq = [
        {"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "name": "propose_roster", "id": "t"}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": '{"x":1}'}},
        {"type": "content_block_stop", "index": 0},
        {"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 9}},
    ]
    got = [ev for raw in raw_seq for ev in L._normalise_anthropic_stream_event(raw)]
    types = [e["type"] for e in got]
    assert types == ["tool_start", "tool_input_delta", "tool_stop", "usage"]
    assert got[-1]["stop_reason"] == "tool_use"
    # end-to-end: the normalised stream feeds collect_tool_call
    assert L.collect_tool_call(got, "propose_roster") == {"name": "propose_roster", "input": {"x": 1}}


def test_normalise_stream_text_delta():
    ev = list(L._normalise_anthropic_stream_event(
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "hello"}}))
    assert ev == [{"type": "text_delta", "text": "hello"}]


# ------------------------------------------------------------- observability


def test_call_emits_structured_log_record(caplog):
    prov = FakeProvider(complete_result=_tool_response("emit_result", {"wake": True, "reason": "q"}))
    with caplog.at_level(logging.INFO, logger="orcha.llm"):
        L.triage_wake("question?", provider=prov)
    recs = [json.loads(r.message) for r in caplog.records if r.name == "orcha.llm"]
    assert recs and recs[-1]["event"] == "llm_call"
    assert recs[-1]["use_case"] == "triage" and recs[-1]["outcome"] == "ok"
    assert recs[-1]["output_tokens"] == 5


def test_fail_open_is_logged_as_such(caplog):
    prov = FakeProvider(raise_exc=RuntimeError("boom"))
    with caplog.at_level(logging.INFO, logger="orcha.llm"):
        L.triage_wake("x", provider=prov)
    outcomes = [json.loads(r.message)["outcome"] for r in caplog.records if r.name == "orcha.llm"]
    assert "fail_open" in outcomes


# ---------------------------------------------------- portal scaffold copy


def test_install_llm_util_copies_module_into_portal(tmp_path):
    from orcha_cli.__main__ import _install_llm_util, _PORTAL_SHARED_MODULES
    # #287 rides the same shared-module installer as llm_util (#290) / secret_box (#294).
    assert "digest_curate.py" in _PORTAL_SHARED_MODULES
    _install_llm_util(tmp_path)
    # each copy is byte-identical to the single git source the host imports.
    from importlib.resources import files
    for mod in _PORTAL_SHARED_MODULES:
        copied = tmp_path / "portal" / mod
        assert copied.exists()
        canonical = files("orcha_cli") / mod
        assert copied.read_bytes() == canonical.read_bytes()
