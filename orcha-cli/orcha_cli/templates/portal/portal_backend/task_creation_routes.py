"""Create container tasks with dependencies, protocols, and direct assignments."""

import json

from fastapi import HTTPException, Request

from portal_backend.agent_status import log_event, recompute_agent_status
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.events import publish_event as _publish_event
from portal_backend.guards import (
    reject_if_retired as _reject_if_retired,
    require_container_active as _require_container_active,
    resolve_alias as _resolve_alias,
    valid_uuid as _valid_uuid,
)
from portal_backend.identity_routes import trusted_actor as _trusted_actor
from portal_backend.schemas import TaskCreateBody
from portal_backend.task_completion_support import DEP_SATISFIED_STATUSES


@app.post("/api/containers/{cid}/tasks", status_code=201)
def create_task(cid: str, body: TaskCreateBody, request: Request):
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        # Per-project identity: a trusted proxy login IS the creator (403 non-member) —
        # a browser-lane create is always attributed to the verified member, never to a
        # client-chosen (or defaulted) human.
        body.created_by_agent_id = _trusted_actor(
            cur, request, cid, body.created_by_agent_id
        )
        _require_container_active(
            cur, cid, body.created_by_agent_id
        )  # GH #24 (was _require_container)
        _reject_if_retired(cur, body.created_by_agent_id)  # ISS-51 [P1]

        for dep in body.depends_on:
            if not _valid_uuid(dep):
                raise HTTPException(400, f"depends_on contains invalid UUID: {dep}")
        # TG-46: dependencies are project-scoped — every dep must be a real, non-root task
        # of THIS project (a cross-project edge would couple two projects' queues, and the
        # root is the human's container sentinel, never a work prerequisite).
        deps_unmet = False
        if body.depends_on:
            cur.execute(
                "SELECT id, container_id, is_root, status FROM tasks WHERE id = ANY(%s::uuid[])",
                (list(body.depends_on),),
            )
            found = {str(r["id"]): r for r in cur.fetchall()}
            for dep in body.depends_on:
                row = found.get(str(dep))
                if row is None or str(row["container_id"]) != cid:
                    raise HTTPException(
                        400, f"depends_on task {dep} is not a task in this project"
                    )
                if row["is_root"]:
                    raise HTTPException(
                        400, "the root task cannot be a dependency"
                    )
            # TG-45: 'pending' only while some dependency is still unsatisfied; a task
            # whose deps are all completed (or cancelled) is ready on arrival — nothing
            # would ever promote it later.
            deps_unmet = any(
                found[str(d)]["status"] not in DEP_SATISFIED_STATUSES
                for d in body.depends_on
            )

        assignee_id = None
        if body.assignee_alias:
            assignee_id = _resolve_alias(cur, cid, body.assignee_alias)

        initial_status = (
            "pending"
            if deps_unmet
            else ("in_progress" if assignee_id else "ready")
        )
        # #326 (B3): a HELD task is created 'not_ready' regardless of deps — it leaves the
        # ready-queue and is not self-claimable until a human releases it (POST .../readiness).
        # An explicitly assigned task is never held (you're handing it to an agent to start now).
        if body.not_ready and not assignee_id:
            initial_status = "not_ready"

        started_clause = "now()" if initial_status == "in_progress" else "NULL"

        # SPEC-4: optional create-time protocol. Only the keys actually sent are stored
        # (exclude_unset), so an empty/omitted protocol persists as NULL, not '{}'.
        protocol_json = None
        if body.protocol is not None:
            fields = body.protocol.model_dump(exclude_unset=True)
            if fields:
                protocol_json = json.dumps(fields)

        cur.execute(
            f"""INSERT INTO tasks
                  (container_id, title, description, definition_of_done,
                   status, priority, created_by_agent_id, protocol, started_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb, {started_clause})
                RETURNING id""",
            (
                cid,
                body.title,
                body.description,
                body.definition_of_done,
                initial_status,
                body.priority,
                body.created_by_agent_id,
                protocol_json,
            ),
        )
        tid = str(cur.fetchone()["id"])

        for dep in dict.fromkeys(body.depends_on):
            cur.execute(
                "INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (%s, %s)",
                (tid, dep),
            )

        if assignee_id:
            cur.execute(
                """INSERT INTO agent_tasks (agent_id, task_id, assignment_status)
                   VALUES (%s, %s, 'working')""",
                (assignee_id, tid),
            )
            # ISS-86 / #245 (GAP A): do NOT bump_agent(assignee) here. Being assigned a task
            # is not the assignee taking a turn — and bump_agent resets last_heartbeat_at=now(),
            # which shrinks idle_seconds so wake-scan reads the cold assignee as active and
            # SUPPRESSES the task_assigned wake for ~min_idle. recompute_agent_status still flips
            # them to 'working' off the agent_tasks row. Mirrors the /assign path (main.py ~3302),
            # which already omits the bump for exactly this reason.
            recompute_agent_status(cur, assignee_id)
            _publish_event(
                cur,
                cid,
                assignee_id,
                "task_assigned",
                {"task_id": tid, "title": body.title, "via": "direct assignment"},
            )

        actor_type = "ai" if body.created_by_agent_id else "human"
        log_event(
            cur,
            cid,
            actor_type,
            body.created_by_agent_id,
            "task",
            tid,
            "created",
            {
                "title": body.title,
                "status": initial_status,
                "assignee_alias": body.assignee_alias,
                "depends_on": body.depends_on,
            },
        )
        if not assignee_id:
            # Parity r2: an UNASSIGNED task published nothing, so open portals only saw it
            # on their next 3 s poll. A container-only event (no agent target → no wake)
            # pushes it over the /events SSE like every assigned task already is.
            _publish_event(
                cur,
                cid,
                None,
                "task_created",
                {"task_id": tid, "title": body.title},
            )
        conn.commit()

    return {
        "task_id": tid,
        "status": initial_status,
        "assignee_alias": body.assignee_alias,
        "depends_on": body.depends_on,
    }
