"""Retire agents and edit their human-controlled profile fields."""

import psycopg
from fastapi import HTTPException

from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_agent, require_kind, valid_uuid
from portal_backend.schemas.agent_state import AgentRetire, AgentUpdate


@app.post("/api/agents/{aid}/retire", status_code=200)
def retire_agent(aid: str, body: AgentRetire):
    """ISS-51: retire an agent — human-authority gated. Sets agents.terminated_at +
    status='terminated' so the container roster (which now filters terminated_at IS
    NULL) stops listing it. Any task this agent was actively working is RELEASED back
    to status='ready' (its assignment dropped) so another agent can reclaim it; the
    task thread (task_messages) is retained. A task with OTHER active assignees stays
    in_progress — only this agent's assignment is dropped. Idempotent: re-retiring an
    already-retired agent returns 200 without re-releasing tasks."""
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        require_kind(cur, body.actor_agent_id, ("human",))
        agent = require_agent(cur, aid)
        cur.execute("SELECT terminated_at FROM agents WHERE id=%s", (aid,))
        if cur.fetchone()["terminated_at"] is not None:
            return {
                "agent_id": aid,
                "status": "terminated",
                "released_tasks": [],
                "already_retired": True,
            }

        cur.execute(
            """SELECT task_id FROM agent_tasks
               WHERE agent_id=%s AND assignment_status IN ('assigned','accepted','working')""",
            (aid,),
        )
        active_task_ids = [str(row["task_id"]) for row in cur.fetchall()]
        cur.execute(
            "DELETE FROM agent_tasks WHERE agent_id=%s "
            "AND assignment_status IN ('assigned','accepted','working')",
            (aid,),
        )
        cur.execute("DELETE FROM agent_self_wake WHERE agent_id=%s", (aid,))

        released = []
        for task_id in active_task_ids:
            cur.execute(
                """SELECT 1 FROM agent_tasks
                   WHERE task_id=%s AND assignment_status IN ('assigned','accepted','working')
                   LIMIT 1""",
                (task_id,),
            )
            if cur.fetchone() is None:
                cur.execute(
                    "UPDATE tasks SET status='ready', started_at=NULL "
                    "WHERE id=%s AND status='in_progress' AND is_root=false RETURNING id",
                    (task_id,),
                )
                if cur.fetchone():
                    released.append(task_id)

        cur.execute(
            "UPDATE agents SET terminated_at=now(), status='terminated' WHERE id=%s",
            (aid,),
        )
        log_event(
            cur,
            agent["container_id"],
            "human",
            body.actor_agent_id,
            "agent",
            aid,
            "agent_retired",
            {"released_tasks": released},
        )
        conn.commit()
    return {"agent_id": aid, "status": "terminated", "released_tasks": released}


@app.patch("/api/agents/{aid}", status_code=200)
def update_agent(aid: str, body: AgentUpdate):
    """Edit an agent's role / system_prompt / alias / autonomy_override (onboarding +
    re-profiles; no such route existed — personas were edited via raw DB). HUMAN-authority
    gated. PARTIAL: only the supplied fields change. Editing a HUMAN's system_prompt is
    rejected (humans carry no prompt). Renaming alias is 409-guarded on collision (UNIQUE per
    container); NOTE a rename orphans the local CLI binding file
    (.claude/orcha-tabs/<oldalias>.json), so the agent must re-bind (/orcha-use or re-register).

    mig 034: `autonomy_override` grants THIS agent a per-agent autonomy level without moving the
    whole container — human-authority gated exactly like role/system_prompt edits. Supply
    'plan'|'pr'|'full' to set it, or null to CLEAR it (inherit the container level); OMITTING the
    field leaves it unchanged (detected via model_fields_set, since null is a real target). Humans
    carry NO override (they never mark tasks done) — rejected for kind='human'. A bad enum value
    is a 422 (the AgentUpdate schema Literal refuses it before this body runs — an unvalidated
    string must never reach the hard completion gate). The change flows through the container
    read payload (role, prompt_preview, autonomy_override, effective_autonomy)."""
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    # mig 034: null is a MEANINGFUL value for autonomy_override (clear-to-inherit), so 'was it
    # supplied?' is model_fields_set membership, NOT `is not None`.
    override_supplied = "autonomy_override" in body.model_fields_set
    if (
        body.role is None
        and body.system_prompt is None
        and body.alias is None
        and not override_supplied
    ):
        raise HTTPException(
            400,
            "no updatable field supplied (role / system_prompt / alias / autonomy_override)",
        )
    with db_cursor() as (conn, cur):
        require_kind(cur, body.actor_agent_id, ("human",))
        cur.execute("SELECT kind, container_id FROM agents WHERE id=%s", (aid,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, f"agent {aid} not found")
        if body.system_prompt is not None:
            if row["kind"] == "human":
                raise HTTPException(400, "humans carry no system_prompt")
            if not body.system_prompt.strip():
                raise HTTPException(400, "kind='ai' requires a non-empty system_prompt")
        # mig 034: a human never marks a task done, so an override would be inert AND misleading —
        # reject it outright (mirrors the humans-carry-no-system_prompt guard). Clearing to null on
        # a human is a harmless no-op we still reject for a single consistent contract.
        if override_supplied and row["kind"] == "human":
            raise HTTPException(400, "humans carry no autonomy_override")

        # F4 (round-1 review): granting/clearing an override REMOVES a human from the completion
        # loop for one agent, yet the audit row logged only the field NAME ({"fields": [...]}) — no
        # value, no before/after — so "who granted this agent full autonomy, and when" was
        # unanswerable. Capture the prior override so the event can record before→after for the one
        # setting that decides when a human stops verifying.
        override_before = None
        if override_supplied:
            cur.execute("SELECT autonomy_override FROM agents WHERE id=%s", (aid,))
            override_before = cur.fetchone()["autonomy_override"]

        sets, params, changed = [], [], []
        if body.role is not None:
            sets.append("role=%s")
            params.append(body.role)
            changed.append("role")
        if body.system_prompt is not None:
            sets.append("system_prompt=%s")
            params.append(body.system_prompt)
            changed.append("system_prompt")
        if body.alias is not None:
            if not body.alias.strip():
                raise HTTPException(400, "alias cannot be blank")
            sets.append("alias=%s")
            params.append(body.alias)
            changed.append("alias")
        if override_supplied:
            sets.append("autonomy_override=%s")
            params.append(body.autonomy_override)
            changed.append("autonomy_override")
        params.append(aid)
        try:
            cur.execute(
                f"UPDATE agents SET {', '.join(sets)} WHERE id=%s "
                "RETURNING id, alias, role, kind, system_prompt, model, status, "
                "autonomy_override",
                params,
            )
        except psycopg.errors.UniqueViolation:
            raise HTTPException(
                409, f"alias '{body.alias}' already exists in this container"
            )
        updated = cur.fetchone()
        # F4: name the fields that changed AND, for autonomy_override specifically, record the
        # before→after value so the grant/clear of authority is fully auditable.
        detail = {"fields": changed}
        if override_supplied:
            detail["autonomy_override"] = body.autonomy_override
            detail["autonomy_override_before"] = override_before
        log_event(
            cur,
            row["container_id"],
            "human",
            body.actor_agent_id,
            "agent",
            aid,
            "agent_updated",
            detail,
        )
        conn.commit()
    result = {"agent_id": aid, **updated}
    if body.alias is not None:
        result["alias_rebind_note"] = (
            "alias changed — the local CLI binding "
            ".claude/orcha-tabs/<oldalias>.json is now stale; "
            "re-bind via /orcha-use or re-register"
        )
    return result
