"""Encrypted Anthropic credential settings routes."""

import logging
import os
import re
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

# ---------- container settings: encrypted LLM API key (#294 Item 1) ----------
# Per-container Anthropic key for the universal LLM client (#290). Stored SEALED by secret_box
# (the row alone is never a usable credential; the master key lives in ORCHA_SECRET_KEY off-row).
# Read path (env override > stored > none) is secret_box.resolve_llm_key; triage call-site wiring
# is downstream (#288/#290), deliberately not here. GET is open (returns only a masked hint, never
# a secret); PUT/DELETE/test are HUMAN-AUTHORITY gated + audit-logged, like /status & /auto-wake.


def _mask_llm_key(hint: Optional[str]) -> Optional[str]:
    """Render the last-4 hint as a masked display value, or None when no key is set."""
    return f"sk-...{hint}" if hint else None


@app.get("/api/containers/{cid}/settings/llm-key", status_code=200)
def get_container_llm_key(cid: str):
    """Report whether a container has an LLM key configured, and from where — NEVER the secret.
    Precedence mirrors the read path: an ORCHA_LLM_API_KEY env override is reported as
    source='env' (and shadows any stored key); else a stored key is source='db'; else
    configured=False. `masked` is a 'sk-...1234' hint; `set_at` feeds the SETTINGS banner."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        _require_container(cur, cid)
        row = _provider_stored_row(
            cur, cid, "anthropic"
        )  # unified table (migration 027)
    env_override = os.environ.get("ORCHA_LLM_API_KEY")
    if env_override:
        return {
            "configured": True,
            "source": "env",
            "masked": _mask_llm_key(secret_box.last4(env_override)),
            "set_at": None,
        }
    if row and row["key_enc"]:
        return {
            "configured": True,
            "source": "db",
            "masked": _mask_llm_key(row["key_hint"]),
            "set_at": row["set_at"],
        }
    return {"configured": False, "source": None, "masked": None, "set_at": None}


@app.put("/api/containers/{cid}/settings/llm-key", status_code=200)
def put_container_llm_key(cid: str, body: LlmKeyUpdate, request: Request):
    """Seal + store a per-container Anthropic key. HUMAN-AUTHORITY gated + audit-logged. Returns
    the masked hint, never the plaintext. 503 if ORCHA_SECRET_KEY is unset (encrypted persistence
    disabled — the operator can still use the ORCHA_LLM_API_KEY env override instead)."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    key = body.api_key.strip()
    if not key:
        raise HTTPException(400, "api_key must not be blank")
    with db_cursor() as (conn, cur):
        # SEAM A (#211): default no-op resolve/authorize; downstream overridable.
        resolved_actor = resolve_actor(cur, request, cid, body.actor_agent_id)
        authorize(cur, request, resolved_actor, "update_settings", cid)
        _require_kind(
            cur, body.actor_agent_id, ("human",)
        )  # writing a credential is a human action
        _require_container(cur, cid)
        if not secret_box.master_key_present():
            raise HTTPException(
                503,
                "encrypted key storage is disabled: ORCHA_SECRET_KEY is not set in the portal "
                "environment. Set it to store a key, or use the ORCHA_LLM_API_KEY env override.",
            )
        sealed = secret_box.seal(key)
        hint = secret_box.last4(key)
        # Unified table (migration 027): Anthropic is just provider='anthropic' here now.
        cur.execute(
            "INSERT INTO container_provider_keys (container_id, provider, key_enc, key_hint, set_at) "
            "VALUES (%s, 'anthropic', %s, %s, now()) "
            "ON CONFLICT (container_id, provider) DO UPDATE SET "
            "key_enc=EXCLUDED.key_enc, key_hint=EXCLUDED.key_hint, set_at=now()",
            (cid, sealed, hint),
        )
        log_event(
            cur,
            cid,
            "human",
            body.actor_agent_id,
            "container",
            cid,
            "llm_key_set",
            {"provider": "anthropic", "hint": hint},
        )
        conn.commit()
    return {"configured": True, "source": "db", "masked": _mask_llm_key(hint)}


@app.delete("/api/containers/{cid}/settings/llm-key", status_code=200)
def delete_container_llm_key(cid: str, body: LlmKeyActor, request: Request):
    """Remove the stored key (resolution falls back to the env override, else none). HUMAN-AUTHORITY
    gated + audit-logged. Carries a JSON body for the actor (no other body fields)."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        # SEAM A (#211): default no-op resolve/authorize; downstream overridable.
        resolved_actor = resolve_actor(cur, request, cid, body.actor_agent_id)
        authorize(cur, request, resolved_actor, "update_settings", cid)
        _require_kind(cur, body.actor_agent_id, ("human",))
        _require_container(cur, cid)
        cur.execute(
            "DELETE FROM container_provider_keys WHERE container_id=%s AND provider='anthropic'",
            (cid,),
        )
        log_event(
            cur,
            cid,
            "human",
            body.actor_agent_id,
            "container",
            cid,
            "llm_key_cleared",
            {"provider": "anthropic"},
        )
        conn.commit()
    env_override = os.environ.get("ORCHA_LLM_API_KEY")
    if env_override:
        return {
            "configured": True,
            "source": "env",
            "masked": _mask_llm_key(secret_box.last4(env_override)),
        }
    return {"configured": False, "source": None, "masked": None}


def _llm_error_public_detail(provider_label: str, e: Exception) -> str:
    """Client-safe verdict for a failed key-test ping. Provider error text can embed upstream
    response bodies / stack fragments (py/stack-trace-exposure), so the ONLY thing surfaced from
    the exception is the leading HTTP status code (laundered through int()); the full error goes
    to the server log at the call site."""
    m = re.match(r"HTTP (\d{3}) ", str(e))
    if m:
        return (
            f"the {provider_label} API returned HTTP {int(m.group(1))} — "
            "check the key (full error in the portal server log)"
        )
    return (
        f"could not reach the {provider_label} API — "
        "check the key and network (full error in the portal server log)"
    )


@app.post("/api/containers/{cid}/settings/llm-key/test", status_code=200)
def test_container_llm_key(cid: str, body: LlmKeyTest, request: Request):
    """Server-side credential ping against the Anthropic API. HUMAN-AUTHORITY gated. With `api_key`
    -> test that candidate (the pre-save setup flow); without -> test the currently-resolved key
    (env override > stored). Returns {ok, detail} — a 401 from Anthropic is ok=False (bad key),
    never a 500. The network call runs OUTSIDE the DB transaction (no lock held during I/O)."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        # SEAM A (#211): default no-op resolve/authorize; downstream overridable.
        resolved_actor = resolve_actor(cur, request, cid, body.actor_agent_id)
        authorize(cur, request, resolved_actor, "update_settings", cid)
        _require_kind(cur, body.actor_agent_id, ("human",))
        _require_container(cur, cid)
        if body.api_key and body.api_key.strip():
            candidate: Optional[str] = body.api_key.strip()
        else:
            candidate = _provider_api_key(
                cur, cid, "anthropic"
            )  # unified table (migration 027)
    if not candidate:
        return {
            "ok": False,
            "detail": "no API key to test: none supplied, none stored, and ORCHA_LLM_API_KEY is unset",
        }
    try:  # same dual-context import as secret_box / llm_util
        import llm_util
    except ImportError:
        from orcha_cli import llm_util
    spec = llm_util.ModelSpec(
        provider="anthropic", model=llm_util.MODEL_HAIKU, max_tokens=1, timeout_s=10.0
    )
    try:
        prov = llm_util.get_provider("anthropic")
        prov.complete(
            spec=spec,
            system=None,
            messages=[{"role": "user", "content": "ping"}],
            api_key=candidate,
        )
        return {"ok": True, "detail": "key accepted by the Anthropic API"}
    except llm_util.LLMError as e:
        KEYTEST_LOG.warning("anthropic key test failed for container %s: %s", cid, e)
        return {"ok": False, "detail": _llm_error_public_detail("Anthropic", e)}
