"""Speech-to-text provider adapters for dictation (portal Voice feature).

The browser never talks to a speech provider directly: it streams 16-bit PCM over a
WebSocket to the portal (voice_routes.py), which opens ONE upstream session here with the
project's stored key. The key stays server-side; the browser only ever sees transcript text.

Adapters share one tiny interface so the route (and the tests) never care which provider is
behind a session:

    session = await open_stream(provider, api_key, language=..., )
    session.sample_rate            -> the PCM rate the browser must send (24 kHz / 16 kHz)
    await session.send_audio(pcm)  -> raw little-endian int16 mono frames
    await session.finish()         -> "the speaker stopped": flush + wait for the final text
    async for ev in session.events(): {"type": "partial"|"final"|"error", "text"|"message"}
    await session.close()

Providers (October 2026):
  * openai   — Realtime transcription session over WebSocket (`gpt-live-transcribe`; the
               model is env-overridable). Server VAD commits a segment on each pause, so
               deltas stream while the speaker is still talking.
  * deepgram — Nova-3 live streaming (`/v1/listen`) with interim results.
  * groq     — whisper-large-v3-turbo, batch only: the route buffers the session's audio and
               transcribes it once on finish (cheapest; no live partials).

Nothing here stores audio. Buffers live only for the life of one session.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import struct
import urllib.error
import urllib.request
import uuid
import wave
from typing import AsyncIterator, Callable, Optional

SPEECH_PROVIDERS: list[dict] = [
    {
        "id": "openai",
        "name": "OpenAI",
        "streaming": True,
        "env": "OPENAI_API_KEY",
        "key_prefix": "sk-",
        "model": "gpt-live-transcribe",
        "note": "Live streaming, best accuracy. About $0.006 per minute.",
    },
    {
        "id": "deepgram",
        "name": "Deepgram",
        "streaming": True,
        "env": "DEEPGRAM_API_KEY",
        "key_prefix": "",
        "model": "nova-3",
        "note": "Live streaming, lowest latency. About $0.008 per minute.",
    },
    {
        "id": "groq",
        "name": "Groq",
        "streaming": False,
        "env": "GROQ_API_KEY",
        "key_prefix": "gsk_",
        "model": "whisper-large-v3-turbo",
        "note": "Transcribes when you stop (no live text). About $0.04 per hour.",
    },
]
PROVIDER_IDS = tuple(p["id"] for p in SPEECH_PROVIDERS)


class VoiceProviderError(RuntimeError):
    """An upstream failure, already phrased for a person (never contains the key)."""


def provider_meta(provider: str) -> Optional[dict]:
    return next((p for p in SPEECH_PROVIDERS if p["id"] == provider), None)


def _env_model(provider: str) -> str:
    meta = provider_meta(provider) or {}
    return os.environ.get(f"ORCHA_VOICE_{provider.upper()}_MODEL") or meta.get("model", "")


def _scrub(text: str, api_key: str) -> str:
    """Belt and braces: an upstream error body must never echo the key back to a browser."""
    if api_key and api_key in text:
        text = text.replace(api_key, "[redacted]")
    return text[:300]


# --------------------------------------------------------------------------- sessions


class UpstreamSession:
    """Base class: an event queue plus the send/finish/close contract."""

    sample_rate = 16000
    streaming = True

    def __init__(self) -> None:
        self._events: asyncio.Queue = asyncio.Queue()
        self._closed = False

    async def send_audio(self, pcm: bytes) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    async def finish(self) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    async def close(self) -> None:
        self._closed = True

    def _emit(self, event: dict) -> None:
        self._events.put_nowait(event)

    def _end(self) -> None:
        self._events.put_nowait(None)

    async def events(self) -> AsyncIterator[dict]:
        while True:
            ev = await self._events.get()
            if ev is None:
                return
            yield ev


def _ws_connect(url: str, headers: dict):
    import websockets  # uvicorn[standard] ships it

    return websockets.connect(
        url,
        additional_headers=headers,
        max_size=2**22,
        open_timeout=10,
        ping_interval=20,
    )


class OpenAIRealtimeSession(UpstreamSession):
    sample_rate = 24000

    def __init__(self, api_key: str, language: Optional[str]) -> None:
        super().__init__()
        self._key = api_key
        self._language = language
        self._ws = None
        self._reader: Optional[asyncio.Task] = None
        self._order: list[str] = []
        self._done: dict[str, str] = {}
        self._interim: dict[str, str] = {}
        self._pending: set[str] = set()
        self._sent_since_commit = 0
        self._finishing = False

    async def open(self) -> None:
        url = os.environ.get(
            "ORCHA_VOICE_OPENAI_REALTIME_URL",
            "wss://api.openai.com/v1/realtime?intent=transcription",
        )
        try:
            self._ws = await _ws_connect(url, {"Authorization": f"Bearer {self._key}"})
        except Exception as exc:  # handshake 401/403/network
            raise VoiceProviderError(_openai_handshake_message(exc)) from None
        model = _env_model("openai")
        transcription: dict = {"model": model}
        if self._language:
            if model.startswith("gpt-4o") or model == "whisper-1":
                transcription["language"] = self._language
            else:
                transcription["languages"] = [self._language]
        await self._ws.send(
            json.dumps(
                {
                    "type": "session.update",
                    "session": {
                        "type": "transcription",
                        "audio": {
                            "input": {
                                "format": {"type": "audio/pcm", "rate": self.sample_rate},
                                "transcription": transcription,
                                "noise_reduction": {"type": "near_field"},
                                # A pause commits a segment, so text streams while the
                                # speaker keeps talking (no wait for the very end).
                                "turn_detection": {
                                    "type": "server_vad",
                                    "silence_duration_ms": 450,
                                    "prefix_padding_ms": 300,
                                },
                            }
                        },
                    },
                }
            )
        )
        self._reader = asyncio.create_task(self._read())

    def _state(self) -> tuple[str, str]:
        final = " ".join(t for i in self._order if (t := self._done.get(i, "").strip()))
        interim = " ".join(
            t for i in self._order if i not in self._done and (t := self._interim.get(i, "").strip())
        )
        return final, interim

    async def _read(self) -> None:
        try:
            async for raw in self._ws:
                try:
                    msg = json.loads(raw)
                except (TypeError, ValueError):
                    continue
                kind = msg.get("type", "")
                item = msg.get("item_id") or ""
                if kind == "input_audio_buffer.committed":
                    if item and item not in self._order:
                        self._order.append(item)
                    self._pending.add(item)
                    self._sent_since_commit = 0
                elif kind == "conversation.item.input_audio_transcription.delta":
                    if item and item not in self._order:
                        self._order.append(item)
                    self._interim[item] = self._interim.get(item, "") + (msg.get("delta") or "")
                    final, interim = self._state()
                    self._emit({"type": "partial", "final": final, "text": interim})
                elif kind == "conversation.item.input_audio_transcription.completed":
                    if item and item not in self._order:
                        self._order.append(item)
                    self._done[item] = msg.get("transcript") or ""
                    self._pending.discard(item)
                    final, interim = self._state()
                    self._emit({"type": "partial", "final": final, "text": interim})
                    if self._finishing and not self._pending:
                        break
                elif kind == "error":
                    err = msg.get("error") or {}
                    code = err.get("code") or ""
                    if code == "input_audio_buffer_commit_empty":
                        if self._finishing and not self._pending:
                            break
                        continue
                    self._emit({"type": "error", "message": _scrub(err.get("message") or "The speech service returned an error.", self._key)})
                    break
        except Exception as exc:  # connection dropped
            if not self._finishing:
                self._emit({"type": "error", "message": f"The speech service disconnected ({type(exc).__name__})."})
        finally:
            final, _ = self._state()
            self._emit({"type": "final", "text": final})
            self._end()

    async def send_audio(self, pcm: bytes) -> None:
        if not self._ws or self._finishing:
            return
        self._sent_since_commit += len(pcm)
        await self._ws.send(
            json.dumps({"type": "input_audio_buffer.append", "audio": base64.b64encode(pcm).decode()})
        )

    async def finish(self) -> None:
        if not self._ws or self._finishing:
            return
        self._finishing = True
        # >= 100 ms of audio buffered since the last VAD commit -> commit the tail.
        if self._sent_since_commit >= self.sample_rate * 2 // 10:
            await self._ws.send(json.dumps({"type": "input_audio_buffer.commit"}))
        elif not self._pending:
            await self._ws.close()

    async def close(self) -> None:
        await super().close()
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass
        if self._reader is not None:
            self._reader.cancel()


def _openai_handshake_message(exc: Exception) -> str:
    status = getattr(getattr(exc, "response", None), "status_code", None) or getattr(exc, "status_code", None)
    if status in (401, 403):
        return "OpenAI rejected the API key. Check it in Settings › Voice."
    if status == 429:
        return "OpenAI is rate-limiting this key. Try again in a moment."
    return "Could not reach OpenAI's realtime transcription service."


class DeepgramSession(UpstreamSession):
    sample_rate = 16000

    def __init__(self, api_key: str, language: Optional[str]) -> None:
        super().__init__()
        self._key = api_key
        self._language = language
        self._ws = None
        self._reader: Optional[asyncio.Task] = None
        self._final: list[str] = []
        self._finishing = False

    async def open(self) -> None:
        base = os.environ.get("ORCHA_VOICE_DEEPGRAM_URL", "wss://api.deepgram.com/v1/listen")
        params = (
            f"model={_env_model('deepgram')}&encoding=linear16&sample_rate={self.sample_rate}"
            "&channels=1&interim_results=true&smart_format=true&punctuate=true&endpointing=300"
            f"&language={self._language or 'multi'}"
        )
        try:
            self._ws = await _ws_connect(f"{base}?{params}", {"Authorization": f"Token {self._key}"})
        except Exception as exc:
            status = getattr(getattr(exc, "response", None), "status_code", None)
            if status in (401, 403):
                raise VoiceProviderError("Deepgram rejected the API key. Check it in Settings › Voice.") from None
            raise VoiceProviderError("Could not reach Deepgram's streaming service.") from None
        self._reader = asyncio.create_task(self._read())

    async def _read(self) -> None:
        try:
            async for raw in self._ws:
                try:
                    msg = json.loads(raw)
                except (TypeError, ValueError):
                    continue
                if msg.get("type") != "Results":
                    continue
                alts = ((msg.get("channel") or {}).get("alternatives") or [{}])
                text = (alts[0].get("transcript") or "").strip()
                if msg.get("is_final"):
                    if text:
                        self._final.append(text)
                    self._emit({"type": "partial", "final": " ".join(self._final), "text": ""})
                else:
                    self._emit({"type": "partial", "final": " ".join(self._final), "text": text})
        except Exception as exc:
            if not self._finishing:
                self._emit({"type": "error", "message": f"Deepgram disconnected ({type(exc).__name__})."})
        finally:
            self._emit({"type": "final", "text": " ".join(self._final)})
            self._end()

    async def send_audio(self, pcm: bytes) -> None:
        if self._ws and not self._finishing:
            await self._ws.send(pcm)

    async def finish(self) -> None:
        if self._ws and not self._finishing:
            self._finishing = True
            await self._ws.send(json.dumps({"type": "CloseStream"}))

    async def close(self) -> None:
        await super().close()
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass
        if self._reader is not None:
            self._reader.cancel()


class BufferedBatchSession(UpstreamSession):
    """Non-streaming provider: keep the PCM in memory, transcribe once on finish."""

    sample_rate = 16000
    streaming = False

    def __init__(self, provider: str, api_key: str, language: Optional[str]) -> None:
        super().__init__()
        self._provider = provider
        self._key = api_key
        self._language = language
        self._buf = bytearray()

    async def open(self) -> None:
        return None

    async def send_audio(self, pcm: bytes) -> None:
        self._buf.extend(pcm)

    async def finish(self) -> None:
        wav = pcm16_to_wav(bytes(self._buf), self.sample_rate)
        self._buf = bytearray()
        try:
            text = await asyncio.to_thread(
                BATCH_TRANSCRIBE, self._provider, self._key, wav, "audio/wav", self._language
            )
            self._emit({"type": "final", "text": text})
        except VoiceProviderError as exc:
            self._emit({"type": "error", "message": str(exc)})
            self._emit({"type": "final", "text": ""})
        self._end()

    async def close(self) -> None:
        self._buf = bytearray()
        await super().close()


async def _open_openai(api_key: str, language: Optional[str]) -> UpstreamSession:
    s = OpenAIRealtimeSession(api_key, language)
    await s.open()
    return s


async def _open_deepgram(api_key: str, language: Optional[str]) -> UpstreamSession:
    s = DeepgramSession(api_key, language)
    await s.open()
    return s


async def _open_groq(api_key: str, language: Optional[str]) -> UpstreamSession:
    s = BufferedBatchSession("groq", api_key, language)
    await s.open()
    return s


# Tests swap entries here for a fake upstream (no network in the suite).
STREAM_FACTORIES: dict[str, Callable] = {
    "openai": _open_openai,
    "deepgram": _open_deepgram,
    "groq": _open_groq,
}


async def open_stream(provider: str, api_key: str, *, language: Optional[str]) -> UpstreamSession:
    factory = STREAM_FACTORIES.get(provider)
    if factory is None:
        raise VoiceProviderError(f"'{provider}' is not a speech provider")
    return await factory(api_key, language)


# --------------------------------------------------------------------------- batch REST


def pcm16_to_wav(pcm: bytes, rate: int) -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return out.getvalue()


def wav_duration_seconds(data: bytes) -> Optional[float]:
    """Duration of a PCM WAV, or None when it isn't one we can read."""
    try:
        with wave.open(io.BytesIO(data), "rb") as w:
            return w.getnframes() / float(w.getframerate() or 1)
    except (wave.Error, EOFError, struct.error):
        return None


def _multipart(fields: dict, file_bytes: bytes, content_type: str) -> tuple[bytes, str]:
    boundary = uuid.uuid4().hex
    parts: list[bytes] = []
    for k, v in fields.items():
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
        )
    ext = "wav" if "wav" in content_type else "webm"
    parts.append(
        (
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="dictation.{ext}"\r\n'
            f"Content-Type: {content_type}\r\n\r\n"
        ).encode()
        + file_bytes
        + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def _http_transcribe(url: str, headers: dict, fields: dict, audio: bytes, content_type: str, key: str) -> str:
    body, ctype = _multipart(fields, audio, content_type)
    req = urllib.request.Request(url, data=body, method="POST", headers={**headers, "Content-Type": ctype})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise VoiceProviderError("The speech provider rejected the API key. Check it in Settings › Voice.") from None
        if e.code == 429:
            raise VoiceProviderError("The speech provider is rate-limiting this key. Try again in a moment.") from None
        detail = ""
        try:
            detail = _scrub(json.loads(e.read().decode() or "{}").get("error", {}).get("message", ""), key)
        except Exception:
            pass
        raise VoiceProviderError(f"Transcription failed ({e.code}){': ' + detail if detail else ''}.") from None
    except (urllib.error.URLError, TimeoutError):
        raise VoiceProviderError("Could not reach the speech provider.") from None
    return (data.get("text") or "").strip()


def transcribe_file(provider: str, api_key: str, audio: bytes, content_type: str, language: Optional[str]) -> str:
    """One-shot transcription of a short recording (the non-streaming fallback)."""
    if provider == "openai":
        model = os.environ.get("ORCHA_VOICE_OPENAI_BATCH_MODEL", "gpt-4o-transcribe")
        fields = {"model": model, "response_format": "json"}
        if language:
            fields["language"] = language
        return _http_transcribe(
            os.environ.get("ORCHA_VOICE_OPENAI_REST_URL", "https://api.openai.com/v1/audio/transcriptions"),
            {"Authorization": f"Bearer {api_key}"}, fields, audio, content_type, api_key,
        )
    if provider == "groq":
        fields = {"model": _env_model("groq"), "response_format": "json"}
        if language:
            fields["language"] = language
        return _http_transcribe(
            os.environ.get("ORCHA_VOICE_GROQ_REST_URL", "https://api.groq.com/openai/v1/audio/transcriptions"),
            {"Authorization": f"Bearer {api_key}"}, fields, audio, content_type, api_key,
        )
    if provider == "deepgram":
        url = os.environ.get("ORCHA_VOICE_DEEPGRAM_REST_URL", "https://api.deepgram.com/v1/listen")
        q = f"?model={_env_model('deepgram')}&smart_format=true&punctuate=true&language={language or 'multi'}"
        req = urllib.request.Request(
            url + q, data=audio, method="POST",
            headers={"Authorization": f"Token {api_key}", "Content-Type": content_type},
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise VoiceProviderError("Deepgram rejected the API key. Check it in Settings › Voice.") from None
            raise VoiceProviderError(f"Transcription failed ({e.code}).") from None
        except (urllib.error.URLError, TimeoutError):
            raise VoiceProviderError("Could not reach Deepgram.") from None
        try:
            return data["results"]["channels"][0]["alternatives"][0]["transcript"].strip()
        except (KeyError, IndexError, TypeError):
            return ""
    raise VoiceProviderError(f"'{provider}' is not a speech provider")


# Tests swap this for a fake (no network in the suite).
BATCH_TRANSCRIBE: Callable[..., str] = transcribe_file
