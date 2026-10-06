"""Approve completed work or return it to its assignees."""

import json

from fastapi import HTTPException, Request

from portal_backend import sql
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
from portal_backend.identity_routes import trusted_actor as _trusted_actor
from portal_backend.review_routing import (
    supersede_pending_prereview as _supersede_pending_prereview,
)
from portal_backend.schemas.task_operations import TaskVerify
from portal_backend.verdikt_autofix import end_for_person as _end_autofix

_complete_and_unblock_getter = None


def configure_compatibility(complete_and_unblock_getter):
    """Bind the facade-owned shared completion seam."""
    global _complete_and_unblock_getter
    _complete_and_unblock_getter = complete_and_unblock_getter


@app.post("/api/tasks/{tid}/verify", status_code=200)
def verify_task(tid: str, body: TaskVerify, request: Request):
    if not _valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        t = _require_task(cur, tid)
        # Per-project identity: a trusted proxy login IS the verifier (403 non-member).
        body.actor_agent_id = _trusted_actor(
            cur, request, str(t["container_id"]), body.actor_agent_id
        )
        _require_kind(cur, body.actor_agent_id, ("human",))  # Orcha#30
        # Issue #11 follow-up: agents can't /done the root task, so it never
        # reaches needs_verification on its own. The human must be able to
        # /verify it from any non-terminal status to declare the container
        # complete. Non-root tasks still go through the regular gate.
        if t["status"] in ("completed", "cancelled"):
            raise HTTPException(
                409, f"task is already '{t['status']}'; nothing to verify"
            )
        # Mig 057 — human override of an AI manager's send-back: the manager returned the
        # work to its assignee, but a human may still accept it as delivered (approve only).
        cur.execute("SELECT manager_review FROM tasks WHERE id=%s", (tid,))
        _mr = cur.fetchone()["manager_review"] or {}
        overriding_send_back = (
            body.approve
            and not t["is_root"]
            and t["status"] == "in_progress"
            and _mr.get("status") == "sent_back"
        )
        if not t["is_root"] and t["status"] != "needs_verification" and not overriding_send_back:
            raise HTTPException(
                409, f"task is '{t['status']}', not 'needs_verification'"
            )
        if overriding_send_back:
            cur.execute(
                f"UPDATE tasks SET manager_review = {sql.json_merge('manager_review', sql.json_cast())} WHERE id=%s",
                (json.dumps({"status": "overridden", "overridden_by": body.actor_agent_id}), tid),
            )
            cur.execute(
                "UPDATE agent_tasks SET assignment_status='done' WHERE task_id=%s "
                "AND assignment_status='working' RETURNING agent_id",
                (tid,),
            )
            for r in cur.fetchall():
                _ack_events_handled(cur, str(r["agent_id"]), "task_verified", "task_id", tid)
                recompute_agent_status(cur, str(r["agent_id"]))
            log_event(
                cur, t["container_id"], "human", body.actor_agent_id, "task", tid,
                "manager_review_overridden",
                {"manager_alias": _mr.get("manager_alias"), "manager_decision": "send_back"},
            )
        else:
            # A human verifying (either way) while the AI pre-review is still pending
            # supersedes it — human authority; the manager's request is closed.
            _supersede_pending_prereview(
                cur, t["container_id"], tid, reason="human_verified",
                actor_id=body.actor_agent_id,
            )

        # Mig 068: a person deciding ends a running Verdikt auto-fix loop (human authority).
        _end_autofix(cur, t, body.actor_agent_id, "accepted" if body.approve else "rejected")

        # Parity r2 (D10 "actor verb object"): the verifier's note and the audit row are
        # ATTRIBUTED to the verifying human — the same rule decision_routing applies to
        # [DECISION] posts. A NULL author rendered as an anonymous system line and hid
        # who accepted / rejected the work.
        if body.approve:
            # #298: completion mechanics (mark completed, unblock downstream, complete-root)
            # are SHARED with the full-autonomy /done path via _complete_and_unblock so the two
            # paths can't drift. The verify-specific audit + wake events stay here.
            unblocked = _complete_and_unblock_getter()(cur, t["container_id"], tid)

            # #288/ISS-59: an approval may carry a verifier NOTE (e.g. "please do the
            # follow-up X"). Mirror the rejection branch — persist it to the task thread and
            # carry it through the audit + the task_verified wake event — so a human-authored
            # note is NEVER silently dropped. This is what makes the wake-suppression bareness
            # rule work: _triage_hint_for sees the feedback and triages tier=llm (note read by
            # an LLM), instead of classifying a feedback-stripped payload as a bare FYI and
            # suppressing the wake.
            if body.feedback:
                cur.execute(
                    "INSERT INTO task_messages (task_id, author_id, body) VALUES (%s, %s, %s)",
                    (tid, body.actor_agent_id, f"[verification approved] {body.feedback}"),
                )
            log_event(
                cur,
                t["container_id"],
                "human",
                body.actor_agent_id,
                "task",
                tid,
                "verified",
                {
                    "approved": True,
                    "unblocked": unblocked,
                    "feedback": body.feedback,
                    "verifier_human_id": body.actor_agent_id,
                },
            )
            # Notify the assignees their work was approved + any newly-ready downstream
            cur.execute(
                "SELECT DISTINCT agent_id FROM agent_tasks WHERE task_id=%s",
                (tid,),
            )
            for r in cur.fetchall():
                _publish_event(
                    cur,
                    str(t["container_id"]),
                    str(r["agent_id"]),
                    "task_verified",
                    {"task_id": tid, "approved": True, "feedback": body.feedback},
                )
            # (downstream task_ready wakes + root→container completion are published inside
            # _complete_and_unblock above — shared with the full-autonomy /done path.)
            conn.commit()
            return {"task_id": tid, "status": "completed", "unblocked": unblocked}
        else:
            cur.execute(
                "UPDATE tasks SET status='in_progress' WHERE id=%s",
                (tid,),
            )
            # Item 2 (review): undo the agent_tasks done flag from /done so the
            # original assignee is "actively working" again. Without this, the
            # task is in_progress with no active assignee — orphaned.
            cur.execute(
                "UPDATE agent_tasks SET assignment_status='working' "
                "WHERE task_id=%s AND assignment_status='done' RETURNING agent_id",
                (tid,),
            )
            restored = [str(r["agent_id"]) for r in cur.fetchall()]
            for aid in restored:
                recompute_agent_status(cur, aid)
            if body.feedback:
                cur.execute(
                    "INSERT INTO task_messages (task_id, author_id, body) VALUES (%s, %s, %s)",
                    (tid, body.actor_agent_id, f"[verification rejected] {body.feedback}"),
                )
            log_event(
                cur,
                t["container_id"],
                "human",
                body.actor_agent_id,
                "task",
                tid,
                "verified",
                {
                    "approved": False,
                    "feedback": body.feedback,
                    "reassigned_to_agent_ids": restored,
                    "verifier_human_id": body.actor_agent_id,
                },
            )
            for aid in restored:
                _publish_event(
                    cur,
                    str(t["container_id"]),
                    aid,
                    "task_verified",
                    {"task_id": tid, "approved": False, "feedback": body.feedback},
                )
            conn.commit()
            return {
                "task_id": tid,
                "status": "in_progress",
                "feedback": body.feedback,
                "restored_assignee_agent_ids": restored,
            }
