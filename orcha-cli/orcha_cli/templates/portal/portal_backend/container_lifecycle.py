"""Catalog and lifecycle routes for portal containers."""

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
from portal_backend.model_policy import (
    AVAILABLE_MODELS,
    AVAILABLE_REASONING_EFFORTS,
    DEFAULT_MODEL,
    DEFAULT_REASONING_EFFORT,
)
from portal_backend.identity_routes import enforce_grant as _enforce_grant
from portal_backend.identity_routes import trusted_actor as _trusted_actor
from portal_backend.schemas import ContainerStatusUpdate

ALLOWED_CONTAINER_STATUSES = {"active", "paused", "completed", "cancelled", "failed"}


@app.get("/api/models")
def list_models():
    """D7: the curated model list the create-agent picker renders ({id, name}) plus
    runtime and model-specific reasoning efforts. There is no live model-list API from
    the worker CLIs, so this is a maintained constant. B8's dropdown reads this; the
    selected id is persisted as agents.model."""
    return {"models": AVAILABLE_MODELS, "default": DEFAULT_MODEL}


@app.get("/api/reasoning-efforts")
def list_reasoning_efforts():
    """GH #51: all curated effort labels plus the default.

    Clients filter this union through each /api/models row's reasoning_efforts list;
    the server applies the same per-model validation before persisting a selection.
    """
    return {"efforts": AVAILABLE_REASONING_EFFORTS, "default": DEFAULT_REASONING_EFFORT}


@app.post("/api/containers/{cid}/status", status_code=200)
def set_container_status(cid: str, body: ContainerStatusUpdate, request: Request):
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    if body.status not in ALLOWED_CONTAINER_STATUSES:
        raise HTTPException(
            400, f"status must be one of {sorted(ALLOWED_CONTAINER_STATUSES)}"
        )
    with db_cursor() as (conn, cur):
        c = _require_container(cur, cid)
        # Per-project identity: a trusted proxy login IS the actor (403 non-member).
        # Access model: pause/resume/complete are owner-or-manage_autonomy.
        _enforce_grant(cur, request, cid, "manage_autonomy")
        body.actor_agent_id = _trusted_actor(cur, request, cid, body.actor_agent_id)
        _require_kind(cur, body.actor_agent_id, ("human",))  # Orcha#30
        old = c["status"]
        completed_clause = ""
        params = [body.status, cid]
        if body.status in ("completed", "cancelled", "failed"):
            completed_clause = ", completed_at = COALESCE(completed_at, now())"
        cur.execute(
            f"UPDATE containers SET status=%s{completed_clause} WHERE id=%s", params
        )
        log_event(
            cur,
            cid,
            "human",
            None,
            "container",
            cid,
            "status_changed",
            {"from": old, "to": body.status},
        )
        conn.commit()
    return {"container_id": cid, "status": body.status, "from": old}
