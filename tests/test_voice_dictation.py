"""Voice dictation (portal voice_routes): the streaming STT proxy, the batch fallback, the AI
clean-up pass, speech-provider keys, access, limits — with a FAKE upstream provider, so no
test ever touches the network.

Contract under test:
  * the browser streams PCM to /voice/stream; the portal forwards it to the provider with the
    project's sealed key and streams transcript text back — the key never reaches the client;
  * members only (trusted non-members and viewers are refused); stop → done, cancel → discard;
  * max-duration and per-person concurrency limits;
  * the clean-up never invents content (guarded) and always returns the raw words.
"""
import asyncio
import json
import os
import pathlib
import sys

import pytest
from starlette.testclient import TestClient

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "orcha-cli"))

import main  # noqa: E402
from portal_backend import voice_providers as vp  # noqa: E402
from portal_backend import voice_routes as vr  # noqa: E402

OPENAI_KEY = "sk-proj-SECRET-voice-key-ABCD"
SECRET_ENV = "e2e-throwaway-secret-key-for-voice-tests"


class FakeSession(vp.UpstreamSession):
    """Echo upstream: every 'hello'-sized chunk becomes a word; finish settles the text."""

    sample_rate = 24000
    instances: list = []

    def __init__(self, api_key, language):
        super().__init__()
        self.api_key = api_key
        self.language = language
        self.audio = bytearray()
        self.finished = False
        self.closed = False
        self.words: list[str] = []
        FakeSession.instances.append(self)

    async def send_audio(self, pcm):
        self.audio.extend(pcm)
        self.words.append(f"word{len(self.words) + 1}")
        self._emit({"type": "partial", "final": " ".join(self.words[:-1]), "text": self.words[-1]})

    async def finish(self):
        self.finished = True
        self._emit({"type": "final", "text": " ".join(self.words)})
        self._end()

    async def close(self):
        self.closed = True
        await super().close()


@pytest.fixture
def fake_upstream(monkeypatch):
    FakeSession.instances = []

    async def factory(api_key, language):
        return FakeSession(api_key, language)

    for pid in vp.PROVIDER_IDS:
        monkeypatch.setitem(vp.STREAM_FACTORIES, pid, factory)
    for env in ("OPENAI_API_KEY", "DEEPGRAM_API_KEY", "GROQ_API_KEY", "ORCHA_LLM_API_KEY"):
        monkeypatch.delenv(env, raising=False)
    monkeypatch.setenv("ORCHA_SECRET_KEY", SECRET_ENV)
    vr.LIMITER.reset()
    yield FakeSession
    vr.LIMITER.reset()


async def _human(make_agent, alias="Operator"):
    return (await make_agent(alias, kind="human"))["agent_id"]


async def _store_openai_key(client, cid, human):
    r = await client.put(
        f"/api/containers/{cid}/settings/voice-keys/openai",
        json={"actor_agent_id": human, "api_key": OPENAI_KEY},
    )
    assert r.status_code == 200, r.text
    return r.json()


# --------------------------------------------------------------------------- status + keys


@pytest.mark.asyncio
async def test_status_lists_providers_unconfigured(client, container, fake_upstream):
    r = await client.get(f"/api/containers/{container['id']}/voice/status")
    assert r.status_code == 200, r.text
    d = r.json()
    assert [p["provider"] for p in d["providers"]] == ["openai", "deepgram", "groq"]
    assert d["cloud_available"] is False and d["default_provider"] is None
    assert d["audio_retention"] == "none" and d["max_seconds"] == 600


@pytest.mark.asyncio
async def test_put_key_is_sealed_masked_and_never_returned(client, container, make_agent, db, fake_upstream):
    cid = container["id"]
    human = await _human(make_agent)
    put = await _store_openai_key(client, cid, human)
    assert put["configured"] is True and put["masked"] == "sk-...ABCD"
    r = await client.get(f"/api/containers/{cid}/voice/status")
    body = r.text
    assert OPENAI_KEY not in body and OPENAI_KEY not in json.dumps(put)
    assert r.json()["default_provider"] == "openai"
    row = db.execute("SELECT key_enc FROM container_provider_keys WHERE container_id=%s AND provider='openai'", (cid,))[0]
    assert row["key_enc"].startswith("v1:") and OPENAI_KEY not in row["key_enc"]
    # One OpenAI key row per project: since migration 071 the provider-keys list shows the
    # agent-only OpenAI slot, which is this same row — but a speech key never opts agent runs in.
    llm = await client.get(f"/api/containers/{cid}/settings/provider-keys")
    oa = {k["provider"]: k for k in llm.json()["keys"]}["openai"]
    assert oa["stored"] is True and oa["use_for_agents"] is False
    assert OPENAI_KEY not in llm.text


@pytest.mark.asyncio
async def test_put_key_rejects_ai_actor_and_unknown_provider(client, container, make_agent, fake_upstream):
    cid = container["id"]
    ai = (await make_agent("Bot", kind="ai"))["agent_id"]
    r = await client.put(f"/api/containers/{cid}/settings/voice-keys/openai", json={"actor_agent_id": ai, "api_key": "x"})
    assert r.status_code in (400, 403, 422), r.text
    human = await _human(make_agent)
    r = await client.put(f"/api/containers/{cid}/settings/voice-keys/anthropic", json={"actor_agent_id": human, "api_key": "x"})
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_delete_key(client, container, make_agent, fake_upstream):
    cid = container["id"]
    human = await _human(make_agent)
    await _store_openai_key(client, cid, human)
    r = await client.request("DELETE", f"/api/containers/{cid}/settings/voice-keys/openai", json={"actor_agent_id": human})
    assert r.status_code == 200 and r.json()["configured"] is False


@pytest.mark.asyncio
async def test_env_key_shadows_and_is_masked(client, container, fake_upstream, monkeypatch):
    monkeypatch.setenv("DEEPGRAM_API_KEY", "dg-env-key-WXYZ")
    d = (await client.get(f"/api/containers/{container['id']}/voice/status")).json()
    dg = next(p for p in d["providers"] if p["provider"] == "deepgram")
    assert dg["source"] == "env" and dg["masked"] == "...WXYZ"
    assert "dg-env-key-WXYZ" not in json.dumps(d)


# --------------------------------------------------------------------------- streaming


def _stream(cid, headers=None, query="provider=auto&language=en"):
    tc = TestClient(main.app)
    return tc, tc.websocket_connect(f"/api/containers/{cid}/voice/stream?{query}", headers=headers or {})


@pytest.mark.asyncio
async def test_stream_happy_path_partials_then_done(client, container, make_agent, fake_upstream):
    cid = container["id"]
    await _store_openai_key(client, cid, await _human(make_agent))

    def run():
        tc, ctx = _stream(cid)
        with ctx as ws:
            ready = ws.receive_json()
            assert ready["type"] == "ready" and ready["provider"] == "openai" and ready["sample_rate"] == 24000
            ws.send_bytes(b"\x00\x01" * 1200)
            first = ws.receive_json()
            ws.send_bytes(b"\x00\x01" * 1200)
            second = ws.receive_json()
            ws.send_text(json.dumps({"type": "stop"}))
            done = ws.receive_json()
            return ready, first, second, done

    ready, first, second, done = await asyncio.to_thread(run)
    assert first == {"type": "transcript", "final": "", "interim": "word1"}
    assert second == {"type": "transcript", "final": "word1", "interim": "word2"}
    assert done == {"type": "done", "text": "word1 word2"}
    s = fake_upstream.instances[-1]
    # the real key went upstream (server-side), language passed through, session closed
    assert s.api_key == OPENAI_KEY and s.language == "en" and s.finished and s.closed
    assert len(s.audio) == 4800
    assert OPENAI_KEY not in json.dumps([ready, first, second, done])


@pytest.mark.asyncio
async def test_stream_cancel_discards(client, container, make_agent, fake_upstream):
    cid = container["id"]
    await _store_openai_key(client, cid, await _human(make_agent))

    def run():
        tc, ctx = _stream(cid)
        with ctx as ws:
            ws.receive_json()
            ws.send_bytes(b"\x00\x00" * 100)
            ws.receive_json()
            ws.send_text(json.dumps({"type": "cancel"}))
            with pytest.raises(Exception):
                ws.receive_json()

    await asyncio.to_thread(run)
    s = fake_upstream.instances[-1]
    assert s.finished is False and s.closed is True


@pytest.mark.asyncio
async def test_stream_without_provider_is_4409(client, container, fake_upstream):
    def run():
        tc, ctx = _stream(container["id"])
        with ctx as ws:
            err = ws.receive_json()
            return err

    err = await asyncio.to_thread(run)
    assert err["type"] == "error" and "Settings › Voice" in err["message"]
    assert fake_upstream.instances == []


@pytest.mark.asyncio
async def test_stream_refuses_non_member_and_viewer(client, container, make_agent, fake_upstream, monkeypatch, db):
    cid = container["id"]
    human = await _human(make_agent)
    await _store_openai_key(client, cid, human)
    monkeypatch.setenv("ORCHA_TRUST_PROXY_USER", "1")
    db.execute("UPDATE agents SET github_login='owner-gh' WHERE id=%s", (human,))
    viewer = await make_agent("Vera", kind="human")
    db.execute("UPDATE agents SET github_login='vera-gh', member_role='viewer' WHERE id=%s", (viewer["agent_id"],))

    def run(login):
        tc, ctx = _stream(cid, headers={"X-Auth-Request-User": login})
        with ctx as ws:
            return ws.receive_json()

    stranger = await asyncio.to_thread(run, "stranger")
    assert stranger["type"] == "error" and stranger["code"] == "forbidden"
    viewer_err = await asyncio.to_thread(run, "vera-gh")
    assert viewer_err["type"] == "error" and "viewer" in viewer_err["message"]
    owner = await asyncio.to_thread(run, "owner-gh")
    assert owner["type"] == "ready"
    assert len(fake_upstream.instances) == 1


@pytest.mark.asyncio
async def test_stream_enforces_max_duration(client, container, make_agent, fake_upstream, monkeypatch):
    cid = container["id"]
    await _store_openai_key(client, cid, await _human(make_agent))
    monkeypatch.setattr(vr, "MAX_SECONDS", 1)  # 1 s = 48 000 bytes at 24 kHz

    def run():
        tc, ctx = _stream(cid)
        msgs = []
        with ctx as ws:
            ws.receive_json()
            for _ in range(3):
                ws.send_bytes(b"\x00" * 20000)
                msgs.append(ws.receive_json())
            msgs.append(ws.receive_json())
            msgs.append(ws.receive_json())
        return msgs

    msgs = await asyncio.to_thread(run)
    kinds = [m["type"] for m in msgs]
    assert "limit" in kinds and kinds[-1] == "done"


@pytest.mark.asyncio
async def test_stream_concurrency_limit(client, container, make_agent, fake_upstream, monkeypatch):
    cid = container["id"]
    await _store_openai_key(client, cid, await _human(make_agent))
    monkeypatch.setattr(vr, "CONCURRENT_SESSIONS", 1)

    def run():
        tc = TestClient(main.app)
        with tc.websocket_connect(f"/api/containers/{cid}/voice/stream") as a:
            assert a.receive_json()["type"] == "ready"
            with tc.websocket_connect(f"/api/containers/{cid}/voice/stream") as b:
                return b.receive_json()

    err = await asyncio.to_thread(run)
    assert err["type"] == "error" and err["code"] == "rate_limited"


@pytest.mark.asyncio
async def test_stream_frame_size_cap(client, container, make_agent, fake_upstream):
    cid = container["id"]
    await _store_openai_key(client, cid, await _human(make_agent))

    def run():
        tc, ctx = _stream(cid)
        with ctx as ws:
            ws.receive_json()
            ws.send_bytes(b"\x00" * (vr.MAX_FRAME_BYTES + 2))
            return ws.receive_json()

    err = await asyncio.to_thread(run)
    assert err["code"] == "frame_too_large"


def test_openai_adapter_error_is_scrubbed():
    assert vp._scrub(f"bad key {OPENAI_KEY} here", OPENAI_KEY) == "bad key [redacted] here"


# --------------------------------------------------------------------------- batch


@pytest.mark.asyncio
async def test_batch_transcribe_uses_fake_and_never_echoes_key(client, container, make_agent, fake_upstream, monkeypatch):
    cid = container["id"]
    await _store_openai_key(client, cid, await _human(make_agent))
    seen = {}

    def fake(provider, key, audio, ctype, language):
        seen.update(provider=provider, key=key, size=len(audio), ctype=ctype, language=language)
        return "hello from the fake"

    monkeypatch.setattr(vp, "BATCH_TRANSCRIBE", fake)
    wav = vp.pcm16_to_wav(b"\x00\x00" * 16000, 16000)
    r = await client.post(
        f"/api/containers/{cid}/voice/transcribe?language=en",
        content=wav,
        headers={"Content-Type": "audio/wav"},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"text": "hello from the fake", "provider": "openai"}
    assert seen["key"] == OPENAI_KEY and seen["language"] == "en" and seen["ctype"] == "audio/wav"
    assert OPENAI_KEY not in r.text


@pytest.mark.asyncio
async def test_batch_rejects_wrong_type_and_too_long(client, container, make_agent, fake_upstream, monkeypatch):
    cid = container["id"]
    await _store_openai_key(client, cid, await _human(make_agent))
    r = await client.post(f"/api/containers/{cid}/voice/transcribe", content=b"x", headers={"Content-Type": "text/plain"})
    assert r.status_code == 415
    monkeypatch.setattr(vr, "MAX_SECONDS", 1)
    wav = vp.pcm16_to_wav(b"\x00\x00" * 16000 * 3, 16000)
    r = await client.post(f"/api/containers/{cid}/voice/transcribe", content=wav, headers={"Content-Type": "audio/wav"})
    assert r.status_code == 413


@pytest.mark.asyncio
async def test_batch_provider_error_is_plain_502(client, container, make_agent, fake_upstream, monkeypatch):
    cid = container["id"]
    await _store_openai_key(client, cid, await _human(make_agent))

    def boom(*_a, **_k):
        raise vp.VoiceProviderError("The speech provider rejected the API key. Check it in Settings › Voice.")

    monkeypatch.setattr(vp, "BATCH_TRANSCRIBE", boom)
    wav = vp.pcm16_to_wav(b"\x00\x00" * 1600, 16000)
    r = await client.post(f"/api/containers/{cid}/voice/transcribe", content=wav, headers={"Content-Type": "audio/wav"})
    assert r.status_code == 502 and "rejected the API key" in r.json()["detail"]


@pytest.mark.asyncio
async def test_groq_batch_session_buffers_then_transcribes(monkeypatch):
    calls = {}

    def fake(provider, key, audio, ctype, language):
        calls.update(provider=provider, wav=audio)
        return "batched words"

    monkeypatch.setattr(vp, "BATCH_TRANSCRIBE", fake)
    s = vp.BufferedBatchSession("groq", "gsk_x", "en")
    await s.send_audio(b"\x01\x00" * 1600)
    await s.finish()
    events = [e async for e in s.events()]
    assert events == [{"type": "final", "text": "batched words"}]
    assert calls["provider"] == "groq" and vp.wav_duration_seconds(calls["wav"]) == pytest.approx(0.1)


# --------------------------------------------------------------------------- clean-up


class _FakeLLM:
    def __init__(self, text):
        self.text = text
        self.calls = []

    def complete(self, **kw):
        self.calls.append(kw)
        return {"text": self.text}


@pytest.mark.asyncio
async def test_cleanup_returns_clean_and_raw(client, container, fake_upstream, monkeypatch):
    fake = _FakeLLM("- Fix the login bug\n- Add dark mode")
    monkeypatch.setattr(vr.llm_util, "get_provider", lambda _p: fake)
    monkeypatch.setenv("ORCHA_LLM_API_KEY", "sk-ant-test")
    raw = "um so fix the login bug and uh add dark mode"
    r = await client.post(f"/api/containers/{container['id']}/voice/cleanup", json={"text": raw})
    assert r.status_code == 200, r.text
    assert r.json() == {"text": "- Fix the login bug\n- Add dark mode", "raw": raw, "changed": True}
    assert fake.calls[0]["spec"].model == vr.llm_util.MODEL_HAIKU


@pytest.mark.asyncio
async def test_cleanup_guard_refuses_invented_content(client, container, fake_upstream, monkeypatch):
    fake = _FakeLLM("Sure! Here is a much longer answer that adds things nobody said at all, " * 3)
    monkeypatch.setattr(vr.llm_util, "get_provider", lambda _p: fake)
    monkeypatch.setenv("ORCHA_LLM_API_KEY", "sk-ant-test")
    r = await client.post(f"/api/containers/{container['id']}/voice/cleanup", json={"text": "ship it"})
    assert r.json() == {"text": "ship it", "raw": "ship it", "changed": False}


@pytest.mark.asyncio
async def test_cleanup_single_line_and_no_key(client, container, fake_upstream, monkeypatch):
    fake = _FakeLLM("Fix the login\nbug")
    monkeypatch.setattr(vr.llm_util, "get_provider", lambda _p: fake)
    monkeypatch.setenv("ORCHA_LLM_API_KEY", "sk-ant-test")
    r = await client.post(f"/api/containers/{container['id']}/voice/cleanup", json={"text": "fix the login bug", "single_line": True})
    assert r.json()["text"] == "Fix the login bug"
    monkeypatch.delenv("ORCHA_LLM_API_KEY")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    r = await client.post(f"/api/containers/{container['id']}/voice/cleanup", json={"text": "x"})
    assert r.status_code == 409 and "Models & providers" in r.json()["detail"]


# --------------------------------------------------------------------------- openapi


@pytest.mark.asyncio
async def test_openapi_documents_voice(client):
    spec = (await client.get("/openapi.json")).json()
    paths = spec["paths"]
    assert "/api/containers/{cid}/voice/status" in paths
    assert "/api/containers/{cid}/voice/transcribe" in paths
    assert "/api/containers/{cid}/voice/cleanup" in paths
    assert "/api/containers/{cid}/settings/voice-keys/{provider}" in paths
    desc = paths["/api/containers/{cid}/voice/status"]["get"]["description"]
    assert "/voice/stream" in desc and "never stored" in desc


# --------------------------------------------------------------------------- adapter parsing (fake socket)


class _FakeWS:
    def __init__(self, frames):
        self.frames = [json.dumps(f) for f in frames]
        self.sent = []

    async def send(self, data):
        self.sent.append(data)

    async def close(self):
        pass

    def __aiter__(self):
        async def gen():
            for f in self.frames:
                yield f
        return gen()


@pytest.mark.asyncio
async def test_openai_session_parses_realtime_events(monkeypatch):
    frames = [
        {"type": "input_audio_buffer.committed", "item_id": "a"},
        {"type": "conversation.item.input_audio_transcription.delta", "item_id": "a", "delta": "Hello"},
        {"type": "conversation.item.input_audio_transcription.delta", "item_id": "a", "delta": " world"},
        {"type": "conversation.item.input_audio_transcription.completed", "item_id": "a", "transcript": "Hello world."},
        {"type": "conversation.item.input_audio_transcription.delta", "item_id": "b", "delta": "Second"},
        {"type": "conversation.item.input_audio_transcription.completed", "item_id": "b", "transcript": "Second line."},
    ]
    fake_ws = _FakeWS(frames)

    def connect(url, headers):
        assert headers == {"Authorization": f"Bearer {OPENAI_KEY}"}
        async def _c():
            return fake_ws
        return _c()

    monkeypatch.setattr(vp, "_ws_connect", connect)
    s = vp.OpenAIRealtimeSession(OPENAI_KEY, "en")
    await s.open()
    events = [e async for e in s.events()]
    update = json.loads(fake_ws.sent[0])
    assert update["type"] == "session.update" and update["session"]["type"] == "transcription"
    assert update["session"]["audio"]["input"]["format"] == {"type": "audio/pcm", "rate": 24000}
    assert events[1] == {"type": "partial", "final": "", "text": "Hello world"}
    assert events[2] == {"type": "partial", "final": "Hello world.", "text": ""}
    assert events[-1] == {"type": "final", "text": "Hello world. Second line."}
    await s.send_audio(b"\x00\x00" * 10)
    assert json.loads(fake_ws.sent[-1])["type"] == "input_audio_buffer.append"


@pytest.mark.asyncio
async def test_deepgram_session_parses_interim_and_final(monkeypatch):
    def res(t, final):
        return {"type": "Results", "is_final": final, "channel": {"alternatives": [{"transcript": t}]}}

    fake_ws = _FakeWS([res("hel", False), res("hello there", True), res("how", False)])

    def connect(url, headers):
        assert "model=nova-3" in url and "sample_rate=16000" in url and "language=en" in url
        assert headers == {"Authorization": "Token dg-key"}
        async def _c():
            return fake_ws
        return _c()

    monkeypatch.setattr(vp, "_ws_connect", connect)
    s = vp.DeepgramSession("dg-key", "en")
    await s.open()
    events = [e async for e in s.events()]
    assert events[0] == {"type": "partial", "final": "", "text": "hel"}
    assert events[1] == {"type": "partial", "final": "hello there", "text": ""}
    assert events[-1] == {"type": "final", "text": "hello there"}


@pytest.mark.asyncio
async def test_cleanup_is_rate_limited(client, container, fake_upstream, monkeypatch):
    fake = _FakeLLM("Ok.")
    monkeypatch.setattr(vr.llm_util, "get_provider", lambda _p: fake)
    monkeypatch.setenv("ORCHA_LLM_API_KEY", "sk-ant-test")
    monkeypatch.setattr(vr, "SESSIONS_PER_MINUTE", 2)
    codes = []
    for _ in range(3):
        r = await client.post(f"/api/containers/{container['id']}/voice/cleanup", json={"text": "ok"})
        codes.append(r.status_code)
    assert codes == [200, 200, 429]
