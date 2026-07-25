"""Schedule and cancel task-bound one-shot agent wakes."""

from datetime import datetime, timezone
from typing import Optional

from fastapi import Header, HTTPException, Query

from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_agent, valid_uuid
from portal_backend.schemas.agent_state import SelfWakeSet
from portal_backend.worker_auth import require_work_lane


@app.post("/api/agents/{aid}/self-wake", status_code=200)
def schedule_agent_self_wake(
    aid: str,
    body: SelfWakeSet,
    x_orcha_run_token: Optional[str] = Header(default=None, alias="X-Orcha-Run-Token"),
):
    """GH #122: work-lane task worker schedules a one-shot wake for the task it is working."""
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    if not valid_uuid(body.task_id):
        raise HTTPException(400, "task_id is not a valid UUID")
    context = (body.context or "").strip()
    if not context:
        raise HTTPException(422, "context must be non-empty")

    now = datetime.now(timezone.utc)
    delay = body.delay_secs if body.delay_secs is not None else body.resume_in_seconds
    if delay is not None:
        resume_dt = datetime.fromtimestamp(now.timestamp() + float(delay), timezone.utc)
    elif body.resume_at is not None:
        resume_dt = body.resume_at
        if resume_dt.tzinfo is None:
            resume_dt = resume_dt.replace(tzinfo=timezone.utc)
        else:
            resume_dt = resume_dt.astimezone(timezone.utc)
        delta = (resume_dt - now).total_seconds()
        if delta < 60:
            raise HTTPException(
                422, "resume_at must be at least 60 seconds in the future"
            )
        if delta > 86_400:
            raise HTTPException(422, "resume_at must be within 24 hours")
    else:
        raise HTTPException(422, "provide delay_secs, resume_in_seconds, or resume_at")

    with db_cursor() as (conn, cur):
        agent = require_agent(cur, aid)
        require_work_lane(cur, aid, x_orcha_run_token)
        cur.execute(
            """SELECT 1 FROM tasks t
               JOIN agent_tasks at ON at.task_id = t.id AND at.agent_id = %s
               WHERE t.id = %s AND t.container_id = %s
                 AND t.status = 'in_progress'
                 AND t.is_root = false
                 AND at.assignment_status IN ('assigned','accepted','working')
               LIMIT 1""",
            (aid, body.task_id, agent["container_id"]),
        )
        if not cur.fetchone():
            raise HTTPException(
                409,
                "self-wake can only be scheduled by an active assignee on an in-progress task",
            )
        cur.execute(
            "SELECT id FROM agent_self_wake WHERE agent_id=%s AND task_id=%s",
            (aid, body.task_id),
        )
        replaced_existing = cur.fetchone() is not None
        cur.execute(
            """INSERT INTO agent_self_wake (agent_id, task_id, resume_at, context)
               VALUES (%s, %s, %s, %s)
               ON CONFLICT (agent_id, task_id) DO UPDATE SET
                 resume_at = EXCLUDED.resume_at,
                 context = EXCLUDED.context,
                 created_at = now()
               RETURNING id, resume_at""",
            (aid, body.task_id, resume_dt, context),
        )
        row = cur.fetchone()
        log_event(
            cur,
            agent["container_id"],
            "ai",
            aid,
            "task",
            body.task_id,
            "self_wake_scheduled",
            {
                "resume_at": row["resume_at"].isoformat(),
                "replaced_existing": replaced_existing,
            },
        )
        conn.commit()
    return {
        "self_wake_id": str(row["id"]),
        "agent_id": aid,
        "task_id": body.task_id,
        "resume_at": row["resume_at"].isoformat(),
        "status": "scheduled",
        "replaced_existing": replaced_existing,
    }


@app.delete("/api/agents/{aid}/self-wake", status_code=200)
def cancel_agent_self_wake(
    aid: str,
    task_id: Optional[str] = Query(default=None),
    all_tasks: bool = Query(default=False, alias="all"),
    x_orcha_run_token: Optional[str] = Header(default=None, alias="X-Orcha-Run-Token"),
):
    """GH #122: cancel this agent's scheduled self-wake for one task, or all of them."""
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    if not all_tasks and not (task_id and valid_uuid(task_id)):
        raise HTTPException(400, "task_id is required unless all=true")
    with db_cursor() as (conn, cur):
        agent = require_agent(cur, aid)
        require_work_lane(cur, aid, x_orcha_run_token)
        if all_tasks:
            cur.execute("DELETE FROM agent_self_wake WHERE agent_id=%s", (aid,))
        else:
            cur.execute(
                "DELETE FROM agent_self_wake WHERE agent_id=%s AND task_id=%s",
                (aid, task_id),
            )
        deleted = cur.rowcount
        log_event(
            cur,
            agent["container_id"],
            "ai",
            aid,
            "agent",
            aid,
            "self_wake_cancelled",
            {"task_id": task_id, "all": all_tasks, "deleted": deleted},
        )
        conn.commit()
    return {"agent_id": aid, "task_id": task_id, "deleted": deleted}
