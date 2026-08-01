"""Manage container wake and autonomy controls."""

from fastapi import HTTPException

from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container, require_kind, valid_uuid
from portal_backend.schemas.wakes import AutonomyUpdate, WakesToggle

AUTONOMY_LEVELS = ("plan", "pr", "full")


@app.post("/api/containers/{cid}/wakes", status_code=200)
def set_wakes_enabled(cid: str, body: WakesToggle):
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
def set_autonomy_level(cid: str, body: AutonomyUpdate):
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

    mig 034: optionally also flips the container-wide `autonomy_enforced` switch — when true, every
    per-agent autonomy_override (mig 034) is IGNORED and the container level governs everyone
    ("override for everyone"); false re-honors overrides. Omitting it leaves the switch unchanged.

    mig 034 (F1 — round-1 review): `level` is OPTIONAL — a PARTIAL update. Supplying only
    autonomy_enforced flips the lock WITHOUT touching the container level, so the Enforce chip can
    never re-assert a stale cached level (which could silently WIDEN the container — the exact
    backwards behaviour for a safety switch). At least one of level / autonomy_enforced must be
    supplied; each column is written only when its field is present.
    """
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    # F1: level is now optional (partial update). Validate it ONLY when supplied; require that at
    # least one mutating field is present so an empty body is a clear 400, not a silent no-op.
    if body.level is not None and body.level not in AUTONOMY_LEVELS:
        raise HTTPException(400, f"level must be one of {AUTONOMY_LEVELS}")
    if body.level is None and body.autonomy_enforced is None:
        raise HTTPException(400, "supply level and/or autonomy_enforced")
    with db_cursor() as (connection, cur):
        require_container(cur, cid)
        require_kind(cur, body.actor_agent_id, ("human",))
        # Build the SET clause from ONLY the supplied fields so an enforce-only flip never rewrites
        # the level (F1) and a level-only move never rewrites the switch.
        sets, params, detail = [], [], {}
        if body.level is not None:
            sets.append("autonomy_level=%s")
            params.append(body.level)
            detail["level"] = body.level
        if body.autonomy_enforced is not None:
            sets.append("autonomy_enforced=%s")
            params.append(body.autonomy_enforced)
            detail["autonomy_enforced"] = body.autonomy_enforced
        params.append(cid)
        cur.execute(
            f"UPDATE containers SET {', '.join(sets)} WHERE id=%s "
            "RETURNING autonomy_level, autonomy_enforced",
            params,
        )
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
