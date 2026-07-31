"""Classify pending events by which active run may drain them."""

from typing import Optional

from portal_backend.event_policy import _NON_WAKING_EVENTS
from portal_backend.guards import valid_uuid as _valid_uuid

# ---------- GH #58: drain classification + per-event handled-set (one run drains many) ----------
# _classify_notification (above) answers "how does this row LOOK in the operator panel". _drain_class
# answers the ORTHOGONAL wake question: "may the CURRENTLY-AWAKE run mark this pending event handled,
# or must it leave it for a different/fresh ephemeral?" Every emitted event_name maps to exactly one
# bucket, so nothing is implicitly "safe to ack":
#   NON_WAKING          - self-echo / live-chat channel; never wakes, never counted (digest_snapshotted,
#                         conversation_turn). Excluded from the pending set entirely.
#   FYI                 - informational; no task-context reasoning needed, so ANY awake run acks it so
#                         they don't pile up (task_unassigned, a broadcast task_ready, status_changed, an
#                         APPROVED task_verified, a task_close / non-task decision_made, request_closed,
#                         request_escalated, the task_request_* receipts, agent_suggested/-decided, and a
#                         stale task_assigned whose task is already terminal/gone).
#   TASKLESS_ACTIONABLE - needs reasoning but carries no task identity, so any awake run may drain it
#                         (the resident yields to a protocol-bound ephemeral — docs/orcha-review-protocol
#                         §5.2): prompt, an INFO request_created, a request_answered with no originating task.
#   TASK_BOUND          - actioning it needs reasoning bound to a SPECIFIC task, so it is handled ONLY by a
#                         run whose context == that task; a different-task run LEAVES IT PENDING:
#                         task_message; a request_answered carrying originating_task_id (the #56 link); a
#                         decision_made on a live non-terminal task subject (plan_approval, keyed on
#                         subject_id — the thread mirror is NOT a task_message bus event, so this event is
#                         the sole wake for "proceed/revise").
#   NEW_WORK            - claiming/accepting it STARTS the work, so a drain NEVER acks it; it is consumed at
#                         the /next CLAIM (or accept/reject seam): a task_assigned/task_ready on a `ready`
#                         task; a request_created of type 'task'.
#   DIRECTIVE           - a STATUS-SENSITIVE start/rework directive on an in_progress task: surfaced as the
#                         assignee's wake reason and acked only by a CLEAN run bound to that same task (or a
#                         terminal seam such as /done, cancel or unassign). A failed run leaves it pending for
#                         retry, while a successful run consumes it once so an idle in_progress task cannot
#                         re-trigger the same directive forever: task_assigned on an in_progress task;
#                         task_verified{approved:false} (a rejected verify is a rework directive, never an FYI
#                         that an unrelated task run may ack).
_DRAIN_NON_WAKING = "non_waking"
_DRAIN_FYI = "fyi"
_DRAIN_TASKLESS_ACTIONABLE = "taskless_actionable"
_DRAIN_TASK_BOUND = "task_bound"
_DRAIN_NEW_WORK = "new_work"
_DRAIN_DIRECTIVE = "directive"
# the run MAY ack these buckets regardless of task context. TASK_BOUND and DIRECTIVE are separately ackable
# only when their task == the run context, decided in wake_context.handled_event_ids. NEW_WORK is consumed at
# its claim/accept seam, never by a drain.
_DRAIN_RUN_ACKABLE = (_DRAIN_FYI, _DRAIN_TASKLESS_ACTIONABLE)
# the buckets whose actioning is bound to a SPECIFIC task — a run may surface/handle one only when that
# task IS the run context; otherwise it belongs to a different (or fresh) ephemeral and stays pending.
_DRAIN_TASK_SCOPED = (_DRAIN_TASK_BOUND, _DRAIN_NEW_WORK, _DRAIN_DIRECTIVE)


def _is_cross_task_drain_row(bucket, task_id, context_task_id) -> bool:
    """GH #58 (R3): True when a pending row is task-scoped to a DIFFERENT task than this run's context,
    so this run must neither surface nor ack it — it stays pending for that task's own protocol-bound
    ephemeral. The SINGLE predicate behind both the directed-message filter (prompt_messages) and the
    wake-manifest filter, so surfacing-via-message and surfacing-via-manifest can never disagree.
    A task-less task-scoped row (e.g. a 'task' request_created with no task_id yet) is NOT cross-task —
    any run may accept it."""
    return bool(
        bucket in _DRAIN_TASK_SCOPED
        and task_id
        and str(task_id) != str(context_task_id)
    )


def _drain_task_status(cur, task_id) -> Optional[str]:
    """The current status of a task referenced by an event payload, or None if missing/gone/not-a-uuid."""
    if not task_id or not _valid_uuid(str(task_id)):
        return None
    cur.execute("SELECT status FROM tasks WHERE id=%s", (str(task_id),))
    row = cur.fetchone()
    return row["status"] if row else None


def _drain_class(cur, event_name: str, payload: Optional[dict], target_id=None) -> dict:
    """Classify one pending bus row into a drain bucket. Returns {"bucket": str, "task_id": id|None}.
    `task_id` is set for TASK_BOUND / NEW_WORK(task) / DIRECTIVE so wake_scan can compare it against the
    run's context task. See the bucket taxonomy above."""
    payload = payload or {}
    if event_name in _NON_WAKING_EVENTS or event_name == "conversation_turn":
        return {"bucket": _DRAIN_NON_WAKING, "task_id": None}
    if event_name == "task_message":
        return {"bucket": _DRAIN_TASK_BOUND, "task_id": payload.get("task_id")}
    if event_name == "prompt":
        return {"bucket": _DRAIN_TASKLESS_ACTIONABLE, "task_id": None}
    if event_name == "request_answered":
        otid = payload.get("originating_task_id")
        if otid and _drain_task_status(cur, otid) is not None:
            return {"bucket": _DRAIN_TASK_BOUND, "task_id": str(otid)}
        return {"bucket": _DRAIN_TASKLESS_ACTIONABLE, "task_id": None}
    if event_name == "request_created":
        rtype = payload.get("type")
        if rtype is None:
            rid = payload.get("request_id")
            if rid and _valid_uuid(str(rid)):
                cur.execute("SELECT type FROM requests WHERE id=%s", (str(rid),))
                rr = cur.fetchone()
                rtype = rr["type"] if rr else None
        if rtype == "task":
            return {
                "bucket": _DRAIN_NEW_WORK,
                "task_id": None,
            }  # a TASK request → accept/reject seam
        return {"bucket": _DRAIN_TASKLESS_ACTIONABLE, "task_id": None}
    if event_name == "task_assigned":
        tid = payload.get("task_id")
        st = _drain_task_status(cur, tid)
        if st == "ready":
            return {"bucket": _DRAIN_NEW_WORK, "task_id": str(tid)}
        if st == "in_progress":
            return {"bucket": _DRAIN_DIRECTIVE, "task_id": str(tid)}
        return {
            "bucket": _DRAIN_FYI,
            "task_id": None,
        }  # pending/terminal/gone → informational
    if event_name == "task_ready":
        if target_id is None:
            return {
                "bucket": _DRAIN_FYI,
                "task_id": None,
            }  # container-wide availability ping
        tid = payload.get("task_id")
        st = _drain_task_status(cur, tid)
        if st in (None, "completed", "cancelled"):
            return {"bucket": _DRAIN_FYI, "task_id": None}
        return {
            "bucket": _DRAIN_NEW_WORK,
            "task_id": str(tid),
        }  # assigned+targeted readiness → claim
    if event_name == "task_verified":
        if payload.get("approved") is False:
            return {
                "bucket": _DRAIN_DIRECTIVE,
                "task_id": payload.get("task_id"),
            }  # rework directive
        return {"bucket": _DRAIN_FYI, "task_id": None}
    if event_name == "decision_made":
        st, sid = payload.get("subject_type"), payload.get("subject_id")
        if (
            st == "plan_approval"
            and sid
            and _drain_task_status(cur, sid) not in (None, "completed", "cancelled")
        ):
            return {"bucket": _DRAIN_TASK_BOUND, "task_id": str(sid)}
        return {
            "bucket": _DRAIN_FYI,
            "task_id": None,
        }  # task_close / request / checkpoint / dummy subject
    # task_unassigned, status_changed, request_closed/escalated, task_request_*, agent_suggested/-decided,
    # and any unknown event_name (graceful degrade) → FYI: any awake run may ack it.
    return {"bucket": _DRAIN_FYI, "task_id": None}
