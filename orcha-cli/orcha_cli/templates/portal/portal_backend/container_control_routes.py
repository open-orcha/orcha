"""Manage container wake and autonomy controls."""

from fastapi import HTTPException, Request
from psycopg.types.json import Jsonb

from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container, require_kind, valid_uuid
from portal_backend.identity_routes import (
    enforce_grant,
    require_member_read,
    trusted_actor,
)
from portal_backend.project_icons import validate_project_icon
from portal_backend.schemas.containers import (
    ContainerIconResponse,
    ContainerIconUpdate,
    ContainerLimitsResponse,
    ContainerLimitsUpdate,
    ContainerObjectiveResponse,
    ContainerObjectiveUpdate,
)
from portal_backend.schemas.wakes import (
    AutonomyUpdate,
    WakesToggle,
    WorktreeRoutingUpdate,
)

AUTONOMY_LEVELS = ("plan", "pr", "full")


@app.post("/api/containers/{cid}/worktrees", status_code=200)
def set_worktrees_disabled(cid: str, body: WorktreeRoutingUpdate, request: Request):
    """Choose whether every future agent run uses the shared main checkout.

    The persisted flag is intentionally routing-only: changing it never deletes or migrates an
    existing worktree.  The notifier applies it at the final cwd decision for work wakes,
    conversation turns, and live terminals.  As with other execution controls, only a human with
    the owner role or ``manage_autonomy`` permission may change it.
    """
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (connection, cur):
        require_container(cur, cid)
        enforce_grant(cur, request, cid, "manage_autonomy")
        body.actor_agent_id = trusted_actor(cur, request, cid, body.actor_agent_id)
        require_kind(cur, body.actor_agent_id, ("human",))
        cur.execute(
            "UPDATE containers SET worktrees_disabled=%s WHERE id=%s "
            "RETURNING worktrees_disabled",
            (body.disabled, cid),
        )
        row = cur.fetchone()
        log_event(
            cur,
            cid,
            "human",
            body.actor_agent_id,
            "container",
            cid,
            "worktree_routing_changed",
            {"worktrees_disabled": body.disabled},
        )
        connection.commit()
    return {
        "container_id": cid,
        "worktrees_disabled": bool(row["worktrees_disabled"]),
    }


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


@app.put(
    "/api/containers/{cid}/icon",
    status_code=200,
    response_model=ContainerIconResponse,
)
def set_container_icon(cid: str, body: ContainerIconUpdate, request: Request):
    """D14: set (or with ``icon: null`` clear) the project's icon.

    Cosmetic and per PROJECT (everyone on the project sees the same icon, in the portal
    and the desktop app); nothing server-side reads it. Validated strictly
    (portal_backend/project_icons.py). Authorised like the other project-setting writes:
    under the trusted lane only an owner or a ``manage_autonomy`` holder may change it
    (viewers and non-members are refused); trust off stays open, as on self-host.
    Audit-logged to the container event log.
    """
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    icon = validate_project_icon(body.icon)
    with db_cursor() as (connection, cur):
        require_container(cur, cid)
        enforce_grant(cur, request, cid, "manage_autonomy")
        actor = trusted_actor(cur, request, cid, body.actor_agent_id)
        if actor is not None and not valid_uuid(str(actor)):
            raise HTTPException(400, "actor_agent_id is not a valid UUID")
        cur.execute(
            "UPDATE containers SET icon=%s WHERE id=%s RETURNING icon",
            (Jsonb(icon) if icon is not None else None, cid),
        )
        row = cur.fetchone()
        log_event(
            cur,
            cid,
            "human" if actor else "system",
            actor,
            "container",
            cid,
            "project_icon_changed",
            {"icon": icon},
        )
        connection.commit()
    return {"container_id": cid, "icon": row["icon"]}


@app.put(
    "/api/containers/{cid}/objective",
    status_code=200,
    response_model=ContainerObjectiveResponse,
)
def set_container_objective(cid: str, body: ContainerObjectiveUpdate, request: Request):
    """Set (or with ``objective: null`` / blank, clear) the project's stated objective.

    The objective is ``containers.description`` — the Overview summary line and the
    objective node of every task's goal chain (goal_ancestry.objective_node) read it — and
    is mirrored onto the root task's description, exactly as applying a template with an
    objective does. Clearing resets the root description to the project name (the init
    default, which the goal chain treats as "no objective"). Authorised like the other
    project-setting writes: under the trusted lane only an owner or a ``manage_autonomy``
    holder may change it (plain members, viewers and non-members are refused); trust off
    stays open, as on self-host. Audit-logged (``project_objective_changed``).
    """
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    text = (body.objective or "").strip() or None
    with db_cursor() as (connection, cur):
        require_container(cur, cid)
        enforce_grant(cur, request, cid, "manage_autonomy")
        actor = trusted_actor(cur, request, cid, body.actor_agent_id)
        if actor is not None and not valid_uuid(str(actor)):
            raise HTTPException(400, "actor_agent_id is not a valid UUID")
        cur.execute("SELECT description FROM containers WHERE id=%s", (cid,))
        before = cur.fetchone()["description"]
        cur.execute(
            "UPDATE containers SET description=%s WHERE id=%s "
            "RETURNING description, name, root_task_id",
            (text, cid),
        )
        row = cur.fetchone()
        if row["root_task_id"]:
            cur.execute(
                "UPDATE tasks SET description=%s WHERE id=%s AND is_root",
                (text if text is not None else row["name"], row["root_task_id"]),
            )
        if (before or None) != text:
            log_event(
                cur,
                cid,
                "human" if actor else "system",
                actor,
                "container",
                cid,
                "project_objective_changed",
                {"from": before, "to": text},
            )
        connection.commit()
    return {"container_id": cid, "objective": row["description"]}


# ---- Agent limit (mig 056) ---------------------------------------------------------------
# containers.max_auto_agents caps the live AI agents created FROM suggestions — the same
# count agent_suggestion_routes.decide_suggestion enforces on kind='create'.
AUTO_AGENTS_IN_USE_SQL = """SELECT COUNT(*) AS n FROM agents
                            WHERE container_id=%s AND terminated_at IS NULL
                              AND kind='ai' AND is_auto_created"""


def _limits_payload(cur, cid: str, max_auto_agents: int) -> dict:
    cur.execute(AUTO_AGENTS_IN_USE_SQL, (cid,))
    return {
        "container_id": cid,
        "max_auto_agents": int(max_auto_agents),
        "auto_agents_in_use": int(cur.fetchone()["n"]),
    }


@app.get(
    "/api/containers/{cid}/limits",
    status_code=200,
    response_model=ContainerLimitsResponse,
)
def get_container_limits(cid: str, request: Request):
    """Read the project's agent limit and how much of it is in use.

    Any member may read it (viewers included); trusted non-members are refused."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        require_member_read(cur, request, cid)
        cur.execute("SELECT max_auto_agents FROM containers WHERE id=%s", (cid,))
        return _limits_payload(cur, cid, cur.fetchone()["max_auto_agents"])


@app.put(
    "/api/containers/{cid}/limits",
    status_code=200,
    response_model=ContainerLimitsResponse,
)
def set_container_limits(cid: str, body: ContainerLimitsUpdate, request: Request):
    """Change how many suggested agents the project may create (1-50). Human-only.

    Raising it is what unblocks "Create agent" on a suggestion at the cap, so it rides
    the SAME owner-or-``manage_agents`` gate as creating that agent (viewers and
    non-members are refused; trust off stays open, as on self-host). Lowering it below
    the number in use is allowed — it retires nobody, it only blocks new creates.
    Audit-logged to the container event log with the before/after values."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (connection, cur):
        require_container(cur, cid)
        enforce_grant(cur, request, cid, "manage_agents")
        actor = trusted_actor(cur, request, cid, body.actor_agent_id)
        # human-gated like the autonomy slider: the cap guards against runaway agent
        # creation, so an agent can never raise it for itself
        require_kind(cur, actor, ("human",))
        cur.execute(
            "SELECT max_auto_agents FROM containers WHERE id=%s FOR UPDATE", (cid,)
        )
        before = int(cur.fetchone()["max_auto_agents"])
        cur.execute(
            "UPDATE containers SET max_auto_agents=%s WHERE id=%s RETURNING max_auto_agents",
            (body.max_auto_agents, cid),
        )
        after = int(cur.fetchone()["max_auto_agents"])
        log_event(
            cur,
            cid,
            "human",
            actor,
            "container",
            cid,
            "agent_limit_changed",
            {"max_auto_agents": after, "previous": before},
        )
        out = _limits_payload(cur, cid, after)
        connection.commit()
    return out
