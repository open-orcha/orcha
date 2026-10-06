"""Mark assigned work done while preserving facade monkeypatch seams."""

import json
from typing import Optional

from fastapi import Header, HTTPException, Request

from portal_backend.agent_status import bump_agent, log_event, recompute_agent_status
from portal_backend.application import app
from portal_backend.autonomy import effective_autonomy
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
        # #298 + mig 043: the ONE engine-enforced autonomy gate, now computed as the EFFECTIVE
        # level for the ACTING agent (body.agent_id — the agent marking done; on this WORK-lane
        # route the acting identity is exactly the one _require_work_lane above verified a
        # work-token for, so the override lookup can never key off a spoofed sibling), not the
        # bare container level. effective_autonomy() is the single shared rule EVERY consumer
        # routes through: container level if the container ENFORCES it for everyone, else the
        # agent's per-agent override, else the container level (NULL override = inherit). It
        # decides the terminal state of THIS agent's /done:
        #   plan | pr -> needs_verification (a human verifies — today's behavior, the safe default)
        #   full      -> the task AUTO-COMPLETES (no human in the loop) via the SAME
        #               _complete_and_unblock path /verify's approve branch uses, so a
        #               full-autonomy completion is indistinguishable from a verified one
        #               (downstream unblock + wakes + root→container). An agent with override='full'
        #               auto-completes while a sibling at container 'plan' still parks — and an
        #               enforced container flips both back to the container level. The free-text
        #               per-task protocol.autonomy is DELIBERATELY ignored here — an unvalidated
        #               string must never widen the hard gate; only these enum columns can.
        cur.execute(
            "SELECT autonomy_level, autonomy_enforced FROM containers WHERE id=%s",
            (t["container_id"],),
        )
        c = cur.fetchone()
        cur.execute(
            "SELECT autonomy_override FROM agents WHERE id=%s", (body.agent_id,)
        )
        acting = cur.fetchone()
        level = effective_autonomy(
            c["autonomy_level"],
            c["autonomy_enforced"],
            acting["autonomy_override"] if acting else None,
        )
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
                "UPDATE tasks SET result=%s WHERE id=%s", (result_json, tid)
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
            {"to": "needs_verification", "autonomy_level": level},
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
