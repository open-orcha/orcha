"""Mark assigned work done while preserving facade monkeypatch seams."""

import json
from typing import Optional

from fastapi import Header, HTTPException, Request

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
from portal_backend.push_outbox import push_task_verify as _push_task_verify
from portal_backend.verdikt_autofix import is_running as _autofix_running
from portal_backend.evidence_pack import on_task_needs_verification as _evidence_on_needs_verification
from portal_backend.review_routing import route_finished_work as _route_finished_work
from portal_backend.schemas.task_operations import TaskDone
from portal_backend.slack_notify import (
    notify_task_needs_verification as _slack_notify_needs_verification,
)
from portal_backend.worker_auth import require_work_lane as _require_work_lane
from portal_backend.task_autonomy_service import (
    record_approval,
    task_completion_blockers,
)
from portal_backend.task_approval_policy import ApprovalPhase

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
    request: Request,
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
        _require_work_lane(cur, body.agent_id, x_orcha_run_token, request)
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
        result_json = json.dumps({"result": body.result, "by_agent_id": body.agent_id})

        if t.get("workflow_id"):
            # Workflow work must first freeze the current run's evidence. Generic
            # completion can never skip reservation, evidence, stop or scheduling rules.
            from portal_backend.workflow_evidence_service import capture_workflow_submission
            from portal_backend.workflow_integration import IntegratedWorkflowHooks
            from portal_backend.workflow_service import WorkflowService

            cur.execute(
                """SELECT e.*,r.run_id FROM workflow_executions e
                   JOIN embodiment_tokens tok ON tok.run_id=e.run_id
                   JOIN worker_runs r ON r.run_id=e.run_id
                   WHERE tok.run_token=%s AND tok.agent_id=%s AND e.task_id=%s
                     AND tok.revoked_at IS NULL AND r.ended_at IS NULL
                   ORDER BY e.generation DESC LIMIT 1""",
                (x_orcha_run_token, body.agent_id, tid),
            )
            execution = cur.fetchone()
            if not execution:
                raise HTTPException(
                    409,
                    {"code": "workflow_execution_required", "message": "This workflow task must finish from its current reserved worker."},
                )
            cur.execute(
                """SELECT COALESCE(max(source_sequence),0)+1 AS n
                   FROM workflow_evidence_sets
                   WHERE workflow_execution_id=%s AND generation=%s""",
                (execution["id"], execution["generation"]),
            )
            sequence = cur.fetchone()["n"]
            # Refuse unfinished handoff work before publishing immutable files:
            # rolling SQL back cannot undo a file allocated at that version.
            from portal_backend.workflow_review_handoff import require_clean
            service = WorkflowService(cur, IntegratedWorkflowHooks())
            service.lock(str(t['workflow_id']))
            require_clean(service, t)
            reference = capture_workflow_submission(
                cur,
                str(execution["run_id"]),
                generation=execution["generation"],
                work_revision=t["work_revision"],
                source_sequence=sequence,
                result=body.result,
                source_revision=None,
                captured_by=body.agent_id,
                requires_file_changes=False,
            )
            cur.execute("UPDATE tasks SET result=%s WHERE id=%s", (result_json, tid))
            WorkflowService(cur, IntegratedWorkflowHooks()).submit_for_review(
                tid,
                str(execution["id"]),
                execution["generation"],
                reference,
            )
            bump_agent(cur, body.agent_id)
            recompute_agent_status(cur, body.agent_id)
            log_event(
                cur,
                t["container_id"],
                "ai",
                body.agent_id,
                "task",
                tid,
                "workflow_result_submitted",
                {
                    "autonomy": t.get("autonomy") or "off",
                    "autonomy_revision": t["autonomy_revision"],
                    "evidence_set_id": reference["evidence_set_id"],
                },
            )
            conn.commit()
            return {
                "task_id": tid,
                "status": "needs_verification",
                "workflow_id": str(t["workflow_id"]),
                "evidence": reference,
                "auto_completion_pending_worker_stop": t.get("autonomy") == "on",
            }

        level = t.get("autonomy") or "off"
        cur.execute(
            "UPDATE agent_tasks SET assignment_status='done' WHERE agent_id=%s AND task_id=%s",
            (body.agent_id, tid),
        )
        # GH #58: a CLEAN completion resolves this task's surfaced-not-acked DIRECTIVES — the in_progress
        # task_assigned start directive and any task_verified{approved:false} rework directive — so they
        # stop re-waking the now-finished assignee. Same txn as the /done (no loss if it rolls back).
        _ack_events_handled(cur, body.agent_id, "task_assigned", "task_id", tid)
        _ack_events_handled(cur, body.agent_id, "task_verified", "task_id", tid)
        if level == "on":
            cur.execute(
                "UPDATE tasks SET result=%s WHERE id=%s", (result_json, tid)
            )
            approval_task = dict(t)
            approval_task["result"] = result_json
            record_approval(
                cur,
                approval_task,
                body.agent_id,
                ApprovalPhase.COMPLETION,
                body.result,
                blockers=task_completion_blockers(t),
                permission_source="task_autonomy",
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
                    "task_autonomy": "on",
                    "autonomy_revision": t["autonomy_revision"],
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
            "UPDATE tasks SET status='needs_verification', result=%s WHERE id=%s",
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
            {
                "to": "needs_verification",
                "task_autonomy": "off",
                "autonomy_revision": t["autonomy_revision"],
            },
        )
        # Mig 057: finished work follows the org chart — route the review to the finisher's
        # human manager (or the owner / anyone, per the project setting) and, when an AI
        # manager sits in between, ask it to pre-review. Same txn as the transition.
        review = _route_finished_work(cur, t["container_id"], tid, body.agent_id, body.result)
        conn.commit()
    # Mig 068: while a Verdikt auto-fix loop runs, the hand-back goes straight to Verdikt —
    # the human is told once, when the loop stops (pass / limit / no progress …).
    if not _autofix_running(tid):
        # Push pipeline (mig 041): the task just became a needs-you item. AFTER the
        # commit, best-effort — the hook never raises and never touches this txn.
        _push_task_verify(str(t["container_id"]), tid)
        # Slack seam (mig 044): if this container has a slack_webhook_url, ping it with a
        # compact Block Kit "Verify in Orcha" message. Same after-commit, non-fatal contract
        # as the push hook — a POST failure (or no webhook) never breaks the transition.
        _slack_notify_needs_verification(str(t["container_id"]), tid)
    # Proof-of-work (mig 058): build the evidence pack and apply the project's Verdikt
    # auto-trigger policy — in a background thread, after the commit, never raising.
    _evidence_on_needs_verification(tid)
    return {"task_id": tid, "status": "needs_verification", "review": review}
