"""Cancel non-root tasks and notify displaced owners."""

from fastapi import HTTPException, Request

from portal_backend.agent_status import bump_agent, log_event, recompute_agent_status
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.decision_routing import (
    _post_decision_to_thread,
    _route_close_reason,
)
from portal_backend.event_acknowledgement import _ack_events_handled
from portal_backend.events import poke_path_forward as _poke_path_forward
from portal_backend.guards import (
    reject_if_retired as _reject_if_retired,
    require_container_active as _require_container_active,
    require_task as _require_task,
    valid_uuid as _valid_uuid,
)
from portal_backend.identity_routes import trusted_actor as _trusted_actor
from portal_backend.schemas.task_operations import TaskCancel
from portal_backend.task_completion_support import _recalibrate_task_owners


@app.post("/api/tasks/{tid}/cancel", status_code=200)
def cancel_task(tid: str, body: TaskCancel, request: Request):
    """B7 (ISS-23) + #327: force-close a task. A human OR a dispatching AI orchestrator may cancel
    ANY non-root task. Cancelling a task owned by SOMEONE ELSE is "forced" — kind-agnostic now: the
    actor (human or AI) MUST give a reason, which is routed to each displaced owner via the B0
    decision primitive (+ a path-forward poke) so they learn why. An assignee cancelling its own
    task needs no reason. (Was: only a human could force-cancel; a non-assignee AI got a 403.)"""
    if not _valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    if not _valid_uuid(body.actor_agent_id):
        raise HTTPException(400, "actor_agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        t = _require_task(cur, tid)
        # Per-project identity: a trusted proxy login IS the actor (403 non-member).
        body.actor_agent_id = _trusted_actor(
            cur, request, str(t["container_id"]), body.actor_agent_id
        )
        _require_container_active(
            cur, str(t["container_id"]), body.actor_agent_id
        )  # GH #24 (human may still cancel)
        _reject_if_retired(
            cur, body.actor_agent_id
        )  # ISS-51 (#327: AI may now cancel — hold it to the same bar)
        # Review P2: the root sentinel task must never be cancelled. Cancelling it leaves the
        # container stuck 'active' AND wedges the "root verify completes the container" path
        # (verify rejects a cancelled task). Direct the human to cancel the container instead.
        if t["is_root"]:
            raise HTTPException(
                409,
                "the root task can't be cancelled; cancel the container via "
                'POST /api/containers/{cid}/status {"status":"cancelled"}',
            )
        cur.execute("SELECT kind FROM agents WHERE id=%s", (body.actor_agent_id,))
        arow = cur.fetchone()
        if not arow:
            raise HTTPException(404, f"agent {body.actor_agent_id} not found")
        is_human = arow["kind"] == "human"
        # who owns the task = its assignees
        cur.execute("SELECT agent_id FROM agent_tasks WHERE task_id=%s", (tid,))
        assignees = [str(r["agent_id"]) for r in cur.fetchall()]
        is_assignee = body.actor_agent_id in assignees
        # #327: any kind='ai' orchestrator (not just an assignee) may now cancel — mirroring
        # assign_task. The old "non-assignee non-human → 403" guard is removed; the reason-required
        # + owner-poke path below (now kind-agnostic) is what keeps a force-cancel accountable.
        # idempotent / illegal-transition
        if t["status"] == "cancelled":
            return {"task_id": tid, "status": "cancelled", "already_cancelled": True}
        if t["status"] == "completed":
            raise HTTPException(409, "task is 'completed' — cannot cancel")
        # B7.2 + #327: cancelling a task owned by someone ELSE is "forced" and requires a reason
        # (routed to the owner). Kind-agnostic: a human is never an assignee, so `not is_assignee`
        # is True for humans → this stays identical for the human case while also covering an AI
        # orchestrator cancelling a teammate's task. API-enforced, not only the UI.
        reason = (body.reason or "").strip()
        others = [a for a in assignees if a != body.actor_agent_id]
        forced = (not is_assignee) and len(others) > 0
        if forced and not reason:
            raise HTTPException(
                422,
                {
                    "error": "reason_required",
                    "detail": "a reason is required when cancelling another agent's task",
                },
            )
        cur.execute(
            "UPDATE tasks SET status='cancelled', completed_at=now() WHERE id=%s",
            (tid,),
        )
        cur.execute("DELETE FROM agent_self_wake WHERE task_id=%s", (tid,))
        # Review P2: clear the now-stale assignments so assignees don't stay 'working'.
        # recompute_agent_status counts assigned|accepted|working rows regardless of the
        # task's status, so a cancelled task would otherwise pin its assignee 'working'.
        # 'done' is the codebase's terminal assignment state (same value the verify/done path uses).
        cur.execute(
            "UPDATE agent_tasks SET assignment_status='done' "
            "WHERE task_id=%s AND assignment_status IN ('assigned','accepted','working')",
            (tid,),
        )
        log_event(
            cur,
            t["container_id"],
            ("human" if is_human else "ai"),
            body.actor_agent_id,
            "task",
            tid,
            "cancelled",
            {"by_human": is_human, "forced": forced},
        )
        for aid in assignees:
            bump_agent(cur, aid)
            recompute_agent_status(cur, aid)
            # GH #58: cancel is a TERMINAL seam — resolve this task's outstanding NEW_WORK / DIRECTIVE
            # notifications for every assignee so a cancelled task never pins their wake cursor.
            _ack_events_handled(cur, aid, "task_assigned", "task_id", tid)
            _ack_events_handled(cur, aid, "task_ready", "task_id", tid)
            _ack_events_handled(cur, aid, "task_verified", "task_id", tid)
        # Route the reason to each OWNING assignee that isn't the actor.
        if forced:
            for owner in others:
                _route_close_reason(
                    cur,
                    t["container_id"],
                    "task_close",
                    tid,
                    reason,
                    body.actor_agent_id,
                    owner,
                )
                # ISS-42 (B12): the routed decision wakes the owner but carries no surfaced content,
                # so a cancelled owner would wake to nothing actionable (the dead-end). Poke them with
                # the reason + closure so they re-engage knowing it's closed and what they can do next.
                _poke_path_forward(
                    cur,
                    t["container_id"],
                    owner,
                    body.actor_agent_id,
                    f'Your task "{t["title"]}" (id {tid}) was cancelled by '
                    f"{'a human' if is_human else 'the orchestrator'}: {reason}. It's "
                    f"closed — no further work is needed on it. If a follow-up is warranted, propose a "
                    f"new task (/orcha-task-new) or raise it with your coordinator.",
                )
            # ISS-48 (review P3): mirror the close into the task thread ONCE — _route_close_reason
            # runs per-owner (one decision row + decision_made each), but the thread message is
            # task-level, so a multi-assignee close must not stack identical [DECISION] rows.
            _post_decision_to_thread(
                cur, "task_close", tid, "reject", reason, body.actor_agent_id
            )
        # GH #35: a cancelled task's work is closed for good — recalibrate each owner's digest so
        # its stale open threads / decisions don't rehydrate next wake. Not pending verification.
        _recalibrate_task_owners(
            cur, t["container_id"], tid, t["title"], verification_pending=False
        )
        conn.commit()
    return {
        "task_id": tid,
        "status": "cancelled",
        "forced": forced,  # #327: forced over ANY other owner (human or AI)
        "forced_by_human": forced
        and is_human,  # back-compat: precise "a human forced this"
        "owners_poked": len(others) if forced else 0,
    }
