"""Goal ancestry API: read a task's goal chain; set or clear its explicit parent task.

GET  /api/tasks/{tid}/goal-chain  -> {task_id, goal_chain: [objective, parent..., task],
                                      truncated, cycle}
PUT  /api/tasks/{tid}/parent      <- {parent_task_id: uuid | null, actor_agent_id?}

See portal_backend/goal_ancestry.py for the (truthful-only) derivation rules.
"""

from __future__ import annotations

from typing import Optional

from fastapi import HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from portal_backend import sql
from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.events import publish_event
from portal_backend.goal_ancestry import goal_chain, has_parent_column, would_cycle
from portal_backend.guards import agent_participates_in_task, require_task, valid_uuid
from portal_backend.identity_routes import require_member_read, trusted_actor


class GoalChainNode(BaseModel):
    """One breadcrumb hop. ``kind`` is objective | parent | task."""

    model_config = ConfigDict(extra="allow")

    kind: str = Field(description="objective | parent | task")
    id: Optional[str] = Field(
        None, description="task id (objective: the root task id, may be null)"
    )
    title: str = Field(description="task title, or the project name for the objective")
    text: Optional[str] = Field(
        None, description="objective only: the stated objective; null when none is set"
    )
    source: Optional[str] = Field(
        None, description="objective only: project_description | root_task | null"
    )
    container_id: Optional[str] = None
    status: Optional[str] = Field(None, description="parent/task: the task status")
    via: Optional[str] = Field(
        None, description="parent only: parent_link (explicit) | task_request (derived)"
    )
    request_id: Optional[str] = Field(
        None, description="parent via task_request: the request that spawned the child"
    )


class GoalChainResponse(BaseModel):
    task_id: str
    goal_chain: list[GoalChainNode]
    truncated: bool = Field(description="the walk stopped at the depth cap")
    cycle: bool = Field(description="the walk stopped because a parent repeated")


class TaskParentUpdate(BaseModel):
    """Set (uuid) or clear (null) a task's explicit parent task."""

    model_config = ConfigDict(extra="forbid")

    parent_task_id: Optional[str] = Field(
        None, description="the parent task id; null clears the explicit parent"
    )
    actor_agent_id: Optional[str] = Field(
        None,
        description="acting agent (self-host / agent lane); a trusted proxy login overrides it",
    )


class TaskParentResponse(GoalChainResponse):
    parent_task_id: Optional[str]


@app.get("/api/tasks/{tid}/goal-chain", response_model=GoalChainResponse)
def get_task_goal_chain(tid: str, request: Request):
    """The task's goal chain — project objective -> parent task(s) -> this task. Read-only;
    any project member (viewer included) may read it."""
    if not valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    with db_cursor() as (_, cur):
        t = require_task(cur, tid)
        require_member_read(cur, request, str(t["container_id"]))
        return goal_chain(cur, tid)


@app.put("/api/tasks/{tid}/parent", response_model=TaskParentResponse)
def set_task_parent(tid: str, body: TaskParentUpdate, request: Request):
    """Link a task under a parent task (or clear the link).

    Who: a non-viewer member (trusted proxy identity is the actor), or — on the agent lane —
    a live agent of the project that created or is assigned to the task (the same
    participant rule mig 028 uses for originating_task_id). Validation: same project, the
    parent is not the root task (the root IS the objective — clear the parent instead), not
    the task itself, and the link must not close a cycle. Audited (task/parent_set|cleared)."""
    if not valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    if body.parent_task_id is not None and not valid_uuid(body.parent_task_id):
        raise HTTPException(400, "parent_task_id is not a valid UUID")
    with db_cursor() as (_, cur):
        if not has_parent_column(cur):
            raise HTTPException(503, "goal ancestry migration not applied yet")
        t = require_task(cur, tid)
        cid = str(t["container_id"])
        if t["is_root"]:
            raise HTTPException(400, "the root task is the project objective; it has no parent")
        actor_id = trusted_actor(cur, request, cid, body.actor_agent_id)
        if not actor_id or not valid_uuid(str(actor_id)):
            raise HTTPException(400, "actor_agent_id is required")
        cur.execute(
            """SELECT id, alias, kind, member_role, terminated_at FROM agents
                WHERE id = %s AND container_id = %s""",
            (actor_id, cid),
        )
        actor = cur.fetchone()
        if actor is None or actor["terminated_at"] is not None:
            raise HTTPException(403, "actor is not a live member of this project")
        if actor["kind"] == "human":
            if actor["member_role"] == "viewer":
                raise HTTPException(403, "read-only: viewers cannot change a task's parent")
        elif not agent_participates_in_task(cur, cid, str(actor_id), tid):
            raise HTTPException(
                403, "an agent may only set the parent of a task it created or is assigned to"
            )

        cur.execute("SELECT parent_task_id FROM tasks WHERE id = %s " + sql.for_update(), (tid,))
        before = cur.fetchone()["parent_task_id"]
        before = str(before) if before else None
        new_parent = body.parent_task_id
        if new_parent is not None:
            p = require_task(cur, new_parent)
            if str(p["container_id"]) != cid:
                raise HTTPException(400, "parent task is not in this project")
            if p["is_root"]:
                raise HTTPException(
                    400,
                    "the root task is the project objective — clear the parent instead",
                )
            if would_cycle(cur, tid, new_parent):
                raise HTTPException(
                    409, "that parent would create a cycle (it descends from this task)"
                )
        if before != new_parent:
            cur.execute(
                "UPDATE tasks SET parent_task_id = %s WHERE id = %s", (new_parent, tid)
            )
            actor_type = "human" if actor["kind"] == "human" else "agent"
            log_event(
                cur,
                cid,
                actor_type,
                str(actor_id),
                "task",
                tid,
                "parent_set" if new_parent else "parent_cleared",
                {"before": before, "after": new_parent, "actor_alias": actor["alias"]},
            )
            publish_event(
                cur,
                cid,
                None,
                "task_parent_changed",
                {"task_id": tid, "parent_task_id": new_parent, "before": before},
            )
        chain = goal_chain(cur, tid)
        return {**chain, "parent_task_id": new_parent}
