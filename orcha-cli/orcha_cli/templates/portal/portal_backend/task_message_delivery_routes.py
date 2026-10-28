"""Read task-message delivery guidance without consuming notifications."""

from fastapi import HTTPException, Request
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_task, valid_uuid
from portal_backend.identity_routes import require_member_read
from portal_backend.task_message_delivery import TaskMessageDelivery, task_message_delivery


@app.get("/api/tasks/{tid}/messages/delivery", response_model=TaskMessageDelivery)
def get_task_message_delivery(tid: str, request: Request):
    """Current delivery eligibility, not an acknowledgement or promise of a reply.

    Uses the task thread's project-membership authorization. Does not launch work,
    release holds, publish or acknowledge events, or alter workflow state.
    """
    if not valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    with db_cursor(readonly=True) as (_, cur):
        task = require_task(cur, tid)
        require_member_read(cur, request, str(task["container_id"]))
        return task_message_delivery(cur, task)
