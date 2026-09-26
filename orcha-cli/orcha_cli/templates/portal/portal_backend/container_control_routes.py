"""Manage container wake and autonomy controls."""

from fastapi import HTTPException, Request

from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container, require_kind, valid_uuid
from portal_backend.identity_routes import enforce_grant, trusted_actor
from portal_backend.schemas.wakes import AutonomyUpdate, WakesToggle

AUTONOMY_LEVELS = ("plan", "pr", "full")


@app.post("/api/containers/{cid}/wakes", status_code=200)
def set_wakes_enabled(cid: str, body: WakesToggle, request: Request):
    """R2.4: flip the global wake kill-switch (the one-switch halt for a runaway).

    Unlike /orcha-pause (which pauses the whole container — agents, tasks, everything),
    this surgically stops only out-of-band wakes: the container stays active, humans and
    live agents keep working, but the daemon's claims are refused so no new headless
    workers spawn. Re-enable to resume turnkey waking.
    """
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (connection, cur):
        require_container(cur, cid)
        # Per-project identity: a trusted proxy login IS the actor (403 non-member).
        # Access model: the wake/autonomy switches are owner-or-manage_autonomy.
        enforce_grant(cur, request, cid, "manage_autonomy")
        body.actor_agent_id = trusted_actor(cur, request, cid, body.actor_agent_id)
        cur.execute(
            "UPDATE containers SET wakes_enabled=%s WHERE id=%s RETURNING wakes_enabled",
            (body.enabled, cid),
        )
        row = cur.fetchone()
        log_event(
            cur,
            cid,
            "system",
            body.actor_agent_id,
            "container",
            cid,
            "wakes_toggled",
            {"enabled": body.enabled},
        )
        connection.commit()
    return {"container_id": cid, "wakes_enabled": row["wakes_enabled"]}


@app.post("/api/containers/{cid}/autonomy", status_code=200)
def set_autonomy_level(cid: str, body: AutonomyUpdate, request: Request):
    """#298: move the autonomy SLIDER for a container — the single source of truth for how much a
    human stays in the loop.

      plan (Plan-only)   — every /done stops at needs_verification (a human verifies); the agent
                           refuses `gh pr create` until its plan is approved on the task thread.
      pr   (Build-to-PR) — every /done stops at needs_verification; the agent may `gh pr create`
                           but refuses `gh pr merge`.
      full (Full)        — a /done AUTO-COMPLETES the task (no human verify); the agent may
                           `gh pr merge` to the configured target branch.

    Only the completion gate is engine-enforced (here + mark_done); the gh/git rules are agent
    behaviors keyed off this value, recorded in docs/orcha-project-preferences.md.

    HUMAN-GATED (Orcha#30, stricter than /wakes): moving the slider can switch off the human
    verification gate entirely, so only a kind='human' actor may do it. Audit-logged.

    mig 043: optionally also flips the container-wide `autonomy_enforced` switch — when true, every
    per-agent autonomy_override (mig 043) is IGNORED and the container level governs everyone
    ("override for everyone"); false re-honors overrides. Omitting it leaves the switch unchanged.
    Rides the SAME owner-or-manage_autonomy gate as the level itself.
    """
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    if body.level not in AUTONOMY_LEVELS:
        raise HTTPException(400, f"level must be one of {AUTONOMY_LEVELS}")
    with db_cursor() as (connection, cur):
        require_container(cur, cid)
        # Per-project identity: a trusted proxy login IS the actor (403 non-member).
        # Access model: the wake/autonomy switches are owner-or-manage_autonomy.
        enforce_grant(cur, request, cid, "manage_autonomy")
        body.actor_agent_id = trusted_actor(cur, request, cid, body.actor_agent_id)
        require_kind(cur, body.actor_agent_id, ("human",))
        if body.autonomy_enforced is None:
            cur.execute(
                "UPDATE containers SET autonomy_level=%s WHERE id=%s "
                "RETURNING autonomy_level, autonomy_enforced",
                (body.level, cid),
            )
            detail = {"level": body.level}
        else:
            cur.execute(
                "UPDATE containers SET autonomy_level=%s, autonomy_enforced=%s WHERE id=%s "
                "RETURNING autonomy_level, autonomy_enforced",
                (body.level, body.autonomy_enforced, cid),
            )
            detail = {"level": body.level, "autonomy_enforced": body.autonomy_enforced}
        row = cur.fetchone()
        log_event(
            cur,
            cid,
            "human",
            body.actor_agent_id,
            "container",
            cid,
            "autonomy_changed",
            detail,
        )
        connection.commit()
    return {
        "container_id": cid,
        "autonomy_level": row["autonomy_level"],
        "autonomy_enforced": row["autonomy_enforced"],
    }
