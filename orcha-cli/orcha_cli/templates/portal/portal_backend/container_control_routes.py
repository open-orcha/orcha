"""Manage container wake and autonomy controls."""

from fastapi import HTTPException, Request

from portal_backend import sql
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
)

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
    """Refuse the retired project-wide autonomy write.

    Stored project and agent values remain compatibility history only. The human project owner
    changes current authority on the individual task endpoint.
    """
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    raise HTTPException(
        410,
        {
            "code": "task_autonomy_only",
            "message": "Project autonomy was retired. Change autonomy on the individual task.",
        },
    )


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
            (sql.json_param(icon) if icon is not None else None, cid),
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
        # The cap is human-gated because it guards against runaway agent creation;
        # an agent can never raise it for itself.
        require_kind(cur, actor, ("human",))
        cur.execute(
            "SELECT max_auto_agents FROM containers WHERE id=%s " + sql.for_update(), (cid,)
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
