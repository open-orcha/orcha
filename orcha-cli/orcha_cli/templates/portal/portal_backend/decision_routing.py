"""Persist authority decisions and mirror task decisions into collaboration threads."""

from portal_backend.agent_status import log_event
from portal_backend.events import publish_event as _publish_event
from portal_backend.guards import valid_uuid as _valid_uuid


def _post_decision_to_thread(
    cur, subject_type, subject_id, decision, reason, actor_agent_id
):
    """ISS-48: mirror a human-authority decision into the collaboration THREAD the target
    agent actually reads.

    Decisions were written ONLY to the `decisions` table + a `decision_made` event. But an
    agent's source of truth is the task thread (`task_messages`): on wake it re-reads the
    thread, and the approval/rejection was nowhere in it — so an approved agent re-posted its
    plan and waited forever (confirmed 2026-06-04: Invy task 070d631d approved twice, never
    produced a PR). This posts a structured, ATTRIBUTED decision message to the task thread so
    the agent SEES the verdict and proceeds (resolves ISS-42's reject-reason gap too).

    Scope: only decisions whose subject is a TASK have a task thread (plan_approval, task_verify,
    task_close — subject_id is a task id). A request/checkpoint/dummy subject has no task thread,
    so we no-op for it (the existence check below also stops a non-task subject_id from ever
    hitting the task_messages FK). Attribution is the human decider's agent_id — NOT a null
    author, which the thread read path renders as a human free-text post (the ISS-43 mislabel).
    Returns the message id, or None when there's no task thread to post to."""
    if not _valid_uuid(str(subject_id)):
        return None
    cur.execute("SELECT container_id FROM tasks WHERE id=%s", (str(subject_id),))
    trow = cur.fetchone()
    if not trow:
        return None  # subject isn't a task → no thread (request/checkpoint/…)
    cur.execute("SELECT alias FROM agents WHERE id=%s", (actor_agent_id,))
    arow = cur.fetchone()
    who = (arow["alias"] if arow else None) or "a human"
    verb = "APPROVED" if decision == "approve" else "REJECTED"
    body = f"[DECISION · {subject_type} = {verb} by {who}]"
    if reason:
        body += f" — {reason}"
    cur.execute(
        "INSERT INTO task_messages (task_id, author_id, body) VALUES (%s, %s, %s) RETURNING id",
        (str(subject_id), actor_agent_id, body),
    )
    mid = str(cur.fetchone()["id"])
    log_event(
        cur,
        trow["container_id"],
        "human",
        actor_agent_id,
        "task",
        str(subject_id),
        "decision_message",
        {
            "message_id": mid,
            "decision": decision,
            "subject_type": subject_type,
            "preview": body[:120],
        },
    )
    return mid


def _route_close_reason(
    cur, container_id, subject_type, subject_id, reason, actor_agent_id, target_agent_id
):
    """B7/B0: persist a human's close/cancel REASON as a decision and route it to the
    OWNING agent so it learns WHY its item was force-closed on its next wake. Reuses the
    B0 `decisions` table + `decision_made` event verbatim; a force-close is modelled as
    decision='reject' (the human overrode/abandoned the item) carrying the reason."""
    cur.execute(
        """INSERT INTO decisions
             (container_id, subject_type, subject_id, decision, reason, actor_agent_id, target_agent_id)
           VALUES (%s, %s, %s, 'reject', %s, %s, %s)
           RETURNING id""",
        (
            container_id,
            subject_type,
            str(subject_id),
            reason,
            actor_agent_id,
            target_agent_id,
        ),
    )
    did = str(cur.fetchone()["id"])
    if target_agent_id:
        _publish_event(
            cur,
            str(container_id) if container_id else None,
            str(target_agent_id),
            "decision_made",
            {
                "decision_id": did,
                "subject_type": subject_type,
                "subject_id": str(subject_id),
                "decision": "reject",
                "reason": reason,
            },
        )
    # NB: the task-thread mirror (ISS-48) is posted ONCE by the caller, not here — this helper
    # runs once PER owning assignee, so posting inside it duplicated the thread message on a
    # multi-assignee close (review P3).
    return did
