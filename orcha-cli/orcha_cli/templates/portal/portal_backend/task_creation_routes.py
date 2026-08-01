"""Create container tasks with dependencies, protocols, and direct assignments."""

import json

from fastapi import HTTPException, Request

from portal_backend.agent_status import log_event, recompute_agent_status
from portal_backend.application import app
from portal_backend.auth_provider import authorize, resolve_actor
from portal_backend.database import db_cursor
from portal_backend.events import publish_event as _publish_event
from portal_backend.guards import (
    reject_if_retired as _reject_if_retired,
    require_container_active as _require_container_active,
    resolve_alias as _resolve_alias,
    valid_uuid as _valid_uuid,
)
from portal_backend.schemas import TaskCreateBody


@app.post("/api/containers/{cid}/tasks", status_code=201)
def create_task(cid: str, body: TaskCreateBody, request: Request):
    if not _valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        # SEAM A (#211): pluggable caller resolution + authorization. Defaults are
        # no-ops (resolve → the body-supplied id; authorize → permit), so this is a
        # zero-behavior-change insertion; a downstream provider overrides both.
        resolved_actor = resolve_actor(cur, request, cid, body.created_by_agent_id)
        authorize(cur, request, resolved_actor, "create_task", cid)
        _require_container_active(
            cur, cid, body.created_by_agent_id
        )  # GH #24 (was _require_container)
        _reject_if_retired(cur, body.created_by_agent_id)  # ISS-51 [P1]

        for dep in body.depends_on:
            if not _valid_uuid(dep):
                raise HTTPException(400, f"depends_on contains invalid UUID: {dep}")

        assignee_id = None
        if body.assignee_alias:
            assignee_id = _resolve_alias(cur, cid, body.assignee_alias)

        initial_status = (
            "pending"
            if body.depends_on
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

        for dep in body.depends_on:
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
        conn.commit()

    return {
        "task_id": tid,
        "status": initial_status,
        "assignee_alias": body.assignee_alias,
        "depends_on": body.depends_on,
    }
