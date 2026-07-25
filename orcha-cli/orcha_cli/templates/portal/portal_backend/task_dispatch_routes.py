"""Release held tasks and reset active assignments."""

from fastapi import HTTPException

from portal_backend.agent_status import log_event, recompute_agent_status
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.event_acknowledgement import _ack_events_handled
from portal_backend.events import publish_event as _publish_event
from portal_backend.guards import (
    require_kind as _require_kind,
    require_task as _require_task,
    valid_uuid as _valid_uuid,
)
from portal_backend.schemas.task_operations import TaskReadiness, TaskUnassign


def _deps_unmet(cur, tid: str) -> bool:
    """#326: true if the task has a dependency that is not yet 'completed' (mirror the
    verify-unblock / assign dependency check — a task with unmet deps is 'pending', not 'ready')."""
    cur.execute(
        """SELECT 1 FROM task_dependencies td
           JOIN tasks dep ON dep.id = td.depends_on_id
           WHERE td.task_id=%s AND dep.status <> 'completed' LIMIT 1""",
        (tid,),
    )
    return cur.fetchone() is not None


@app.post("/api/tasks/{tid}/readiness", status_code=200)
def set_task_readiness(tid: str, body: TaskReadiness):
    """#326 (B3): flip a task between 'not_ready' (HELD — design-gated, excluded from the
    ready-queue + not self-claimable via /orcha-next) and dispatchable.

    HUMAN-AUTHORITY gated (Orcha#30 / #327: an AI cannot yet flip readiness). Allowed transitions:
      ready=false  HOLD:    'ready' or 'pending' -> 'not_ready'  (idempotent if already not_ready)
      ready=true   RELEASE: 'not_ready' -> 'ready' (or 'pending' if its deps aren't satisfied)
    Refused (409) for the root task and for in_progress / terminal states (completed,
    needs_verification, cancelled) — you don't hold work someone is building, nor resurrect a
    finished/cancelled task. started_at clears on a hold so a later release claims it cleanly."""
    if not _valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        _require_kind(
            cur, body.actor_agent_id, ("human",)
        )  # Orcha#30 / #327: human-only flip
        t = _require_task(cur, tid)
        cid = str(t["container_id"])
        if t["is_root"]:
            raise HTTPException(409, "the root task has no readiness to flip")
        cur_status = t["status"]
        if body.ready:
            # RELEASE -> dispatchable. Idempotent if already ready/pending.
            if cur_status in ("ready", "pending"):
                conn.commit()
                return {"task_id": tid, "status": cur_status, "already": True}
            if cur_status != "not_ready":
                raise HTTPException(
                    409, f"task is '{cur_status}', not 'not_ready' — nothing to release"
                )
            new_status = "pending" if _deps_unmet(cur, tid) else "ready"
        else:
            # HOLD -> not_ready. Idempotent if already held.
            if cur_status == "not_ready":
                conn.commit()
                return {"task_id": tid, "status": "not_ready", "already": True}
            if cur_status not in ("ready", "pending"):
                raise HTTPException(
                    409,
                    f"task is '{cur_status}' — only a ready/pending task can be held as not_ready",
                )
            new_status = "not_ready"
        cur.execute(
            "UPDATE tasks SET status=%s, started_at=NULL WHERE id=%s", (new_status, tid)
        )
        log_event(
            cur,
            cid,
            "human",
            body.actor_agent_id,
            "task",
            tid,
            "readiness_set",
            {"from": cur_status, "to": new_status},
        )
        # Releasing an ASSIGNED held task makes it an auto-start target -> wake the assignee.
        if new_status == "ready":
            cur.execute(
                """SELECT agent_id FROM agent_tasks
                   WHERE task_id=%s AND assignment_status IN ('assigned','accepted','working')""",
                (tid,),
            )
            for r in cur.fetchall():
                _publish_event(
                    cur,
                    cid,
                    str(r["agent_id"]),
                    "task_ready",
                    {"task_id": tid, "title": t["title"], "via": "readiness release"},
                )
        conn.commit()
    return {"task_id": tid, "status": new_status, "already": False}


@app.post("/api/tasks/{tid}/unassign", status_code=200)
def unassign_task(tid: str, body: TaskUnassign):
    """#326 (B2): clear the active assignee(s) so the task returns to the ready queue (owner==null).

    HUMAN-AUTHORITY gated (Orcha#30 — a deliberate dispatch reset; pairs with #327 AI-can't-assign).
    Releases every active agent_tasks row (the same DELETE /assign-reassign and /retire use — 'done'
    history rows are untouched) and, if the task was in_progress, returns it to 'ready' (or 'pending'
    if its deps aren't satisfied) so another agent can claim it. Idempotent no-op (200) when the task
    already has no active assignee. Refused (409) for the root task and terminal states."""
    if not _valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        _require_kind(
            cur, body.actor_agent_id, ("human",)
        )  # Orcha#30: dispatch reset is a human action
        t = _require_task(cur, tid)
        cid = str(t["container_id"])
        if t["is_root"]:
            raise HTTPException(
                409, "the root task cannot be unassigned — only the human verifies it"
            )
        if t["status"] in ("completed", "needs_verification", "cancelled"):
            raise HTTPException(
                409,
                f"task is '{t['status']}' — cannot unassign a finished/cancelled task",
            )
        cur.execute(
            """SELECT agent_id FROM agent_tasks
               WHERE task_id=%s AND assignment_status IN ('assigned','accepted','working')""",
            (tid,),
        )
        active = [str(r["agent_id"]) for r in cur.fetchall()]
        if not active:
            conn.commit()
            return {
                "task_id": tid,
                "status": t["status"],
                "released": [],
                "already": True,
            }
        cur.execute(
            """DELETE FROM agent_tasks
               WHERE task_id=%s AND assignment_status IN ('assigned','accepted','working')""",
            (tid,),
        )
        cur.execute("DELETE FROM agent_self_wake WHERE task_id=%s", (tid,))
        # An in_progress task with no assignee left returns to the queue; a ready/pending/not_ready
        # task keeps its status (it just loses its owner). started_at clears so a reclaim is clean.
        new_status = t["status"]
        if t["status"] == "in_progress":
            new_status = "pending" if _deps_unmet(cur, tid) else "ready"
            cur.execute(
                "UPDATE tasks SET status=%s, started_at=NULL WHERE id=%s",
                (new_status, tid),
            )
        for pid in active:
            recompute_agent_status(cur, pid)
            # GH #58: unassigning retracts this task from pid — resolve any outstanding NEW_WORK /
            # DIRECTIVE notification for it (assign/ready/in_progress-directive/rework) so an
            # assign→unassign-before-finish never pins pid's wake cursor on a task it no longer owns.
            _ack_events_handled(cur, pid, "task_assigned", "task_id", tid)
            _ack_events_handled(cur, pid, "task_ready", "task_id", tid)
            _ack_events_handled(cur, pid, "task_verified", "task_id", tid)
            _publish_event(
                cur,
                cid,
                pid,
                "task_unassigned",
                {"task_id": tid, "by_human_id": body.actor_agent_id},
            )
        log_event(
            cur,
            cid,
            "human",
            body.actor_agent_id,
            "task",
            tid,
            "unassigned",
            {"released": active, "status": new_status},
        )
        conn.commit()
    return {"task_id": tid, "status": new_status, "released": active, "already": False}
