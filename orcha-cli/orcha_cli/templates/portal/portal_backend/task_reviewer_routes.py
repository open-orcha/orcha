"""Assign (or clear) the human reviewer an owner wants verifying a task."""

from fastapi import HTTPException, Request

from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_task, valid_uuid
from portal_backend.identity_routes import require_grant
from portal_backend.schemas.task_operations import TaskReviewerUpdate


@app.put("/api/tasks/{tid}/reviewer", status_code=200)
def set_task_reviewer(tid: str, body: TaskReviewerUpdate, request: Request):
    """Owner-or-assign_reviewers: name the human who should verify this task
    (null = anyone).

    ADVISORY, deliberately: /verify keeps its existing permissive state machine (any
    human CAN verify) — the portal only de-emphasizes review items that belong to
    someone else. The target must be a live kind='human' member of the task's own
    container; anything else is a 400."""
    if not valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        t = require_task(cur, tid)
        cid = str(t["container_id"])
        owner = require_grant(
            cur, request, cid, body.actor_agent_id, "assign_reviewers"
        )

        reviewer = None
        if body.reviewer_agent_id is not None:
            if not valid_uuid(body.reviewer_agent_id):
                raise HTTPException(400, "reviewer_agent_id is not a valid UUID")
            cur.execute(
                """SELECT id, alias, github_login, kind, container_id, terminated_at
                   FROM agents WHERE id=%s""",
                (body.reviewer_agent_id,),
            )
            reviewer = cur.fetchone()
            if reviewer is None:
                raise HTTPException(400, "reviewer agent not found")
            if str(reviewer["container_id"]) != cid:
                raise HTTPException(400, "reviewer is not in the task's container")
            if reviewer["kind"] != "human":
                raise HTTPException(
                    400,
                    f"reviewer must be a human member; agent is kind='{reviewer['kind']}'",
                )
            if reviewer["terminated_at"] is not None:
                raise HTTPException(400, "reviewer has been removed from the project")

        cur.execute(
            "UPDATE tasks SET reviewer_agent_id=%s WHERE id=%s",
            (body.reviewer_agent_id, tid),
        )
        log_event(
            cur,
            cid,
            "human",
            str(owner["id"]),
            "task",
            tid,
            "reviewer_assigned" if reviewer is not None else "reviewer_cleared",
            {
                "reviewer_agent_id": body.reviewer_agent_id,
                "reviewer_alias": reviewer["alias"] if reviewer else None,
            },
        )
        conn.commit()
    return {
        "task_id": tid,
        "reviewer": (
            {
                "agent_id": str(reviewer["id"]),
                "alias": reviewer["alias"],
                "github_login": reviewer["github_login"],
            }
            if reviewer
            else None
        ),
    }
