"""Provider-specific credential management routes."""

import logging
import os
from typing import Optional

from fastapi import HTTPException, Request

from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.auth_provider import authorize, resolve_actor
from portal_backend.database import db_cursor
from portal_backend.guards import (
    require_container as _require_container,
)
from portal_backend.guards import (
    require_kind as _require_kind,
)
from portal_backend.guards import (
    valid_uuid as _valid_uuid,
)
from portal_backend.llm_key_routes import _llm_error_public_detail, _mask_llm_key
from portal_backend.provider_keys import (
    provider_api_key as _provider_api_key,
)
from portal_backend.provider_keys import (
    provider_stored_row as _provider_stored_row,
)
from portal_backend.schemas import LlmKeyActor, LlmKeyTest, LlmKeyUpdate

try:
    import secret_box
except ImportError:
    from orcha_cli import secret_box

KEYTEST_LOG = logging.getLogger("orcha.llm-key-test")

# ---------- container settings: per-PROVIDER LLM keys (multi-provider, follow-on to #294 Item 1) ----------
# Migration 020's single key is Anthropic-only; with >1 live provider (#290 catalog: Anthropic +
# xAI/Grok) a use-case pointed at xAI needs an xAI key. These routes manage ONE key per available
# catalog provider, uniformly for the SETTINGS page — the Anthropic key still lives in its own
# column (the /settings/llm-key routes above remain), other providers in container_provider_keys.
# Same discipline as /settings/llm-key: human-gated writes, never return plaintext, 503 w/o master key.


def _available_provider(provider: str) -> Optional[dict]:
    """The catalog entry for `provider` if it's an AVAILABLE provider, else None."""
    try:
        import llm_util
    except ImportError:
        from orcha_cli import llm_util
    return next(
        (
            p
            for p in llm_util.PROVIDER_CATALOG
            if p["id"] == provider and p["available"]
        ),
        None,
    )


def _ping_provider_key(provider: str, candidate: str) -> dict:
    """Server-side credential ping against `provider`'s API using its cheapest catalog model and a
    1-token request. Returns {ok, detail}; a 401/bad-key is ok=False, never a 500."""
    try:
        import llm_util
    except ImportError:
        from orcha_cli import llm_util
    p = _available_provider(provider)
    if not p or not p["models"]:
        return {
            "ok": False,
            "detail": f"provider '{provider}' has no testable catalog model",
        }
    spec = llm_util.ModelSpec(
        provider=provider, model=p["models"][0]["id"], max_tokens=1, timeout_s=10.0
    )
    try:
        prov = llm_util.get_provider(provider)
        prov.complete(
            spec=spec,
            system=None,
            messages=[{"role": "user", "content": "ping"}],
            api_key=candidate,
        )
        return {"ok": True, "detail": f"key accepted by the {p['name']} API"}
    except llm_util.LLMError as e:
        KEYTEST_LOG.warning("%s key test failed: %s", provider, e)
        return {"ok": False, "detail": _llm_error_public_detail(p["name"], e)}


@app.get("/api/containers/{cid}/settings/provider-keys", status_code=200)
def list_container_provider_keys(cid: str):
    """One key-status entry per AVAILABLE catalog provider, for the SETTINGS key cards. NEVER
    returns a secret — only a masked 'sk-...1234' hint + source (env override shadows stored).
    Read-only/open, like GET /settings/providers."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    try:
        import llm_util
    except ImportError:
        from orcha_cli import llm_util
    env_override = os.environ.get("ORCHA_LLM_API_KEY")
    keys = []
    with db_cursor() as (_, cur):
        _require_container(cur, cid)
        for p in llm_util.PROVIDER_CATALOG:
            if not p["available"]:
                continue
            row = _provider_stored_row(cur, cid, p["id"])
            if env_override:
                entry = {
                    "configured": True,
                    "source": "env",
                    "masked": _mask_llm_key(secret_box.last4(env_override)),
                    "set_at": None,
                }
            elif row:
                entry = {
                    "configured": True,
                    "source": "db",
                    "masked": _mask_llm_key(row["key_hint"]),
                    "set_at": row["set_at"],
                }
            else:
                entry = {
                    "configured": False,
                    "source": None,
                    "masked": None,
                    "set_at": None,
                }
            entry.update({"provider": p["id"], "name": p["name"]})
            keys.append(entry)
    return {"keys": keys}


@app.put("/api/containers/{cid}/settings/provider-keys/{provider}", status_code=200)
def put_container_provider_key(
    cid: str, provider: str, body: LlmKeyUpdate, request: Request
):
    """Seal + store the key for one provider. HUMAN-AUTHORITY gated + audit-logged. Anthropic
    writes its legacy column; other providers upsert container_provider_keys. 503 w/o ORCHA_SECRET_KEY."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    if not _available_provider(provider):
        raise HTTPException(400, f"'{provider}' is not an available catalog provider")
    key = body.api_key.strip()
    if not key:
        raise HTTPException(400, "api_key must not be blank")
    with db_cursor() as (conn, cur):
        # SEAM A (#211): default no-op resolve/authorize; downstream overridable.
        resolved_actor = resolve_actor(cur, request, cid, body.actor_agent_id)
        authorize(cur, request, resolved_actor, "update_settings", cid)
        _require_kind(cur, body.actor_agent_id, ("human",))
        _require_container(cur, cid)
        if not secret_box.master_key_present():
            raise HTTPException(
                503,
                "encrypted key storage is disabled: ORCHA_SECRET_KEY is not set in the portal "
                "environment. Set it to store a key, or use the ORCHA_LLM_API_KEY env override.",
            )
        sealed = secret_box.seal(key)
        hint = secret_box.last4(key)
        # Unified table (migration 027) — every provider, Anthropic included, upserts here.
        cur.execute(
            "INSERT INTO container_provider_keys (container_id, provider, key_enc, key_hint, set_at) "
            "VALUES (%s, %s, %s, %s, now()) "
            "ON CONFLICT (container_id, provider) DO UPDATE SET "
            "key_enc=EXCLUDED.key_enc, key_hint=EXCLUDED.key_hint, set_at=now()",
            (cid, provider, sealed, hint),
        )
        log_event(
            cur,
            cid,
            "human",
            body.actor_agent_id,
            "container",
            cid,
            "llm_key_set",
            {"provider": provider, "hint": hint},
        )
        conn.commit()
    return {
        "configured": True,
        "source": "db",
        "provider": provider,
        "masked": _mask_llm_key(hint),
    }


@app.delete("/api/containers/{cid}/settings/provider-keys/{provider}", status_code=200)
def delete_container_provider_key(
    cid: str, provider: str, body: LlmKeyActor, request: Request
):
    """Remove one provider's stored key (resolution falls back to env override, else none).
    HUMAN-AUTHORITY gated + audit-logged."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    if not _available_provider(provider):
        raise HTTPException(400, f"'{provider}' is not an available catalog provider")
    with db_cursor() as (conn, cur):
        # SEAM A (#211): default no-op resolve/authorize; downstream overridable.
        resolved_actor = resolve_actor(cur, request, cid, body.actor_agent_id)
        authorize(cur, request, resolved_actor, "update_settings", cid)
        _require_kind(cur, body.actor_agent_id, ("human",))
        _require_container(cur, cid)
        # Unified table (migration 027) — clear the row for any provider, Anthropic included.
        cur.execute(
            "DELETE FROM container_provider_keys WHERE container_id=%s AND provider=%s",
            (cid, provider),
        )
        log_event(
            cur,
            cid,
            "human",
            body.actor_agent_id,
            "container",
            cid,
            "llm_key_cleared",
            {"provider": provider},
        )
        conn.commit()
    env_override = os.environ.get("ORCHA_LLM_API_KEY")
    if env_override:
        return {
            "configured": True,
            "source": "env",
            "provider": provider,
            "masked": _mask_llm_key(secret_box.last4(env_override)),
        }
    return {"configured": False, "source": None, "provider": provider, "masked": None}


@app.post(
    "/api/containers/{cid}/settings/provider-keys/{provider}/test", status_code=200
)
def test_container_provider_key(
    cid: str, provider: str, body: LlmKeyTest, request: Request
):
    """Credential ping against `provider`'s API. HUMAN-AUTHORITY gated. With `api_key` -> test that
    candidate (pre-save); without -> test the currently-resolved key for this provider."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    if not _available_provider(provider):
        raise HTTPException(400, f"'{provider}' is not an available catalog provider")
    with db_cursor() as (conn, cur):
        # SEAM A (#211): default no-op resolve/authorize; downstream overridable.
        resolved_actor = resolve_actor(cur, request, cid, body.actor_agent_id)
        authorize(cur, request, resolved_actor, "update_settings", cid)
        _require_kind(cur, body.actor_agent_id, ("human",))
        _require_container(cur, cid)
        if body.api_key and body.api_key.strip():
            candidate: Optional[str] = body.api_key.strip()
        else:
            candidate = _provider_api_key(cur, cid, provider)
    if not candidate:
        return {
            "ok": False,
            "detail": "no API key to test: none supplied, none stored, and ORCHA_LLM_API_KEY is unset",
        }
    return _ping_provider_key(provider, candidate)
