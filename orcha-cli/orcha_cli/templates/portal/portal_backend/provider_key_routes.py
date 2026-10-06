"""Provider-specific credential management routes."""

import logging
import os
from typing import Optional

from fastapi import HTTPException, Request

from portal_backend.agent_status import log_event
from portal_backend.application import app
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
from portal_backend.llm_key_routes import _llm_error_public_detail
from portal_backend.provider_keys import (
    AGENT_KEY_RUNTIME as _AGENT_KEY_RUNTIME,
)
from portal_backend.provider_keys import (
    provider_api_key as _provider_api_key,
)
from portal_backend.provider_keys import (
    provider_stored_row as _provider_stored_row,
)
from portal_backend.identity_routes import enforce_grant as _enforce_grant
from portal_backend.identity_routes import require_member_read as _require_member_read
from portal_backend.identity_routes import trusted_actor as _trusted_actor
from portal_backend.schemas import (
    LlmKeyActor,
    LlmKeyTest,
    LlmKeyUpdate,
    ProviderKeyAgentUse,
    ProviderKeyAgentUseOut,
    ProviderKeyList,
)

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


_KEY_PREFIX = {"anthropic": "sk-ant-", "xai": "xai-", "openai": "sk-"}

# Agent-only key slots (migration 071): a provider the universal client can't call yet (no catalog
# models) but whose key an AGENT RUNTIME can use — OpenAI for Codex. It gets a key row so a user
# with no ChatGPT subscription can bill Codex agent runs to an API key. The env override
# (ORCHA_LLM_API_KEY) never applies to these slots: it is the helpers' key, not an agent key.
_AGENT_ONLY_PROVIDERS = {"openai": "OpenAI"}
_OPENAI_MODELS_URL = "https://api.openai.com/v1/models"


def _mask_provider_key(provider: str, hint: Optional[str]) -> Optional[str]:
    """M5b: the last-4 hint with the PROVIDER's own key prefix (never Anthropic's `sk-`
    on an xAI key), or just '...WXYZ' for a provider with no well-known prefix."""
    if not hint:
        return None
    return f"{_KEY_PREFIX.get(provider, '')}...{hint}"


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


def _key_provider(provider: str) -> Optional[dict]:
    """A provider that may hold a key here: an AVAILABLE catalog provider, or an agent-only slot
    (OpenAI → Codex agent runs). Returns {id, name, agent_only} or None."""
    p = _available_provider(provider)
    if p:
        return {"id": p["id"], "name": p["name"], "agent_only": False}
    if provider in _AGENT_ONLY_PROVIDERS:
        return {"id": provider, "name": _AGENT_ONLY_PROVIDERS[provider], "agent_only": True}
    return None


def _key_providers() -> list[dict]:
    """Every provider that gets a key row on the SETTINGS page, catalog order, agent-only last."""
    try:
        import llm_util
    except ImportError:
        from orcha_cli import llm_util
    rows = [
        {"id": p["id"], "name": p["name"], "agent_only": False}
        for p in llm_util.PROVIDER_CATALOG
        if p["available"]
    ]
    seen = {r["id"] for r in rows}
    rows += [
        {"id": pid, "name": name, "agent_only": True}
        for pid, name in _AGENT_ONLY_PROVIDERS.items()
        if pid not in seen
    ]
    return rows


def _ping_openai_key(candidate: str) -> dict:
    """Credential ping for an agent-only OpenAI key: an authenticated GET /v1/models (no tokens
    spent). Never echoes the key; a 401/403 is ok=False, never a 500."""
    import urllib.error
    import urllib.request

    req = urllib.request.Request(
        _OPENAI_MODELS_URL,
        headers={"Authorization": f"Bearer {candidate}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:  # noqa: S310 - fixed https URL
            if 200 <= resp.status < 300:
                return {"ok": True, "detail": "key accepted by the OpenAI API"}
            return {"ok": False, "detail": f"OpenAI API answered HTTP {resp.status}"}
    except urllib.error.HTTPError as e:
        KEYTEST_LOG.warning("openai key test failed: HTTP %s", e.code)
        if e.code in (401, 403):
            return {"ok": False, "detail": "OpenAI rejected the key (invalid or revoked)"}
        return {"ok": False, "detail": f"OpenAI API answered HTTP {e.code}"}
    except Exception as e:  # noqa: BLE001 - network failure is a verdict, not a 500
        KEYTEST_LOG.warning("openai key test failed: %s", type(e).__name__)
        return {"ok": False, "detail": "couldn't reach the OpenAI API"}


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


@app.get(
    "/api/containers/{cid}/settings/provider-keys",
    status_code=200,
    response_model=ProviderKeyList,
)
def list_container_provider_keys(cid: str, request: Request):
    """One key-status entry per AVAILABLE catalog provider (plus the agent-only OpenAI slot), for
    the SETTINGS key cards. NEVER returns a secret — only a masked 'sk-...1234' hint + source (env
    override shadows stored) + the agent-run opt-in (`use_for_agents`, migration 071).
    Read-only/open, like GET /settings/providers."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    env_override = os.environ.get("ORCHA_LLM_API_KEY")
    keys = []
    with db_cursor() as (_, cur):
        _require_container(cur, cid)
        # Access model: reads are project-isolated (trusted non-member 403).
        _require_member_read(cur, request, cid)
        for p in _key_providers():
            row = _provider_stored_row(cur, cid, p["id"])
            if env_override and not p["agent_only"]:
                entry = {
                    "configured": True,
                    "source": "env",
                    "masked": _mask_provider_key(p["id"], secret_box.last4(env_override)),
                    "set_at": None,
                }
            elif row:
                entry = {
                    "configured": True,
                    "source": "db",
                    "masked": _mask_provider_key(p["id"], row["key_hint"]),
                    "set_at": row["set_at"],
                }
            else:
                entry = {
                    "configured": False,
                    "source": None,
                    "masked": None,
                    "set_at": None,
                }
            runtime = _AGENT_KEY_RUNTIME.get(p["id"])
            entry.update(
                {
                    "provider": p["id"],
                    "name": p["name"],
                    "stored": bool(row),
                    "use_for_agents": bool(row and row.get("use_for_agents") and runtime),
                    "agent_runtime": runtime,
                    "agent_only": p["agent_only"],
                }
            )
            keys.append(entry)
    return {"keys": keys}


@app.put("/api/containers/{cid}/settings/provider-keys/{provider}", status_code=200)
def put_container_provider_key(cid: str, provider: str, body: LlmKeyUpdate, request: Request):
    """Seal + store the key for one provider. HUMAN-AUTHORITY gated + audit-logged. Anthropic
    writes its legacy column; other providers upsert container_provider_keys. 503 w/o ORCHA_SECRET_KEY."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    if not _key_provider(provider):
        raise HTTPException(400, f"'{provider}' is not an available catalog provider")
    key = body.api_key.strip()
    if not key:
        raise HTTPException(400, "api_key must not be blank")
    with db_cursor() as (conn, cur):
        _require_container(cur, cid)
        # Per-project identity: a trusted proxy login IS the actor (403 non-member).
        # Access model: credentials are owner-or-manage_keys (trusted lane).
        _enforce_grant(cur, request, cid, "manage_keys")
        body.actor_agent_id = _trusted_actor(cur, request, cid, body.actor_agent_id)
        _require_kind(cur, body.actor_agent_id, ("human",))
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
        "masked": _mask_provider_key(provider, hint),
    }


@app.delete("/api/containers/{cid}/settings/provider-keys/{provider}", status_code=200)
def delete_container_provider_key(cid: str, provider: str, body: LlmKeyActor, request: Request):
    """Remove one provider's stored key (resolution falls back to env override, else none).
    HUMAN-AUTHORITY gated + audit-logged."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    if not _key_provider(provider):
        raise HTTPException(400, f"'{provider}' is not an available catalog provider")
    with db_cursor() as (conn, cur):
        _require_container(cur, cid)
        # Per-project identity: a trusted proxy login IS the actor (403 non-member).
        # Access model: credentials are owner-or-manage_keys (trusted lane).
        _enforce_grant(cur, request, cid, "manage_keys")
        body.actor_agent_id = _trusted_actor(cur, request, cid, body.actor_agent_id)
        _require_kind(cur, body.actor_agent_id, ("human",))
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
    if env_override and not _key_provider(provider)["agent_only"]:
        return {
            "configured": True,
            "source": "env",
            "provider": provider,
            "masked": _mask_provider_key(provider, secret_box.last4(env_override)),
        }
    return {"configured": False, "source": None, "provider": provider, "masked": None}


@app.post(
    "/api/containers/{cid}/settings/provider-keys/{provider}/test", status_code=200
)
def test_container_provider_key(cid: str, provider: str, body: LlmKeyTest, request: Request):
    """Credential ping against `provider`'s API. HUMAN-AUTHORITY gated. With `api_key` -> test that
    candidate (pre-save); without -> test the currently-resolved key for this provider."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    if not _key_provider(provider):
        raise HTTPException(400, f"'{provider}' is not an available catalog provider")
    with db_cursor() as (conn, cur):
        _require_container(cur, cid)
        # Per-project identity: a trusted proxy login IS the actor (403 non-member).
        # Access model: credentials are owner-or-manage_keys (trusted lane).
        _enforce_grant(cur, request, cid, "manage_keys")
        body.actor_agent_id = _trusted_actor(cur, request, cid, body.actor_agent_id)
        _require_kind(cur, body.actor_agent_id, ("human",))
        agent_only = _key_provider(provider)["agent_only"]
        if body.api_key and body.api_key.strip():
            candidate: Optional[str] = body.api_key.strip()
        elif agent_only:
            # Agent-only slot: the stored key only — the env override is the helpers' key.
            candidate = _stored_key(cur, cid, provider)
        else:
            candidate = _provider_api_key(cur, cid, provider)
    if not candidate:
        return {
            "ok": False,
            "detail": "no API key to test: none supplied, none stored, and ORCHA_LLM_API_KEY is unset",
        }
    if agent_only:
        return _ping_openai_key(candidate)
    return _ping_provider_key(provider, candidate)


def _stored_key(cur, cid: str, provider: str) -> Optional[str]:
    """The stored (sealed) key for `provider`, opened — no env override. None if absent/unopenable."""
    row = _provider_stored_row(cur, cid, provider)
    if not row or not row["key_enc"]:
        return None
    try:
        return secret_box.unseal(row["key_enc"])
    except Exception:  # noqa: BLE001 - an unopenable blob is 'no key', never a 500
        return None


@app.put(
    "/api/containers/{cid}/settings/provider-keys/{provider}/agent-use",
    status_code=200,
    response_model=ProviderKeyAgentUseOut,
)
def put_container_provider_key_agent_use(
    cid: str, provider: str, body: ProviderKeyAgentUse, request: Request
):
    """Opt this project's stored `provider` key in (or out) of AGENT RUNS (migration 071).

    On: the notifier injects the key into every agent run on this project for the matching
    runtime (anthropic → Claude via ANTHROPIC_API_KEY; openai → Codex via CODEX_API_KEY +
    OPENAI_API_KEY), so runs bill the API key instead of a Claude/ChatGPT subscription.
    Off (the default): nothing is injected — the CLI's own login is used, unchanged.

    Same gate as storing the key: owner-or-manage_keys, human actor, audit-logged. Only the
    anthropic and openai keys can serve an agent runtime (400 otherwise); a key must be stored
    first (409) — the env override is never handed to agents."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    runtime = _AGENT_KEY_RUNTIME.get(provider)
    if not runtime or not _key_provider(provider):
        raise HTTPException(
            400,
            f"'{provider}' keys can't be used for agent runs (only anthropic → Claude "
            "and openai → Codex)",
        )
    with db_cursor() as (conn, cur):
        _require_container(cur, cid)
        _enforce_grant(cur, request, cid, "manage_keys")
        body.actor_agent_id = _trusted_actor(cur, request, cid, body.actor_agent_id)
        _require_kind(cur, body.actor_agent_id, ("human",))
        cur.execute(
            "UPDATE container_provider_keys SET use_for_agents=%s "
            "WHERE container_id=%s AND provider=%s",
            (body.use_for_agents, cid, provider),
        )
        if cur.rowcount == 0:
            raise HTTPException(
                409,
                "store an API key for this provider first — agent runs only use a key saved "
                "on this project",
            )
        log_event(
            cur,
            cid,
            "human",
            body.actor_agent_id,
            "container",
            cid,
            "llm_key_agent_use_set",
            {"provider": provider, "use_for_agents": body.use_for_agents},
        )
        conn.commit()
    return {
        "provider": provider,
        "use_for_agents": body.use_for_agents,
        "agent_runtime": runtime,
    }
