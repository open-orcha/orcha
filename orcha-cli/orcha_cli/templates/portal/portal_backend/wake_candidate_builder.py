"""Build one notifier wake candidate from persisted agent and event state."""

from portal_backend.drain_classification import (
    _DRAIN_DIRECTIVE,
    _DRAIN_RUN_ACKABLE,
    _DRAIN_TASK_BOUND,
    _drain_class,
    _drain_task_status,
    _is_cross_task_drain_row,
)
from portal_backend.event_policy import _NON_WAKING_EVENTS, _WORK_NON_WAKING_EVENTS
from portal_backend.stale_wake_events import stale_pending_events
from portal_backend.model_policy import resolve_reasoning_effort
from portal_backend.self_wake_selection import select_due_self_wake
from portal_backend.wake_context import (
    filter_context_content,
    handled_event_id_sets as collect_handled_event_id_sets,
    parked_pending_events,
    resolve_context_task_id,
)
from portal_backend.wake_decision import decide_wake, triage_eligible
from portal_backend.wake_scan_queries import (
    WorkflowParking,
    continuable_run_id,
    has_pending_task_request,
    newest_answer_task_id,
    pending_event_summary,
    ready_task_ids,
    request_answer,
)


def build_wake_candidate(
    cur,
    agent,
    container_id,
    container_status,
    wakes_enabled,
    min_idle,
    *,
    collect_directed_messages,
    earliest_actionable_answer_ts,
    notification_manifest,
    triage_hint_for,
    valid_uuid,
    resolve_model,
    resolve_model_runtime,
):
    """Return the stable wake-scan contract for one AI agent."""
    aid = str(agent["id"])
    delivered_ts = agent["delivered_ts"]
    pending, max_ts, latest, latest_payload = pending_event_summary(
        cur, aid, delivered_ts, _WORK_NON_WAKING_EVENTS
    )
    # A Workflow task waiting for its turn (prerequisite, serial turn, hold, a worker
    # still running) cannot launch, and a refused launch ends the whole wake. It must
    # never be the wake's task. Its messages and decisions stay pending, unacknowledged,
    # and are delivered when its turn comes; until then they do not wake the agent.
    parking = WorkflowParking(cur, aid)
    ready = ready_task_ids(cur, aid, container_id)
    auto_tasks = [tid for tid in ready if not parking.parked(tid)]
    parked = set(ready) - set(auto_tasks)
    parked_rows = False
    obsolete = stale_pending_events(cur, aid, delivered_ts)
    held_event_ids = set(obsolete)
    if pending:
        parked_event_ids, parked_tasks, pending, newest = parked_pending_events(
            cur,
            aid,
            delivered_ts,
            non_waking_events=_WORK_NON_WAKING_EVENTS,
            drain_class=_drain_class,
            task_bound_bucket=_DRAIN_TASK_BOUND,
            directive_bucket=_DRAIN_DIRECTIVE,
            is_parked=parking.parked,
            skip_event_ids=held_event_ids,
        )
        held_event_ids |= parked_event_ids
        if held_event_ids:
            parked |= parked_tasks
            parked_rows = True
            latest, latest_payload = newest or (None, None)
    if pending:
        # Held rows are skipped before the prompt budget and the manifest limit; filtering
        # them afterwards would let a held backlog fill the batch and hide later work.
        directed, wake_task_id, ack_through_ts = collect_directed_messages(
            cur, aid, delivered_ts, max_ts, skip_event_ids=held_event_ids
        )
        directed = [
            m for m in directed if not (m["task_id"] and str(m["task_id"]) in parked)
        ]
        notifications, notifications_truncated = notification_manifest(
            cur, aid, delivered_ts, skip_event_ids=held_event_ids
        )
        notifications = [
            n
            for n in notifications
            if not (n.get("drain_task_id") and str(n["drain_task_id"]) in parked)
        ]
        if wake_task_id is None:
            wake_task_id = newest_answer_task_id(cur, aid, delivered_ts)
        if wake_task_id is not None and parking.parked(wake_task_id):
            wake_task_id = None
    else:
        directed, wake_task_id, ack_through_ts = [], None, max_ts
        notifications, notifications_truncated = [], False

    actionable_answer_ts = (
        earliest_actionable_answer_ts(cur, aid, delivered_ts) if pending else None
    )
    pending_task_request = has_pending_task_request(cur, aid)
    self_wake_due, self_wake_context, self_wake_task_id, wake_task_id = (
        select_due_self_wake(
            cur,
            aid,
            wake_task_id,
            auto_tasks=auto_tasks,
            pending_task_request=pending_task_request,
            valid_uuid=valid_uuid,
        )
    )
    if wake_task_id is not None and parking.parked(wake_task_id):
        wake_task_id = None
    initial_task_id = auto_tasks[0] if auto_tasks else wake_task_id
    context_task_id = resolve_context_task_id(
        cur,
        aid,
        delivered_ts,
        ack_through_ts,
        initial_task_id=initial_task_id,
        pending=pending,
        non_waking_events=_NON_WAKING_EVENTS,
        drain_class=_drain_class,
        drain_task_status=_drain_task_status,
        task_bound_bucket=_DRAIN_TASK_BOUND,
        directive_bucket=_DRAIN_DIRECTIVE,
        parked_task_ids=parked,
    )
    prompt_messages, notifications = filter_context_content(
        directed,
        notifications,
        context_task_id,
        is_cross_task=_is_cross_task_drain_row,
    )
    handled_event_ids, delivery_handled_event_ids = collect_handled_event_id_sets(
        cur,
        aid,
        delivered_ts,
        ack_through_ts,
        pending=pending,
        context_task_id=context_task_id,
        non_waking_events=_WORK_NON_WAKING_EVENTS,
        drain_class=_drain_class,
        run_ackable_buckets=_DRAIN_RUN_ACKABLE,
        task_bound_bucket=_DRAIN_TASK_BOUND,
        directive_bucket=_DRAIN_DIRECTIVE,
    )

    # Remaining obsolete rows wait for a bounded, audited daemon or explicit recovery batch.
    handled_event_ids = [eid for eid in handled_event_ids if eid not in obsolete]
    delivery_handled_event_ids = [eid for eid in delivery_handled_event_ids if eid not in obsolete]

    auto_interval = agent["auto_wake_interval_secs"]
    wake_enabled = agent["wake_enabled"]
    in_cooldown = bool(agent["in_cooldown"])
    lease_active = bool(agent["lease_active"])
    lease_kind = agent["lease_kind"]
    embodiment_running = bool(agent["embodiment_running"])
    auto_wake_due, should_wake, reason = decide_wake(
        container_status=container_status,
        wakes_enabled=wakes_enabled,
        agent_wake_enabled=wake_enabled,
        pending=pending,
        latest=latest,
        notifications=notifications,
        auto_tasks=auto_tasks,
        auto_interval=auto_interval,
        secs_since_woken=agent["secs_since_woken"],
        pending_task_request=pending_task_request,
        self_wake_due=self_wake_due,
        work_idle_seconds=agent["work_idle_seconds"],
        min_idle=min_idle,
        in_cooldown=in_cooldown,
        lease_active=lease_active,
        lease_kind=lease_kind,
        embodiment_running=embodiment_running,
        embodiment_silent_seconds=agent.get("embodiment_silent_seconds"),
    )
    triage_hint = None
    # A triage close advances the delivery cursor past every row it saw, which would skip
    # a parked task's held rows; with any held, the wake takes the full path instead.
    if not parked_rows and triage_eligible(
        should_wake=should_wake,
        pending_task_request=pending_task_request,
        self_wake_due=self_wake_due,
        pending=pending,
        auto_tasks=auto_tasks,
        wake_task_id=wake_task_id,
        prompt_messages=prompt_messages,
        latest=latest,
        actionable_answer_ts=actionable_answer_ts,
    ):
        triage_hint = triage_hint_for(
            latest,
            latest_payload,
            full_answer=request_answer(cur, latest, latest_payload),
        )

    resolved_model = resolve_model(agent["model"])
    launch_task_id = context_task_id
    if wake_task_id and _drain_task_status(cur, wake_task_id) in (None, "completed", "cancelled"):
        wake_task_id = None
    workflow_launch = {}
    task_autonomy = "off"
    task_autonomy_revision = 1
    if launch_task_id:
        cur.execute(
            """SELECT t.workflow_id,t.work_revision,t.autonomy,t.autonomy_revision,
                              w.revision AS workflow_revision
                       FROM tasks t LEFT JOIN workflows w ON w.id=t.workflow_id WHERE t.id=%s""",
            (launch_task_id,),
        )
        launch_task = cur.fetchone()
        if launch_task:
            task_autonomy = launch_task["autonomy"] or "off"
            task_autonomy_revision = launch_task["autonomy_revision"] or 1
        if launch_task and launch_task["workflow_id"]:
            workflow_launch = {
                "workflow_id": str(launch_task["workflow_id"]),
                "workflow_revision": launch_task["workflow_revision"],
                "workflow_work_revision": launch_task["work_revision"],
            }
            continue_run_id = continuable_run_id(cur, launch_task_id, aid)
            if continue_run_id:
                workflow_launch["workflow_continue_run_id"] = continue_run_id
    return {
        **workflow_launch,
        "agent_id": aid,
        "alias": agent["alias"],
        "should_wake": should_wake,
        "reason": reason,
        "pending_events": pending,
        "latest_event": latest,
        "prompt_messages": prompt_messages,
        "wake_task_id": wake_task_id,
        "notifications": notifications,
        "notifications_truncated": notifications_truncated,
        "max_event_ts": max_ts,
        "ack_through_ts": ack_through_ts,
        "handled_event_ids": handled_event_ids,
        "delivery_handled_event_ids": delivery_handled_event_ids,
        "context_task_id": context_task_id,
        "auto_start_task_ids": auto_tasks,
        "auto_wake_due": auto_wake_due,
        "auto_wake_interval_secs": auto_interval,
        "self_wake_due": self_wake_due,
        "self_wake_context": self_wake_context,
        "self_wake_task_id": self_wake_task_id,
        "self_wake_injected": bool(self_wake_due and self_wake_task_id == wake_task_id),
        "triage_hint": triage_hint,
        "actionable_answer_pending": actionable_answer_ts is not None,
        "wake_enabled": wake_enabled,
        "in_cooldown": in_cooldown,
        "lease_active": lease_active,
        "lease_kind": lease_kind,
        "embodiment_running": embodiment_running,
        "embodiment_silent_seconds": agent.get("embodiment_silent_seconds"),
        "has_pending_task_request": pending_task_request,
        "conv_lease_active": bool(agent["conv_lease_active"]),
        "conv_embodiment_running": bool(agent["conv_embodiment_running"]),
        "work_idle_seconds": agent["work_idle_seconds"],
        "idle_seconds": agent["idle_seconds"],
        "tmux_target": agent["tmux_target"],
        "headless_cwd": agent["headless_cwd"],
        "headless_flags": agent["headless_flags"],
        "model": resolved_model,
        "model_runtime": resolve_model_runtime(resolved_model),
        "reasoning_effort": resolve_reasoning_effort(
            agent["reasoning_effort"], resolved_model
        ),
        "task_autonomy": task_autonomy,
        "task_autonomy_revision": task_autonomy_revision,
    }
