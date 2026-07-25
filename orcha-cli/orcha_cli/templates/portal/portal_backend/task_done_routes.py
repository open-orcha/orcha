"""Mark assigned work done while preserving facade monkeypatch seams."""

import json
from typing import Optional

from fastapi import Header, HTTPException

from portal_backend.agent_status import bump_agent, log_event, recompute_agent_status
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.event_acknowledgement import _ack_events_handled
from portal_backend.events import publish_event as _publish_event
from portal_backend.guards import (
    reject_if_retired as _reject_if_retired,
    require_container_active as _require_container_active,
    require_task as _require_task,
    valid_uuid as _valid_uuid,
)
from portal_backend.schemas.task_operations import TaskDone
from portal_backend.worker_auth import require_work_lane as _require_work_lane

_complete_and_unblock_getter = None
_backstop_stranded_request_getter = None
_recalibrate_agent_digest_getter = None


def configure_compatibility(
    complete_and_unblock_getter,
    backstop_stranded_request_getter,
    recalibrate_agent_digest_getter,
):
    """Bind facade-owned helper seams used by task completion tests."""
    global _complete_and_unblock_getter
    global _backstop_stranded_request_getter
    global _recalibrate_agent_digest_getter
    _complete_and_unblock_getter = complete_and_unblock_getter
    _backstop_stranded_request_getter = backstop_stranded_request_getter
    _recalibrate_agent_digest_getter = recalibrate_agent_digest_getter


@app.post("/api/tasks/{tid}/done", status_code=200)
def mark_done(
    tid: str,
    body: TaskDone,
    x_orcha_run_token: Optional[str] = Header(default=None, alias="X-Orcha-Run-Token"),
):
    if not _valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    if not _valid_uuid(body.agent_id):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        t = _require_task(cur, tid)
        # GH #91/#90: completing a task is WORK-lane only — gate on the ACTING agent (body.agent_id).
        # A conversation-lane embodiment cannot mark a task done (403).
        _require_work_lane(cur, body.agent_id, x_orcha_run_token)
        _reject_if_retired(cur, body.agent_id)  # ISS-51 [P1]
        _require_container_active(cur, str(t["container_id"]), body.agent_id)  # GH #24
        # Issue #11: root task is a sentinel for container completion — only
        # the human verifies it via /orcha-verify <root_tid>. An agent should
        # never be able to mark it done, even if assignment somehow happened.
        if t["is_root"]:
            raise HTTPException(
                409,
                "this is the container's root task — agents cannot mark it done. "
                "Only /orcha-verify by the human flips it to completed (and the container along with it).",
            )
        # Item 4 (review): blocked tasks shouldn't flip done — blocked means
        # deps not satisfied, so completion would skip the dependency gate.
        if t["status"] != "in_progress":
            raise HTTPException(
                409, f"task is '{t['status']}', not 'in_progress' — can't mark done"
            )
        # Item 3 (review): only an assignee can mark a task done. Without this
        # check anyone with the task UUID could flip the state.
        cur.execute(
            "SELECT 1 FROM agent_tasks WHERE agent_id=%s AND task_id=%s LIMIT 1",
            (body.agent_id, tid),
        )
        if not cur.fetchone():
            raise HTTPException(
                403, "this agent isn't assigned to that task — cannot mark it done"
            )
        # #298: the ONE engine-enforced autonomy gate. The container's autonomy_level decides the
        # terminal state of a /done:
        #   plan | pr -> needs_verification (a human verifies — today's behavior, the safe default)
        #   full      -> the task AUTO-COMPLETES (no human in the loop) via the SAME
        #               _complete_and_unblock path /verify's approve branch uses, so a
        #               full-autonomy completion is indistinguishable from a verified one
        #               (downstream unblock + wakes + root→container). The free-text per-task
        #               protocol.autonomy is DELIBERATELY ignored here — an unvalidated string
        #               must never widen the hard gate; only this enum column can auto-complete.
        cur.execute(
            "SELECT autonomy_level FROM containers WHERE id=%s", (t["container_id"],)
        )
        level = cur.fetchone()["autonomy_level"]
        result_json = json.dumps({"result": body.result, "by_agent_id": body.agent_id})
        cur.execute(
            "UPDATE agent_tasks SET assignment_status='done' WHERE agent_id=%s AND task_id=%s",
            (body.agent_id, tid),
        )
        # GH #58: a CLEAN completion resolves this task's surfaced-not-acked DIRECTIVES — the in_progress
        # task_assigned start directive and any task_verified{approved:false} rework directive — so they
        # stop re-waking the now-finished assignee. Same txn as the /done (no loss if it rolls back).
        _ack_events_handled(cur, body.agent_id, "task_assigned", "task_id", tid)
        _ack_events_handled(cur, body.agent_id, "task_verified", "task_id", tid)
        if level == "full":
            cur.execute(
                "UPDATE tasks SET result=%s::jsonb WHERE id=%s", (result_json, tid)
            )
            unblocked = _complete_and_unblock_getter()(cur, t["container_id"], tid)
            bump_agent(cur, body.agent_id)
            recompute_agent_status(cur, body.agent_id)
            log_event(
                cur,
                t["container_id"],
                "ai",
                body.agent_id,
                "task",
                tid,
                "status_changed",
                {
                    "to": "completed",
                    "autonomy_level": "full",
                    "auto_completed": True,
                    "unblocked": unblocked,
                },
            )
            conn.commit()
            return {
                "task_id": tid,
                "status": "completed",
                "auto_completed": True,
                "unblocked": unblocked,
            }
        cur.execute(
            "UPDATE tasks SET status='needs_verification', result=%s::jsonb WHERE id=%s",
            (result_json, tid),
        )
        cur.execute("DELETE FROM agent_self_wake WHERE task_id=%s", (tid,))
        # GH #56 (Point 5): plan/pr autonomy parks the task at needs_verification (the full branch
        # above auto-completes via _complete_and_unblock, which runs the same backstop). If this is
        # an accepter's spawned task and its originating request is still 'accepted', auto-answer it
        # so the requester's loop closes even when the accepter forgot the report-back.
        _backstop_stranded_request_getter()(cur, t["container_id"], tid)
        bump_agent(cur, body.agent_id)
        recompute_agent_status(cur, body.agent_id)
        # GH #35: the active work is done (parked at needs_verification), so recalibrate the
        # owner's digest now — prune this task's stale open threads / decisions, but KEEP a thread
        # about the still-pending human verification (verification_pending=True; never self-certify).
        _recalibrate_agent_digest_getter()(
            cur,
            t["container_id"],
            body.agent_id,
            tid,
            t["title"],
            verification_pending=True,
        )
        log_event(
            cur,
            t["container_id"],
            "ai",
            body.agent_id,
            "task",
            tid,
            "status_changed",
            {"to": "needs_verification", "autonomy_level": level},
        )
        conn.commit()
    return {"task_id": tid, "status": "needs_verification"}
