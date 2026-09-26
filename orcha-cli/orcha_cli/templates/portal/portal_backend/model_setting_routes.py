"""Per-use-case model selection settings routes."""

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
from portal_backend.identity_routes import enforce_grant as _enforce_grant
from portal_backend.identity_routes import require_member_read as _require_member_read
from portal_backend.identity_routes import trusted_actor as _trusted_actor
from portal_backend.schemas import ModelSettingsUpdate

try:
    import llm_util
except ImportError:
    from orcha_cli import llm_util

# ---------- container settings: per-use-case universal-client model selection (#294) ----------
# The SETTINGS model picker (SPEC-SETTINGS §2). Two GETs feed the page — the catalog of providers
# +models (/providers) and the current per-use-case selections layered over shipped defaults
# (/models) — and one human-gated PUT replaces the full override set. The selections are ADVISORY:
# a use-case with no row uses #290's hardcoded default (USE_CASE_DEFAULTS), so the store can be
# empty, stale, or unreachable and the client still works. The wake-triage call-site CONSUMES
# these via wake-scan's `triage_model` (resolved by _resolve_use_case_model below).


def _resolve_use_case_model(cur, cid: str, use_case_key: str) -> Optional[dict]:
    """Return the stored {provider, model} override for (container, use_case), or None when unset.
    None ⇒ the caller falls back to the #290 shipped default — the override is advisory and the
    default is always the floor (SPEC-SETTINGS §6 resolver). A stored row whose model has since
    retired from the catalog is returned AS-IS (not auto-cleared); llm_util.resolve_spec / the
    provider then degrade gracefully on use."""
    cur.execute(
        "SELECT provider, model FROM container_model_settings WHERE container_id=%s AND use_case_key=%s",
        (cid, use_case_key),
    )
    row = cur.fetchone()
    return {"provider": row["provider"], "model": row["model"]} if row else None


@app.get("/api/containers/{cid}/settings/providers", status_code=200)
def get_settings_providers(cid: str, request: Request):
    """The provider+model CATALOG that feeds the SETTINGS dropdowns (SPEC-SETTINGS §0/§3). This is
    the #290 universal-client axis (Anthropic live; OpenAI/Gemini stubbed with available=false),
    NOT GET /api/models (the spawnable-embodiment catalog) — feeding the picker from here is the
    §0 'two model concepts, never one' guarantee. Static (derived from llm_util) but cid-scoped
    for family consistency with the other /settings routes; read-only, no human gate."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (_, cur):
        _require_container(cur, cid)
        # Access model: reads are project-isolated (trusted non-member 403).
        _require_member_read(cur, request, cid)
    return {"providers": llm_util.provider_catalog()}


@app.get("/api/containers/{cid}/settings/models", status_code=200)
def get_settings_models(cid: str, request: Request):
    """The per-use-case model selections for this container — one element per REGISTERED use-case
    (llm_util.USE_CASE_REGISTRY), each with its shipped default and the stored override (if any).
    `is_set=false` ⇒ the page renders ○ 'using shipped default'; `is_set=true` ⇒ ● 'set to X'.
    Read-only (no secrets), so it's open like GET /settings/llm-key."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (_, cur):
        _require_container(cur, cid)
        # Access model: reads are project-isolated (trusted non-member 403).
        _require_member_read(cur, request, cid)
        cur.execute(
            "SELECT use_case_key, provider, model FROM container_model_settings WHERE container_id=%s",
            (cid,),
        )
        stored = {
            r["use_case_key"]: (r["provider"], r["model"]) for r in cur.fetchall()
        }
    use_cases = []
    for uc in llm_util.use_case_registry():
        ov = stored.get(uc["key"])
        use_cases.append(
            {
                "key": uc["key"],
                "label": uc["label"],
                "purpose": uc["purpose"],
                "default_provider": uc["default_provider"],
                "default_model": uc["default_model"],
                "provider": ov[0] if ov else None,
                "model": ov[1] if ov else None,
                "is_set": ov is not None,
            }
        )
    return {"use_cases": use_cases}


@app.put("/api/containers/{cid}/settings/models", status_code=200)
def put_settings_models(cid: str, body: ModelSettingsUpdate, request: Request):
    """Replace the FULL set of per-container model overrides (SPEC-SETTINGS §2.2). HUMAN-AUTHORITY
    gated + audit-logged — a model swap is a deliberate cost/quality decision, mirroring
    /settings/llm-key and /auto-wake. Semantics:
      * each entry with BOTH provider+model set, a REGISTERED key, and a valid catalog choice is
        stored (upsert); a stubbed provider / bogus model / unknown key is a 400 (no partial write);
      * any registered use-case NOT named (or sent with null provider+model) is RESET to default.
    Returns the refreshed list (same shape as GET) so the page reconciles from the server."""
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    registered = {uc["key"] for uc in llm_util.USE_CASE_REGISTRY}
    # Validate the whole body BEFORE writing anything (all-or-nothing — no partial persist).
    to_set: dict[str, tuple[str, str]] = {}
    for ov in body.use_cases:
        if ov.provider is None and ov.model is None:
            continue  # an explicit reset (treated like omission)
        if ov.key not in registered:
            raise HTTPException(400, f"unknown use-case key '{ov.key}'")
        if not ov.provider or not ov.model:
            raise HTTPException(
                400,
                f"use-case '{ov.key}': provider and model must both be set (or both null to reset)",
            )
        if not llm_util.is_catalog_choice(ov.provider, ov.model):
            raise HTTPException(
                400,
                f"use-case '{ov.key}': '{ov.provider}/{ov.model}' is not a selectable catalog choice",
            )
        to_set[ov.key] = (ov.provider, ov.model)
    with db_cursor() as (conn, cur):
        _require_container(cur, cid)
        # Per-project identity: a trusted proxy login IS the actor (403 non-member).
        # Access model: model settings ride the keys bundle — owner-or-manage_keys.
        _enforce_grant(cur, request, cid, "manage_keys")
        body.actor_agent_id = _trusted_actor(cur, request, cid, body.actor_agent_id)
        _require_kind(
            cur, body.actor_agent_id, ("human",)
        )  # a cost/quality decision is a human action
        # Full-replace: drop the prior override set, then insert the validated new one. Any
        # registered key absent from `to_set` is therefore reset to its shipped default.
        cur.execute(
            "DELETE FROM container_model_settings WHERE container_id=%s", (cid,)
        )
        for key, (provider, model) in to_set.items():
            cur.execute(
                "INSERT INTO container_model_settings(container_id, use_case_key, provider, model) "
                "VALUES (%s, %s, %s, %s)",
                (cid, key, provider, model),
            )
        log_event(
            cur,
            cid,
            "human",
            body.actor_agent_id,
            "container",
            cid,
            "model_settings_set",
            {
                "overrides": {
                    k: {"provider": p, "model": m} for k, (p, m) in to_set.items()
                }
            },
        )
        conn.commit()
        # Re-read inside the txn so the returned list reflects exactly what was persisted.
        cur.execute(
            "SELECT use_case_key, provider, model FROM container_model_settings WHERE container_id=%s",
            (cid,),
        )
        stored = {
            r["use_case_key"]: (r["provider"], r["model"]) for r in cur.fetchall()
        }
    use_cases = []
    for uc in llm_util.use_case_registry():
        ov = stored.get(uc["key"])
        use_cases.append(
            {
                "key": uc["key"],
                "label": uc["label"],
                "purpose": uc["purpose"],
                "default_provider": uc["default_provider"],
                "default_model": uc["default_model"],
                "provider": ov[0] if ov else None,
                "model": ov[1] if ov else None,
                "is_set": ov is not None,
            }
        )
    return {"use_cases": use_cases}
