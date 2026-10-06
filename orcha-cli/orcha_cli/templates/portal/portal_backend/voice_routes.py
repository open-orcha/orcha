"""Dictation (voice → text) for every text field in the portal.

Routes
------
* ``GET  /api/containers/{cid}/voice/status``   — which engines this project can use (no secrets)
* ``WS   /api/containers/{cid}/voice/stream``   — live streaming transcription (proxy, see below)
* ``POST /api/containers/{cid}/voice/transcribe`` — one-shot transcription of a short WAV (fallback)
* ``POST /api/containers/{cid}/voice/cleanup``  — optional AI clean-up of a finished dictation
* ``PUT/DELETE /api/containers/{cid}/settings/voice-keys/{provider}`` — speech provider keys

The WebSocket proxy (FastAPI does not list WebSockets in OpenAPI, so the protocol is
documented on the ``/voice/status`` operation and here):

    connect  ws(s)://<portal>/api/containers/{cid}/voice/stream?provider=auto&language=en
    server → {"type":"ready","provider":"openai","sample_rate":24000,"max_seconds":600}
    client → binary frames: little-endian int16 mono PCM at ``sample_rate``
    server → {"type":"transcript","final":"settled text","interim":"words still settling"}
    client → {"type":"stop"}      (speaker finished — flush and send the final text)
           | {"type":"cancel"}    (discard; the server closes without a transcript)
    server → {"type":"done","text":"the whole dictation"}  then close(1000)
           | {"type":"error","code":"…","message":"plain words"} then close(1011/4xxx)

Access is the same as other member routes: trusted non-members get 4403, viewers
(read-only) get 4403 — dictation spends the project's provider key. Audio is never
stored: frames are forwarded and dropped; the batch provider keeps them in memory
only until the session ends.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from collections import deque
from typing import Optional

from fastapi import HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from portal_backend import voice_providers as vp
from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container, require_kind, valid_uuid
from portal_backend.identity_routes import (
    enforce_grant,
    proxy_login,
    require_member_read,
    trusted_actor,
)
from portal_backend.provider_keys import provider_stored_row
from portal_backend.schemas import LlmKeyActor, LlmKeyUpdate

try:
    import secret_box
except ImportError:
    from orcha_cli import secret_box

try:
    import llm_util
except ImportError:
    from orcha_cli import llm_util

MAX_SECONDS = int(os.environ.get("ORCHA_VOICE_MAX_SECONDS", "600"))  # 10 minutes
MAX_FRAME_BYTES = 64 * 1024
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_CLEANUP_CHARS = 20000
SESSIONS_PER_MINUTE = int(os.environ.get("ORCHA_VOICE_SESSIONS_PER_MINUTE", "20"))
CONCURRENT_SESSIONS = int(os.environ.get("ORCHA_VOICE_CONCURRENT_SESSIONS", "2"))
FINISH_TIMEOUT_S = 15.0

WS_PROTOCOL_DOC = (
    "Live dictation runs over a WebSocket at `/api/containers/{cid}/voice/stream`"
    "?provider=auto|openai|deepgram|groq&language=<ISO-639-1 or empty>. "
    "Server sends `{type:'ready', provider, sample_rate, max_seconds}`; the client then sends "
    "binary little-endian int16 mono PCM at `sample_rate`. The server streams "
    "`{type:'transcript', final, interim}`. The client sends `{type:'stop'}` to finish "
    "(server replies `{type:'done', text}` and closes) or `{type:'cancel'}` to discard. "
    "Errors arrive as `{type:'error', code, message}` before close. Close codes: 4403 "
    "forbidden, 4404 project not found, 4409 no speech provider configured, 4429 rate "
    "limited, 4413 max duration reached. Audio is never stored."
)


# --------------------------------------------------------------------------- limits


class _Limiter:
    """In-process limits per (project, person): session starts per minute + concurrency."""

    def __init__(self) -> None:
        self._starts: dict[str, deque] = {}
        self._live: dict[str, int] = {}

    def reset(self) -> None:
        self._starts.clear()
        self._live.clear()

    def acquire(self, key: str) -> Optional[str]:
        now = time.monotonic()
        q = self._starts.setdefault(key, deque())
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= SESSIONS_PER_MINUTE:
            return "Too many dictations in the last minute. Wait a moment and try again."
        if self._live.get(key, 0) >= CONCURRENT_SESSIONS:
            return "Dictation is already running in another tab or window."
        q.append(now)
        self._live[key] = self._live.get(key, 0) + 1
        return None

    def release(self, key: str) -> None:
        self._live[key] = max(0, self._live.get(key, 0) - 1)


LIMITER = _Limiter()


def _limit_key(cid: str, conn) -> str:
    login = proxy_login(conn) or ""
    host = getattr(getattr(conn, "client", None), "host", "") or ""
    return f"{cid}:{login.lower() or 'local'}:{'' if login else host}"


# --------------------------------------------------------------------------- keys


def _resolve_speech_key(cur, cid: str, provider: str) -> tuple[Optional[str], Optional[str]]:
    """(key, source) — the provider's env var wins (ops override), else the sealed DB row.
    Deliberately NOT ORCHA_LLM_API_KEY: that override is an Anthropic key."""
    meta = vp.provider_meta(provider)
    if not meta:
        return None, None
    env_val = os.environ.get(meta["env"])
    if env_val:
        return env_val, "env"
    try:
        row = provider_stored_row(cur, cid, provider)
    except Exception:
        row = None
    if row and row.get("key_enc"):
        try:
            return secret_box.unseal(row["key_enc"]), "db"
        except Exception:
            return None, None
    return None, None


def _key_status(cur, cid: str) -> list[dict]:
    out = []
    for meta in vp.SPEECH_PROVIDERS:
        env_val = os.environ.get(meta["env"])
        row = None
        try:
            row = provider_stored_row(cur, cid, meta["id"])
        except Exception:
            row = None
        if env_val:
            entry = {"configured": True, "source": "env", "masked": f"{meta['key_prefix']}...{secret_box.last4(env_val)}", "set_at": None}
        elif row:
            entry = {"configured": True, "source": "db", "masked": f"{meta['key_prefix']}...{row['key_hint']}", "set_at": row["set_at"]}
        else:
            entry = {"configured": False, "source": None, "masked": None, "set_at": None}
        entry.update(
            {
                "provider": meta["id"],
                "name": meta["name"],
                "streaming": meta["streaming"],
                "model": vp._env_model(meta["id"]),
                "note": meta["note"],
            }
        )
        out.append(entry)
    return out


def _pick_provider(statuses: list[dict], requested: str) -> Optional[str]:
    configured = [s["provider"] for s in statuses if s["configured"]]
    if requested and requested != "auto":
        return requested if requested in configured else None
    return configured[0] if configured else None  # catalog order = preference order


def _member_gate(cur, conn, cid: str):
    """Member read + no viewers (dictating spends the project's key)."""
    member = require_member_read(cur, conn, cid)
    if member is not None and (member.get("member_role") or "") == "viewer":
        raise HTTPException(403, "viewers can't dictate — this project is read-only for you")
    return member


def _cleanup_available(cur, cid: str) -> bool:
    try:
        spec = llm_util.resolve_spec("dictation_cleanup")
        from portal_backend.provider_keys import provider_api_key

        llm_util.resolve_api_key(spec.provider, explicit=provider_api_key(cur, cid, spec.provider))
        return True
    except Exception:
        return False


# --------------------------------------------------------------------------- status


@app.get(
    "/api/containers/{cid}/voice/status",
    status_code=200,
    summary="Dictation engines available to this project",
    description=WS_PROTOCOL_DOC,
)
def voice_status(cid: str, request: Request):
    """Which speech providers are configured (masked, never the key), the provider `auto`
    picks, whether AI clean-up is available, and the session limits."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        require_member_read(cur, request, cid)
        statuses = _key_status(cur, cid)
        cleanup = _cleanup_available(cur, cid)
    return {
        "providers": statuses,
        "default_provider": _pick_provider(statuses, "auto"),
        "cloud_available": any(s["configured"] for s in statuses),
        "cleanup_available": cleanup,
        "max_seconds": MAX_SECONDS,
        "audio_retention": "none",
        "stream_path": f"/api/containers/{cid}/voice/stream",
    }


# --------------------------------------------------------------------------- keys


@app.put("/api/containers/{cid}/settings/voice-keys/{provider}", status_code=200)
def put_voice_key(cid: str, provider: str, body: LlmKeyUpdate, request: Request):
    """Seal + store a speech provider key. Owner-or-manage_keys, human actor, audit-logged.
    The plaintext is never persisted and never returned."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    if provider not in vp.PROVIDER_IDS:
        raise HTTPException(400, f"'{provider}' is not a speech provider")
    key = body.api_key.strip()
    if not key:
        raise HTTPException(400, "api_key must not be blank")
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        enforce_grant(cur, request, cid, "manage_keys")
        body.actor_agent_id = trusted_actor(cur, request, cid, body.actor_agent_id)
        require_kind(cur, body.actor_agent_id, ("human",))
        if not secret_box.master_key_present():
            raise HTTPException(
                503,
                "encrypted key storage is disabled: ORCHA_SECRET_KEY is not set in the portal "
                "environment. Set it, or use the provider's environment variable instead.",
            )
        hint = secret_box.last4(key)
        cur.execute(
            "INSERT INTO container_provider_keys (container_id, provider, key_enc, key_hint, set_at) "
            "VALUES (%s, %s, %s, %s, now()) "
            "ON CONFLICT (container_id, provider) DO UPDATE SET "
            "key_enc=EXCLUDED.key_enc, key_hint=EXCLUDED.key_hint, set_at=now()",
            (cid, provider, secret_box.seal(key), hint),
        )
        log_event(cur, cid, "human", body.actor_agent_id, "container", cid, "voice_key_set", {"provider": provider, "hint": hint})
        conn.commit()
        status = next(s for s in _key_status(cur, cid) if s["provider"] == provider)
    return status


@app.delete("/api/containers/{cid}/settings/voice-keys/{provider}", status_code=200)
def delete_voice_key(cid: str, provider: str, body: LlmKeyActor, request: Request):
    """Remove a stored speech provider key. Owner-or-manage_keys, human actor, audit-logged."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    if provider not in vp.PROVIDER_IDS:
        raise HTTPException(400, f"'{provider}' is not a speech provider")
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        enforce_grant(cur, request, cid, "manage_keys")
        body.actor_agent_id = trusted_actor(cur, request, cid, body.actor_agent_id)
        require_kind(cur, body.actor_agent_id, ("human",))
        cur.execute("DELETE FROM container_provider_keys WHERE container_id=%s AND provider=%s", (cid, provider))
        log_event(cur, cid, "human", body.actor_agent_id, "container", cid, "voice_key_cleared", {"provider": provider})
        conn.commit()
        status = next(s for s in _key_status(cur, cid) if s["provider"] == provider)
    return status


# --------------------------------------------------------------------------- streaming


def _ws_prepare(ws: WebSocket, cid: str, requested: str) -> tuple[str, str]:
    """Sync DB part of the handshake: (provider, key). Raises HTTPException."""
    if not valid_uuid(cid):
        raise HTTPException(404, "project not found")
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        _member_gate(cur, ws, cid)
        statuses = _key_status(cur, cid)
        provider = _pick_provider(statuses, requested)
        if not provider:
            raise HTTPException(409, "No speech provider is set up for this project. Add one in Settings › Voice, or switch to on-device dictation.")
        key, _ = _resolve_speech_key(cur, cid, provider)
        if not key:
            raise HTTPException(409, "The speech provider key could not be read. Re-enter it in Settings › Voice.")
    return provider, key


_CLOSE_FOR_STATUS = {403: 4403, 404: 4404, 409: 4409, 429: 4429}


async def _fail(ws: WebSocket, code: str, message: str, close_code: int) -> None:
    try:
        await ws.send_json({"type": "error", "code": code, "message": message})
        await ws.close(close_code)
    except Exception:
        pass


def _clean_lang(language: Optional[str]) -> Optional[str]:
    lang = (language or "").strip().lower()
    return lang if re.fullmatch(r"[a-z]{2,3}(-[a-z0-9]{2,8})?", lang) else None


@app.websocket("/api/containers/{cid}/voice/stream")
async def voice_stream(ws: WebSocket, cid: str, provider: str = "auto", language: str = ""):
    await ws.accept()
    try:
        chosen, key = await asyncio.to_thread(_ws_prepare, ws, cid, (provider or "auto").lower())
    except HTTPException as exc:
        await _fail(ws, "forbidden" if exc.status_code == 403 else "unavailable", str(exc.detail), _CLOSE_FOR_STATUS.get(exc.status_code, 4400))
        return
    limit_key = _limit_key(cid, ws)
    refused = LIMITER.acquire(limit_key)
    if refused:
        await _fail(ws, "rate_limited", refused, 4429)
        return
    upstream: Optional[vp.UpstreamSession] = None
    pump: Optional[asyncio.Task] = None
    try:
        try:
            upstream = await vp.open_stream(chosen, key, language=_clean_lang(language))
        except vp.VoiceProviderError as exc:
            await _fail(ws, "provider_error", str(exc), 1011)
            return
        rate = upstream.sample_rate
        await ws.send_json(
            {"type": "ready", "provider": chosen, "sample_rate": rate, "streaming": upstream.streaming, "max_seconds": MAX_SECONDS}
        )
        state = {"final": "", "interim": "", "error": None}

        async def forward() -> None:
            async for ev in upstream.events():
                if ev["type"] == "partial":
                    state["final"], state["interim"] = ev.get("final", ""), ev.get("text", "")
                    await ws.send_json({"type": "transcript", "final": state["final"], "interim": state["interim"]})
                elif ev["type"] == "final":
                    if ev.get("text"):
                        state["final"] = ev["text"]
                elif ev["type"] == "error":
                    state["error"] = ev.get("message") or "The speech service failed."
                    try:
                        await ws.send_json({"type": "error", "code": "provider_error", "message": state["error"]})
                    except Exception:
                        pass

        pump = asyncio.create_task(forward())
        received = 0
        max_bytes = MAX_SECONDS * rate * 2
        outcome = "stop"
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                outcome = "gone"
                break
            data = msg.get("bytes")
            if data is not None:
                if len(data) > MAX_FRAME_BYTES:
                    await _fail(ws, "frame_too_large", "Audio frame too large.", 1009)
                    outcome = "gone"
                    break
                received += len(data)
                await upstream.send_audio(data)
                if received >= max_bytes:
                    try:
                        await ws.send_json({"type": "limit", "message": f"Dictation stops after {MAX_SECONDS // 60} minutes."})
                    except Exception:
                        pass
                    outcome = "stop"
                    break
                if pump.done():  # upstream ended on its own (error / disconnect)
                    break
                continue
            text = msg.get("text")
            if text:
                try:
                    cmd = json.loads(text).get("type")
                except (ValueError, AttributeError):
                    cmd = None
                if cmd == "cancel":
                    outcome = "cancel"
                    break
                if cmd == "stop":
                    outcome = "stop"
                    break
        if outcome == "stop":
            try:
                await upstream.finish()
            except Exception:  # upstream already gone: settle with what we have
                pass
            try:
                await asyncio.wait_for(asyncio.shield(pump), timeout=FINISH_TIMEOUT_S)
            except asyncio.TimeoutError:
                pass
            if state["error"] and not state["final"]:
                await _fail(ws, "provider_error", state["error"], 1011)
            else:
                # Finished cleanly -> the settled text; timed out -> keep what was still settling.
                parts = [state["final"]] if pump.done() else [state["final"], state["interim"]]
                text = " ".join(x for x in parts if x).strip()
                await ws.send_json({"type": "done", "text": text})
                await ws.close(1000)
        elif outcome == "cancel":
            try:
                await ws.close(1000)
            except Exception:
                pass
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        LIMITER.release(limit_key)
        if pump is not None and not pump.done():
            pump.cancel()
        if upstream is not None:
            await upstream.close()


# --------------------------------------------------------------------------- batch


@app.post(
    "/api/containers/{cid}/voice/transcribe",
    status_code=200,
    summary="Transcribe a short recording (non-streaming fallback)",
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "audio/wav": {"schema": {"type": "string", "format": "binary"}},
                "audio/webm": {"schema": {"type": "string", "format": "binary"}},
            },
        },
        "parameters": [
            {"name": "provider", "in": "query", "schema": {"type": "string", "default": "auto"}},
            {"name": "language", "in": "query", "schema": {"type": "string", "default": ""}},
        ],
    },
)
async def voice_transcribe(cid: str, request: Request):
    """Body: the raw audio (`audio/wav` 16-bit PCM or `audio/webm`), at most 25 MB and
    10 minutes. Returns `{text, provider}`. Audio is transcribed and dropped, never stored."""
    ctype = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if ctype not in ("audio/wav", "audio/x-wav", "audio/wave", "audio/webm", "audio/ogg", "audio/mp4"):
        raise HTTPException(415, "send the recording as audio/wav or audio/webm")
    body = await request.body()
    if not body:
        raise HTTPException(400, "empty recording")
    if len(body) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "recording too large (25 MB max)")
    if "wav" in ctype:
        dur = vp.wav_duration_seconds(body)
        if dur is not None and dur > MAX_SECONDS + 1:
            raise HTTPException(413, f"recording longer than {MAX_SECONDS // 60} minutes")
    requested = (request.query_params.get("provider") or "auto").lower()
    language = _clean_lang(request.query_params.get("language"))

    def prepare():
        if not valid_uuid(cid):
            raise HTTPException(400, "container_id is not a valid UUID")
        with db_cursor() as (_, cur):
            require_container(cur, cid)
            _member_gate(cur, request, cid)
            statuses = _key_status(cur, cid)
            provider = _pick_provider(statuses, requested)
            if not provider:
                raise HTTPException(409, "No speech provider is set up for this project. Add one in Settings › Voice.")
            key, _ = _resolve_speech_key(cur, cid, provider)
            if not key:
                raise HTTPException(409, "The speech provider key could not be read. Re-enter it in Settings › Voice.")
            return provider, key

    provider, key = await asyncio.to_thread(prepare)
    limit_key = _limit_key(cid, request)
    refused = LIMITER.acquire(limit_key)
    if refused:
        raise HTTPException(429, refused)
    try:
        text = await asyncio.to_thread(vp.BATCH_TRANSCRIBE, provider, key, body, "audio/wav" if "wav" in ctype else ctype, language)
    except vp.VoiceProviderError as exc:
        raise HTTPException(502, str(exc)) from None
    finally:
        LIMITER.release(limit_key)
    return {"text": text, "provider": provider}


# --------------------------------------------------------------------------- clean-up


class VoiceCleanupBody(BaseModel):
    text: str = Field(..., min_length=1, max_length=MAX_CLEANUP_CHARS, description="the raw dictation")
    language: Optional[str] = Field(default=None, max_length=12)
    single_line: bool = Field(default=False, description="the target field is one line (a title)")


CLEANUP_SYSTEM = (
    "You tidy up dictated text. Return ONLY the cleaned text, nothing else.\n"
    "Rules:\n"
    "- Fix punctuation, capitalisation and obvious transcription slips.\n"
    "- Remove filler words (um, uh, like, you know) and false starts/repeats.\n"
    "- When the speaker self-corrects (\"no wait, I mean …\"), keep only the correction.\n"
    "- When the speaker clearly lists several items, format them as a '- ' bullet list.\n"
    "- Keep the speaker's words, meaning, tone and language. Never add facts, greetings, "
    "explanations or content that was not said. Never answer questions in the text.\n"
    "- If the text is already clean, return it unchanged."
)


def _guard_cleanup(raw: str, cleaned: str) -> str:
    """Never let the clean-up invent content: an empty, much longer, or chatty result is
    discarded in favour of the raw words."""
    c = (cleaned or "").strip()
    if not c:
        return raw
    if len(c) > len(raw) * 1.25 + 40:
        return raw
    if re.match(r"^(here(’|')?s|sure[,!]|certainly|i('|’)ve cleaned)", c, re.I):
        return raw
    return c


def _run_cleanup(cid: str, body: VoiceCleanupBody, request: Request) -> dict:
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        _member_gate(cur, request, cid)
        spec = llm_util.resolve_spec("dictation_cleanup")
        from portal_backend.provider_keys import provider_api_key

        stored = provider_api_key(cur, cid, spec.provider)
    try:
        key = llm_util.resolve_api_key(spec.provider, explicit=stored)
    except llm_util.LLMError:
        raise HTTPException(409, "AI clean-up needs a model key. Add one in Settings › Models & providers.") from None
    system = CLEANUP_SYSTEM + ("\n- The target is a single-line title: no line breaks, no bullets, no trailing period." if body.single_line else "")
    try:
        resp = llm_util.get_provider(spec.provider).complete(
            spec=spec.swap(max_tokens=min(4096, max(256, len(body.text) // 2))),
            system=system,
            messages=[{"role": "user", "content": f"<dictation>\n{body.text}\n</dictation>"}],
            api_key=key,
        )
    except llm_util.LLMError:
        raise HTTPException(502, "The clean-up model didn't answer. Your original text was kept.") from None
    out = _guard_cleanup(body.text, (resp or {}).get("text", ""))
    out = re.sub(r"^<dictation>\s*|\s*</dictation>$", "", out).strip() or body.text
    if body.single_line:
        out = re.sub(r"\s*\n+\s*", " ", out).strip()
    return {"text": out, "raw": body.text, "changed": out != body.text}


@app.post("/api/containers/{cid}/voice/cleanup", status_code=200, summary="AI clean-up of a finished dictation")
async def voice_cleanup(cid: str, body: VoiceCleanupBody, request: Request):
    """Punctuation, casing, filler removal and lists, using the project's model key
    (use case `dictation_cleanup`). Returns `{text, raw, changed}`; the raw words are
    returned too so the UI can always undo. Never invents content (guarded). Rate-limited
    like the streams (it spends the project's model key)."""
    key = "cleanup:" + _limit_key(cid, request)
    refused = LIMITER.acquire(key)
    if refused:
        raise HTTPException(429, refused.replace("dictations", "clean-ups"))
    try:
        return await asyncio.to_thread(_run_cleanup, cid, body, request)
    finally:
        LIMITER.release(key)
