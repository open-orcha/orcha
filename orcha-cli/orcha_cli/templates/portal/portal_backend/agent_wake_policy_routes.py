"""Manage an agent's human-controlled recurring wake policy."""

from fastapi import HTTPException, Request

from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_kind, valid_uuid
from portal_backend.identity_routes import enforce_grant, trusted_actor
from portal_backend.schemas.agent_state import AutoWakeUpdate


@app.patch("/api/agents/{aid}/auto-wake", status_code=200)
def update_agent_auto_wake(aid: str, body: AutoWakeUpdate, request: Request):
    """#266: set or clear an agent's clock-driven AUTO-WAKE interval. HUMAN-AUTHORITY gated +
    audit-logged, mirroring /verify and the protocol PATCH (Orcha#30): only a kind='human' actor
    may change wake policy. `interval_secs` is explicit (int>=60 to enable, null to disable) — the
    60s floor is also enforced by the DB CHECK, so a sub-floor value is rejected at the Pydantic
    layer (422) before it reaches SQL. Editing a HUMAN agent is rejected (humans aren't woken).
    The new value surfaces in wake-scan (the `auto_wake_due`/`auto_wake_interval_secs` candidate
    fields the notifier reads) and the container agent snapshot."""
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        cur.execute("SELECT kind, container_id FROM agents WHERE id=%s", (aid,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, f"agent {aid} not found")
        # Per-project identity: a trusted proxy login IS the actor (403 non-member).
        # Access model: the per-agent wake switch is owner-or-manage_autonomy.
        enforce_grant(cur, request, str(row["container_id"]), "manage_autonomy")
        body.actor_agent_id = trusted_actor(
            cur, request, str(row["container_id"]), body.actor_agent_id
        )
        require_kind(cur, body.actor_agent_id, ("human",))
        if row["kind"] == "human":
            raise HTTPException(
                400, "humans are not woken — auto-wake applies to kind='ai' agents"
            )
        cur.execute(
            "UPDATE agents SET auto_wake_interval_secs=%s WHERE id=%s "
            "RETURNING id, alias, auto_wake_interval_secs",
            (body.interval_secs, aid),
        )
        updated = cur.fetchone()
        log_event(
            cur,
            str(row["container_id"]),
            "human",
            body.actor_agent_id,
            "agent",
            aid,
            "auto_wake_updated",
            {"interval_secs": body.interval_secs},
        )
        conn.commit()
    return {
        "agent_id": aid,
        "alias": updated["alias"],
        "auto_wake_interval_secs": updated["auto_wake_interval_secs"],
        "enabled": updated["auto_wake_interval_secs"] is not None,
    }
