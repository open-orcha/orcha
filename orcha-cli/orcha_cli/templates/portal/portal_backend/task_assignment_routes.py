"""Assign or reassign an existing task and wake its owner."""

from fastapi import HTTPException

from portal_backend.agent_status import log_event, recompute_agent_status
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.event_acknowledgement import _ack_events_handled
from portal_backend.events import publish_event as _publish_event
from portal_backend.guards import (
    reject_if_retired as _reject_if_retired,
    require_container_active as _require_container_active,
    require_kind as _require_kind,
    require_task as _require_task,
    valid_uuid as _valid_uuid,
)
from portal_backend.schemas.task_operations import AssignTask


@app.post("/api/tasks/{tid}/assign", status_code=200)
def assign_task(tid: str, body: AssignTask):
    """B5: assign an EXISTING task to an agent and wake them — unblocks O4 (assign-from-detail).

    Actor: a human OR a dispatching AI orchestrator (#327 — matches create_task, which already
    lets any AI assign-at-create; an AI actor is held to the same container-active + not-retired
    safeguards). The task lands
    'ready' when its deps are satisfied (a ready + assigned task is an auto-start wake target, so
    we publish a targeted `task_assigned` event and the daemon wakes the assignee to claim it via
    /orcha-next); it stays 'pending' when deps are unmet — NOT woken now, because the existing
    dep-unblock path delivers a targeted `task_ready` to the assignee when its deps clear (waking
    an assignee to a non-ready task would just no-op, the ISS-55 failure mode).

    `reassign=false` (default): refuse (409) if the task already has a DIFFERENT active assignee.
    `reassign=true`: release the prior active assignee(s) first (the same DELETE retire uses —
    'done' history rows are untouched), then assign. Re-asserting the SAME active assignee is an
    idempotent no-op (an in-progress task is never disturbed)."""
    if not _valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    if not _valid_uuid(body.agent_id):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        t = _require_task(cur, tid)
        cid = str(t["container_id"])
        # #327: the AI orchestrator may dispatch (assign/reassign) an EXISTING task. This is the
        # SAME state change create_task already lets any kind='ai' make at create-time (its
        # `assignee_alias` is not human-gated), so locking assign-existing behind a human was an
        # internal inconsistency, not a real privilege boundary. Open the gate to AI, then apply
        # the SAME actor safeguards create_task enforces: no dispatch on a paused/stopped
        # container, none by a retired agent. (Both helpers pass a human actor straight through.)
        actor = _require_kind(
            cur, body.actor_agent_id, ("human", "ai")
        )  # Orcha#30 + #327
        _require_container_active(
            cur, cid, body.actor_agent_id
        )  # GH #24 (human actor passes through)
        _reject_if_retired(cur, body.actor_agent_id)  # ISS-51
        if t["is_root"]:
            raise HTTPException(
                409, "the root task cannot be assigned — only the human verifies it"
            )
        # Terminal states — including 'cancelled' (cancel_task sets it; verify_task refuses it).
        # Assignment must NOT resurrect a finished/cancelled task back to ready/pending. [review P1]
        if t["status"] in ("completed", "needs_verification", "cancelled"):
            raise HTTPException(
                409,
                f"task is '{t['status']}' — cannot assign a finished/cancelled task",
            )
        # Assignee must be a live AI agent in this container (humans don't poll /next — Orcha#30).
        cur.execute(
            "SELECT kind, container_id, alias, terminated_at FROM agents WHERE id=%s",
            (body.agent_id,),
        )
        a = cur.fetchone()
        if not a:
            raise HTTPException(404, f"agent {body.agent_id} not found")
        if str(a["container_id"]) != cid:
            raise HTTPException(409, "agent is not in the same container as the task")
        if a["terminated_at"] is not None:
            raise HTTPException(409, "agent is retired and cannot be assigned work")
        if a["kind"] != "ai":
            raise HTTPException(
                409, f"can only assign tasks to AI agents; agent is kind='{a['kind']}'"
            )

        # Is the target ALREADY an active assignee? (idempotency / don't disturb in-progress work)
        cur.execute(
            "SELECT assignment_status FROM agent_tasks WHERE task_id=%s AND agent_id=%s",
            (tid, body.agent_id),
        )
        ex = cur.fetchone()
        target_active = bool(
            ex and ex["assignment_status"] in ("assigned", "accepted", "working")
        )

        # Other ACTIVE assignees (the reassign gate).
        cur.execute(
            """SELECT agent_id FROM agent_tasks
               WHERE task_id=%s AND agent_id <> %s
                 AND assignment_status IN ('assigned','accepted','working')""",
            (tid, body.agent_id),
        )
        prior = [str(r["agent_id"]) for r in cur.fetchall()]
        if target_active and not prior:
            # Already assigned to this agent and nobody else holds it → idempotent no-op.
            conn.commit()
            return {
                "task_id": tid,
                "agent_id": body.agent_id,
                "alias": a["alias"],
                "status": t["status"],
                "assignment_status": ex["assignment_status"],
                "woke": False,
                "released_prior": None,
            }
        released_prior = None
        if prior:
            if not body.reassign:
                raise HTTPException(
                    409,
                    "task already has a different active assignee — pass reassign=true to reassign",
                )
            cur.execute(
                """DELETE FROM agent_tasks
                   WHERE task_id=%s AND agent_id <> %s
                     AND assignment_status IN ('assigned','accepted','working')""",
                (tid, body.agent_id),
            )
            cur.execute(
                """DELETE FROM agent_self_wake
                   WHERE task_id=%s AND agent_id <> %s""",
                (tid, body.agent_id),
            )
            for pid in prior:
                recompute_agent_status(cur, pid)
                _publish_event(
                    cur,
                    cid,
                    pid,
                    "task_unassigned",
                    {
                        "task_id": tid,
                        "by_id": body.actor_agent_id,
                        "by_kind": actor["kind"],
                    },
                )
            released_prior = prior

        # Ready vs pending is a function of dependency satisfaction (mirror the verify-unblock check).
        cur.execute(
            """SELECT 1 FROM task_dependencies td
               JOIN tasks dep ON dep.id = td.depends_on_id
               WHERE td.task_id=%s AND dep.status <> 'completed' LIMIT 1""",
            (tid,),
        )
        new_status = "pending" if cur.fetchone() else "ready"
        # (Re)assignment resets the task so the assignee claims it cleanly — started_at clears
        # until /orcha-next stamps it. NOT bumping the assignee's heartbeat: that would shrink
        # idle_seconds and make wake-scan think they're active, suppressing the very wake we want.
        cur.execute(
            "UPDATE tasks SET status=%s, started_at=NULL WHERE id=%s", (new_status, tid)
        )
        cur.execute(
            """INSERT INTO agent_tasks (agent_id, task_id, assignment_status)
               VALUES (%s, %s, 'assigned')
               ON CONFLICT (agent_id, task_id) DO UPDATE SET assignment_status='assigned'""",
            (body.agent_id, tid),
        )
        recompute_agent_status(cur, body.agent_id)
        # Wake-wiring: a ready+assigned task is an auto-start target → targeted task_assigned wakes
        # the assignee (daemon). A pending task waits for the dep-unblock task_ready instead.
        woke = False
        if new_status == "ready":
            _publish_event(
                cur,
                cid,
                body.agent_id,
                "task_assigned",
                {"task_id": tid, "title": t["title"], "via": "B5 direct assignment"},
            )
            woke = True
        log_event(
            cur,
            cid,
            actor["kind"],
            body.actor_agent_id,
            "task",
            tid,
            "assigned",
            {
                "agent_id": body.agent_id,
                "alias": a["alias"],
                "status": new_status,
                "reassigned_from": released_prior,
            },
        )
        conn.commit()
    return {
        "task_id": tid,
        "agent_id": body.agent_id,
        "alias": a["alias"],
        "status": new_status,
        "assignment_status": "assigned",
        "woke": woke,
        "released_prior": released_prior,
    }
