"""One read-only workflow admission/progress/display predicate.

The runtime adapter supplies availability from its authoritative budget, lane and
capacity checks. Absence is denial, never assumed availability. Reservation writes
must re-read this snapshot under graph -> workflow -> task locks.
"""

from datetime import datetime, timedelta, timezone

LIVE_EXECUTIONS = frozenset(
    {"reserved", "running", "awaiting_review", "stopping", "recovery_needed"}
)
OWNER_GATES = frozenset(
    {"changes_requested", "stopped_by_owner", "worker_released", "evidence_withdrawn"}
)
STOP_WARNING = (
    "Released without stop confirmation: the worker may still be running outside Orcha."
)



LOOP_WAIT_LABELS = {
    "limit_reached": "Accepted · round limit reached, waiting for the owner",
    "stalled": "Accepted · loop stalled, waiting for the owner",
    "missing_outcome": "Accepted · no outcome reported, waiting for the owner",
    "ask_owner": "Accepted · waiting for the owner to choose what happens next",
}

def _time(value):
    if value is None:
        return None
    if isinstance(value, str):
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value


def worker_ended_unconfirmed(execution):
    """A running turn whose run has ended but no runner ever confirmed the process exit.

    ``run_ended_at`` is joined from worker_runs by the loaders. Normally the notifier
    confirms the exit within seconds; this stays true only when no notifier can (for
    example the worker's pid was never recorded), so the owner needs a way out.
    """
    return bool(
        execution.get("run_ended_at")
        and not execution.get("worker_stopped_at")
        and execution["state"] in {"reserved", "running"}
    )


def release_deadline(execution):
    """The same later-of clock is used by both the label and the release action.

    The clock starts at a stop request, or (task 4dab637d) when the run ended
    without a confirmed exit; either way 30 quiet minutes are required, so a worker
    that may still be running is never released early.
    """
    if execution["state"] == "stopping":
        first = _time(execution.get("first_stop_at"))
    elif worker_ended_unconfirmed(execution):
        first = _time(execution.get("run_ended_at"))
    else:
        first = None
    if first is None:
        return None
    contact = _time(execution.get("last_runner_contact_at"))
    return max(first, contact or first) + timedelta(minutes=30)


def accepted(task, acceptances):
    a = acceptances.get(task["id"])
    return bool(
        task["status"] == "completed"
        and a
        and a["work_revision"] == task["work_revision"]
        and a.get("evidence_valid", False)
        and (
            a.get("actor_kind") == "human"
            or (a.get("actor_kind") == "ai" and a.get("autonomy_at_acceptance") == "on")
        )
    )


def satisfied(task, acceptances):
    """A prerequisite lets its dependents proceed: accepted, and no loop decision is
    pending on its outcome (limit, stall, missing outcome, ask the owner)."""
    return accepted(task, acceptances) and not task.get("awaiting_loop_decision")


def waiting_on(task, dependencies, tasks, acceptances):
    """Prerequisites a task still waits for. A prerequisite an earlier outcome did not
    select is skipped while another prerequisite is still selected (a branch that joins
    back); a task whose prerequisites were all unselected is itself marked unselected."""
    prerequisites = [p for p in dependencies.get(task["id"], ()) if p in tasks]
    selected = [p for p in prerequisites if tasks[p].get("route_state") != "not_selected"]
    return [p for p in (selected or prerequisites) if not satisfied(tasks[p], acceptances)]


def _effective_waiting_on(workflow, task, dependencies, tasks, acceptances):
    """Prerequisites still owed after the one explicit handoff bridge.

    A captured same-round review handoff is proof that the source worker has handed
    the exact draft to the group's reviewer.  It satisfies only that direct
    source-to-review prerequisite while the review turn is current; it is not a task
    acceptance and it never clears an outside prerequisite or a hold.
    """
    waiting = waiting_on(task, dependencies, tasks, acceptances)
    if (
        workflow
        and str(task["id"]) == str(workflow.get("review_handoff_target"))
        and workflow.get("review_handoff_prerequisite") is not None
    ):
        waived = str(workflow["review_handoff_prerequisite"])
        waiting = [tid for tid in waiting if str(tid) != waived]
    return waiting


def stored_status(
    task,
    dependencies,
    tasks,
    acceptances,
    outside_evidence=None,
    *,
    workflow=None,
):
    """Recompute waiting states without dropping ANY hold or owner decision.

    Running, terminal and review states are changed by lifecycle actions, never by a
    readiness refresh. Admitted outside evidence may keep an owner gate while in review.
    """
    if task.get("withdrawn_at") or task["status"] in {
        "completed",
        "cancelled",
        "in_progress",
        "needs_verification",
    }:
        return task["status"]
    if (
        task.get("preparation_state") != "prepared"
        or task.get("route_state") == "not_selected"
        or task.get("start_hold")
        or task.get("human_hold_by")
        or task.get("awaiting_owner_decision")
        or (workflow and workflow.get("paused_group_tasks", {}).get(task["id"]))
    ):
        return "not_ready"
    return (
        "pending"
        if _effective_waiting_on(workflow, task, dependencies, tasks, acceptances)
        else "ready"
    )


def _base_blockers(
    workflow,
    task,
    tasks,
    dependencies,
    acceptances,
    executions,
    outside_evidence,
    availability,
    source_kind,
):
    blockers = []

    def add(code, message):
        blockers.append({"code": code, "message": message, "task_id": task["id"]})

    if workflow.get("container_status") != "active":
        add("project_not_active", "The project is not active.")
    if workflow["status"] != "active":
        add("workflow_not_active", "The workflow is not active.")
    if not workflow["launch_enabled"]:
        add("workflow_not_started", "Waiting for the owner to Start the workflow.")
    if not workflow.get("owner_live", False):
        add("owner_unavailable", "A project owner must restore workflow ownership.")
    if task.get("withdrawn_at") or task["status"] in {
        "completed",
        "cancelled",
        "in_progress",
        "needs_verification",
    }:
        add("task_not_waiting", "This task is not waiting to take a turn.")
    if task.get("preparation_state") != "prepared":
        add("task_draft", "Prepare this task first.")
    if task.get("start_hold"):
        add("start_hold", "The owner has not released this task.")
    if task.get("human_hold_by"):
        add("human_hold", "This task is on hold.")
    if source_kind == "worker" and task.get("awaiting_owner_decision"):
        add("owner_decision", "This task is waiting for the owner to decide.")
    evidence = outside_evidence.get(task["id"])
    if source_kind == "worker" and evidence:
        add("owner_evidence_pending", "An outside result is waiting for review.")
    if source_kind == "evidence_review" and (
        not evidence or evidence["state"] != "pending"
    ):
        add("no_pending_evidence", "There is no outside result waiting for review.")
    elif source_kind == "evidence_review" and (
        evidence.get("work_revision") != task.get("work_revision")
    ):
        # Submitted before the task's criteria or prerequisites were edited.
        add(
            "evidence_version_stale",
            "The outside result is for an older version of this task; withdraw it and submit again.",
        )
    prerequisites = dependencies.get(task["id"], ())
    if len(prerequisites) > 3 or any(p not in tasks for p in prerequisites):
        add("invalid_graph", "The prerequisite graph needs repair.")
    else:
        waiting = _effective_waiting_on(
            workflow, task, dependencies, tasks, acceptances
        )
    if len(prerequisites) <= 3 and all(p in tasks for p in prerequisites) and waiting:
        names = [
            tasks[p]["title"] for p in waiting
        ]
        add("prerequisites", "Waiting for " + ", ".join(names) + ".")
    if task.get("route_state") == "not_selected":
        add("not_selected", "An earlier step's outcome did not select this step.")
    if workflow.get("semantics_version", 1) == 2:
        if not workflow.get("flexible_enabled", True):
            add(
                "flexible_unsupported",
                "This workflow uses outcomes and loops, which are turned off on this server.",
            )
        paused = workflow.get("paused_group_tasks", {}).get(task["id"])
        if paused:
            add("group_paused", paused)
        if source_kind == "worker" and workflow.get("turns_used", 0) >= workflow.get(
            "turn_allowance", 40
        ):
            add(
                "allowance_exhausted",
                "This run used its turn allowance; the owner can raise it.",
            )
    if any(
        e["task_id"] == task["id"] and e["state"] in LIVE_EXECUTIONS for e in executions
    ):
        add("reservation_live", "The previous turn has not been released.")
    handoff_target = workflow.get("review_handoff_target")
    if handoff_target and str(task['id']) != str(handoff_target):
        add('review_handoff', 'Waiting for the current review or correction turn.')
    if workflow.get("limit_reached"):
        add("limit_reached", "Limit reached — no new starts.")
    if source_kind == "worker":
        gate = availability.get(
            task["id"],
            {"available": False, "reason": "Worker availability has not been checked."},
        )
        if not gate.get("available"):
            add(
                "worker_unavailable",
                gate.get("reason") or "The assigned worker is unavailable.",
            )
    return blockers


def workflow_eligibility(
    workflow,
    tasks,
    dependencies,
    acceptances,
    executions,
    outside_evidence,
    availability,
):
    """Return per-task eligibility, including fairness for runnable exclusive work."""
    base = {}
    for tid, task in tasks.items():
        kind = "evidence_review" if outside_evidence.get(tid) else "worker"
        base[tid] = (
            kind,
            _base_blockers(
                workflow,
                task,
                tasks,
                dependencies,
                acceptances,
                executions,
                outside_evidence,
                availability,
                kind,
            ),
        )
    order = sorted(
        tasks,
        key=lambda tid: (tasks[tid]["priority"], str(tasks[tid]["created_at"]), tid),
    )
    eligible = [tid for tid in order if not base[tid][1]]
    exclusive = [tid for tid in eligible if dependencies.get(tid)]
    live = [e for e in executions if e["state"] in LIVE_EXECUTIONS]
    result = {}
    for tid in order:
        kind, reasons = base[tid]
        reasons = list(reasons)
        message = None
        if not reasons:
            if workflow["execution_mode"] == "serial":
                if live or (eligible and tid != eligible[0]):
                    message = (
                        "Waiting for its turn; this workflow runs one task at a time."
                    )
            elif dependencies.get(tid):
                if live or (exclusive and tid != exclusive[0]):
                    message = "This task needs a turn alone."
            elif any(e.get("exclusive") for e in live) or exclusive:
                message = "Waiting for a task that needs a turn alone."
        if message:
            reasons.append(
                {"code": "workflow_turn", "message": message, "task_id": tid}
            )
        result[tid] = {
            "can_start": not reasons,
            "source_kind": kind,
            "exclusive": workflow["execution_mode"] == "serial"
            or bool(dependencies.get(tid)),
            "blockers": reasons,
        }
    return result


def task_display(
    task,
    execution=None,
    evidence=None,
    *,
    now=None,
    names=None,
    launch_enabled=True,
    waiting_on=(),
    evidence_reason=None,
    lost_release=False,
    workflow_open=True,
):
    """One label for every surface (plan §14.1 map, §16.3, §17.3).

    ``names`` maps agent id to display name; ``waiting_on`` lists the
    (title, status) of prerequisites not yet accepted; ``lost_release`` is
    true when any attempt of this task was released without stop
    confirmation, which keeps the inspector warning permanently.
    """
    names = names or {}
    now = _time(now) or datetime.now(timezone.utc)
    gate_labels = {
        "changes_requested": "Changes requested · owner decides",
        "stopped_by_owner": "Stopped by owner · owner decides",
        "worker_released": "Worker released · owner decides",
        "evidence_withdrawn": "Outside result withdrawn · owner decides",
    }
    gate = task.get("awaiting_owner_decision")
    label = gate_labels.get(
        gate,
        {
            "completed": "Accepted",
            "cancelled": "Cancelled",
            "pending": (
                "Waiting for "
                + ", ".join(title for title, _ in waiting_on)
                + (
                    " to succeed"
                    if any(status == "cancelled" for _, status in waiting_on)
                    else ""
                )
                if waiting_on
                else "Waiting for prerequisites"
            ),
            "ready": "Waiting for its turn",
            "in_progress": "Running",
            "needs_verification": "Awaiting review",
        }.get(task["status"], "Draft"),
    )
    if task.get("withdrawn_at"):
        label = "Withdrawn by " + names.get(task.get("withdrawn_by"), "the owner")
        if task.get("withdrawn_reason"):
            label += ": " + task["withdrawn_reason"]
    elif not gate and task["status"] == "not_ready":
        if task.get("preparation_state") == "draft":
            label = "Draft"
        elif task.get("start_hold") and not launch_enabled:
            label = "Prepared · waiting for Start"
        else:
            label = "Prepared · awaiting release"
        if task.get("human_hold_by"):
            label += " · on hold by " + names.get(task["human_hold_by"], "the owner")
    # Semantics version 2: a skipped branch and a loop waiting on its owner.
    if task.get("route_state") == "not_selected":
        label = "Not selected"
    elif task.get("awaiting_loop_decision") in LOOP_WAIT_LABELS:
        label = LOOP_WAIT_LABELS[task["awaiting_loop_decision"]]
    if evidence:
        label = (
            "Outside result awaiting review"
            if evidence["state"] == "admitted"
            else "Outside result waiting - " + (evidence_reason or "its turn")
        )
    deadline = release_deadline(execution) if execution else None
    available = bool(deadline and now >= deadline)
    warning = None
    if execution:
        state = execution["state"]
        if state == "stopping":
            outcome = {"completed": "accepted", "cancelled": "cancelled"}.get(
                task["status"],
                {
                    "changes_requested": "changes requested",
                    "stopped_by_owner": "stopped by owner",
                }.get(gate, "recovery needed"),
            )
            label = (
                ("Stop not confirmed" if available else "Stopping") + " - " + outcome
            )
        elif state == "recovery_needed":
            label = "Recovery needed"
        elif worker_ended_unconfirmed(execution):
            label = (
                "Worker ended, stop not confirmed - release available"
                if available
                else "Worker ended, stop not confirmed"
            )
        elif state == "reserved":
            label = "Starting"
    # §17.3: the inspector warning is permanent once any attempt was released
    # lost; the list mark lasts until a new attempt, withdrawal, or the
    # workflow is finished or cancelled.
    if lost_release or (execution and execution["state"] == "released_lost"):
        warning = STOP_WARNING
    list_warning = bool(
        execution
        and execution["state"] == "released_lost"
        and not task.get("withdrawn_at")
        and workflow_open
    )
    return {
        "label": label,
        "release_available": available,
        "release_available_at": deadline,
        "warning": warning,
        "list_warning": list_warning,
    }


def progress_and_completion(
    workflow, tasks, acceptances, executions, objectives, review_rounds
):
    counted = [
        t
        for t in tasks.values()
        if not t.get("withdrawn_at") and t.get("route_state") != "not_selected"
    ]
    n = sum(accepted(t, acceptances) for t in counted)
    total = len(counted)
    objectives_done = sum(
        o.get("accepted_revision") == o["revision"] and o.get("evidence_valid", False)
        for o in objectives
    )
    blockers = []

    def add(code, message):
        blockers.append({"code": code, "message": message})

    if workflow["status"] != "active" or workflow.get("container_status") != "active":
        add("workflow_not_active", "Resume the workflow and project before finishing.")
    if not workflow["launch_enabled"]:
        add("workflow_not_started", "Start the workflow before finishing.")
    if not total:
        add("no_tasks", "At least one required task must be accepted.")
    elif n != total:
        add(
            "tasks_unaccepted",
            "Every required task must have its current work accepted.",
        )
    if any(t.get("awaiting_loop_decision") for t in counted):
        add("loop_decision_pending", "Decide what happens next for the waiting loop or outcome.")
    if objectives_done != len(objectives):
        add("objectives_unaccepted", "Accept every current objective and its evidence.")
    if (
        workflow.get("goal_accepted_revision") != workflow["goal_revision"]
        or workflow.get("goal_accepted_scope_revision") != workflow["scope_revision"]
        or not workflow.get("goal_evidence_valid", False)
    ):
        add("goal_unaccepted", "Accept the current goal and its evidence.")
    if any(e["state"] in LIVE_EXECUTIONS for e in executions):
        add("reservation_live", "Wait for all task turns and workers to finish.")
    latest = {}
    for row in review_rounds:
        if (
            row["loop_key"] not in latest
            or row["round_number"] > latest[row["loop_key"]]["round_number"]
        ):
            latest[row["loop_key"]] = row
    if any(
        r.get("outcome") != "accepted" and not r.get("resolved_by_owner")
        for r in latest.values()
    ):
        add("review_loop_open", "Resolve the open review loops.")
    return (
        {
            "accepted": n,
            "total": total,
            "percent": n * 100 // total if total else None,
            "withdrawn": sum(1 for t in tasks.values() if t.get("withdrawn_at")),
            "objectives_accepted": objectives_done,
            "objectives_total": len(objectives),
        },
        {"can_finish": not blockers, "blockers": blockers},
    )
