"""Owner-only task autonomy controls and read history."""

from fastapi import HTTPException, Request

from portal_backend import sql
from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_task, valid_uuid
from portal_backend.identity_routes import require_member_read, require_owner
from portal_backend.schemas.task_operations import TaskAutonomyUpdate


@app.put("/api/tasks/{tid}/autonomy")
def update_task_autonomy(tid: str, body: TaskAutonomyUpdate, request: Request):
    if not valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    with db_cursor() as (_, cur):
        task = require_task(cur, tid)
        owner = require_owner(
            cur, request, str(task["container_id"]), body.actor_agent_id
        )
        if task["is_root"]:
            raise HTTPException(409, "the project root task always requires a person")
        if task["status"] in {"completed", "cancelled"}:
            raise HTTPException(409, "finished tasks keep their recorded autonomy history")
        if task.get("autonomy") == body.autonomy:
            return {
                "task_id": tid,
                "autonomy": task["autonomy"],
                "autonomy_revision": task["autonomy_revision"],
                "changed": False,
            }
        cur.execute(
            """UPDATE tasks SET autonomy=%s,autonomy_revision=autonomy_revision+1,
                      autonomy_changed_at=%s,autonomy_changed_by=%s
                 WHERE id=%s
                 RETURNING autonomy,autonomy_revision,autonomy_changed_at""",
            (body.autonomy, sql.utcnow(), owner["id"], tid),
        )
        changed = cur.fetchone()
        log_event(
            cur,
            task["container_id"],
            "human",
            owner["id"],
            "task",
            tid,
            "task_autonomy_changed",
            {
                "from": task.get("autonomy") or "off",
                "to": changed["autonomy"],
                "autonomy_revision": changed["autonomy_revision"],
                "applies_to": "future_actions_only",
            },
        )
        return {
            "task_id": tid,
            "autonomy": changed["autonomy"],
            "autonomy_revision": changed["autonomy_revision"],
            "changed_at": changed["autonomy_changed_at"],
            "changed": True,
        }


@app.get("/api/tasks/{tid}/approvals")
def task_approvals(tid: str, request: Request):
    if not valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    with db_cursor(readonly=True) as (_, cur):
        task = require_task(cur, tid)
        require_member_read(cur, request, str(task["container_id"]))
        cur.execute(
            """SELECT id,phase,work_revision,requirements_sha256,submission_sha256,
                      actor_id,actor_kind,autonomy_at_approval,autonomy_revision,
                      permission_source,approved_at
                 FROM task_approval_records WHERE task_id=%s
                 ORDER BY approved_at,id""",
            (tid,),
        )
        return {"task_id": tid, "approvals": cur.fetchall()}
