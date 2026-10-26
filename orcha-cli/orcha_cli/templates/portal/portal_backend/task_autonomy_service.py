"""Task-only autonomy and durable plan/completion approval records."""

from datetime import datetime, timezone
from uuid import uuid4
import json

from fastapi import HTTPException

from portal_backend.task_approval_policy import (
    ApprovalActor,
    ApprovalDenied,
    ApprovalPhase,
    ApprovalSubject,
    approval_permission,
)


def assigned_agents(cur, task_id):
    cur.execute(
        "SELECT agent_id FROM agent_tasks WHERE task_id=%s",
        (task_id,),
    )
    return {str(row["agent_id"]) for row in cur.fetchall()}


def approval_actor(cur, task, actor_id, *, human_review_authorized=False):
    cur.execute(
        "SELECT id,container_id,kind,terminated_at FROM agents WHERE id=%s",
        (actor_id,),
    )
    actor = cur.fetchone()
    if not actor:
        raise HTTPException(403, "approval actor is not a project member")
    return ApprovalActor(
        actor_id=str(actor["id"]),
        container_id=str(actor["container_id"]),
        kind=actor["kind"],
        authenticated=True,
        active=actor["terminated_at"] is None,
        human_review_authorized=human_review_authorized,
    )


def record_approval(
    cur,
    task,
    actor_id,
    phase,
    submission,
    *,
    blockers=(),
    human_review_authorized=False,
    permission_source,
):
    """Authorize and persist the exact plan/result under current task permission."""
    phase = ApprovalPhase(phase)
    subject = ApprovalSubject.from_task(task, phase, submission)
    actor = approval_actor(
        cur, task, actor_id, human_review_authorized=human_review_authorized
    )
    try:
        permission = approval_permission(
            task,
            actor,
            subject,
            phase=phase,
            current_submission=submission,
            assigned_agent_ids=assigned_agents(cur, str(task["id"])),
            blockers=blockers,
            now=datetime.now(timezone.utc),
        )
    except ApprovalDenied as exc:
        raise HTTPException(
            403,
            {"code": exc.reason, "message": exc.reason.replace("_", " ")},
        ) from exc
    cur.execute(
        """INSERT INTO task_approval_records
             (id,container_id,task_id,phase,work_revision,requirements_sha256,
              submission_sha256,actor_id,actor_kind,autonomy_at_approval,
              autonomy_revision,permission_source,approved_at)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
           ON CONFLICT (task_id,phase,work_revision,submission_sha256) DO NOTHING""",
        (
            str(uuid4()),
            task["container_id"],
            task["id"],
            phase.value,
            subject.work_revision,
            subject.requirements_digest,
            subject.submission_digest,
            permission.actor_id,
            permission.actor_kind,
            permission.autonomy.value,
            permission.autonomy_revision,
            permission_source,
            permission.granted_at,
        ),
    )
    return permission


def task_completion_blockers(task):
    """Common blockers task autonomy can never waive."""
    blockers = []
    if task.get("status") != "in_progress":
        blockers.append("task_not_in_progress")
    if task.get("start_hold"):
        blockers.append("task_on_hold")
    if task.get("awaiting_owner_decision"):
        blockers.append("owner_decision_required")
    if task.get("withdrawn_at"):
        blockers.append("task_withdrawn")
    return blockers


def completion_submission(task):
    """Return the exact saved result text used for a completion approval digest."""
    result = task.get("result")
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except ValueError:
            return result
    if isinstance(result, dict) and "result" in result:
        result = result["result"]
    if isinstance(result, str):
        return result
    if result is None:
        # Legacy and root tasks can reach human verification without a saved result.
        # Bind their approval to the actual persisted value instead of rejecting the
        # long-standing verification flow or inventing result text that was never
        # submitted.  The canonical JSON spelling also stays distinct from an
        # explicitly saved empty string.
        return "null"
    return json.dumps(result, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
