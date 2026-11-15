"""Pause and resume one task (GH #343). People only; reading is open to members.

The decision logic lives in task_pause.py, shared with the workflow pause.
"""

from fastapi import HTTPException, Request

from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_kind, require_task, valid_uuid
from portal_backend.identity_routes import require_member_read, trusted_actor
from portal_backend.schemas.task_operations import (
    TaskPauseResult,
    TaskPauseState,
    TaskPauseUpdate,
)
from portal_backend.task_pause import pause_task, resume_task


def _state(cur, tid: str) -> dict:
    cur.execute(
        """SELECT t.paused_at, t.paused_by, t.paused_reason, t.paused_via_workflow,
                  a.alias AS paused_by_alias
             FROM tasks t LEFT JOIN agents a ON a.id = t.paused_by
            WHERE t.id=%s""",
        (tid,),
    )
    row = cur.fetchone() or {}
    paused = row.get("paused_at") is not None
    return {
        "task_id": tid,
        "paused": paused,
        "paused_at": row.get("paused_at") if paused else None,
        "paused_by": str(row["paused_by"]) if paused and row.get("paused_by") else None,
        "paused_by_alias": row.get("paused_by_alias") if paused else None,
        "reason": row.get("paused_reason") if paused else None,
        "via_workflow": bool(row.get("paused_via_workflow")) if paused else False,
    }


def _human_actor(cur, request: Request, task, claimed):
    # An agent's run token never pauses or resumes work: this is a person's control.
    if request.headers.get("x-orcha-run-token"):
        raise HTTPException(403, "only a person can pause or resume a task")
    actor = trusted_actor(cur, request, str(task["container_id"]), claimed)
    require_kind(cur, actor, ("human",))
    return str(actor)


@app.get(
    "/api/tasks/{tid}/pause",
    response_model=TaskPauseState,
)
def get_task_pause(tid: str, request: Request):
    """Whether a person has paused this task, who, when and why."""
    if not valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    with db_cursor(readonly=True) as (_, cur):
        task = require_task(cur, tid)
        require_member_read(cur, request, str(task["container_id"]))
        return _state(cur, tid)


@app.post(
    "/api/tasks/{tid}/pause",
    response_model=TaskPauseResult,
)
def pause_one_task(tid: str, body: TaskPauseUpdate, request: Request):
    """Pause a task: no agent wakes for it, claims it or continues it until resumed.

    The status is unchanged. A run working on it is asked to stop and save its work.
    People can still read and comment. Pausing a paused task changes nothing.
    """
    if not valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    with db_cursor() as (_, cur):
        task = require_task(cur, tid)
        actor = _human_actor(cur, request, task, body.actor_agent_id)
        if task["is_root"]:
            raise HTTPException(409, "the project root task cannot be paused; pause the project")
        if task["status"] in ("completed", "cancelled"):
            raise HTTPException(409, "a finished task cannot be paused")
        reason = (body.reason or "").strip() or None
        outcome = pause_task(cur, task, actor, reason)
        return {
            **_state(cur, tid),
            "changed": outcome["paused"] and not outcome["already_paused"],
            "stopped_runs": outcome["stopped_runs"],
        }


@app.post(
    "/api/tasks/{tid}/resume",
    response_model=TaskPauseResult,
)
def resume_one_task(tid: str, body: TaskPauseUpdate, request: Request):
    """Lift a pause and wake the assigned agent so it picks the task back up.

    Messages and answers that waited are delivered on that wake. Resuming a task that
    is not paused changes nothing.
    """
    if not valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    with db_cursor() as (_, cur):
        task = require_task(cur, tid)
        actor = _human_actor(cur, request, task, body.actor_agent_id)
        outcome = resume_task(cur, task, actor)
        return {
            **_state(cur, tid),
            "changed": outcome["resumed"],
            "woken_agent_ids": outcome["woken"],
        }
