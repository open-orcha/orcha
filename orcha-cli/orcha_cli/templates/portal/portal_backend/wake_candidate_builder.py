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
from portal_backend.model_policy import resolve_reasoning_effort
from portal_backend.self_wake_selection import select_due_self_wake
from portal_backend.wake_context import (
    filter_context_content,
    handled_event_id_sets as collect_handled_event_id_sets,
    resolve_context_task_id,
)
from portal_backend.wake_decision import decide_wake, triage_eligible
from portal_backend.wake_scan_queries import (
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
    if pending:
        directed, wake_task_id, ack_through_ts = collect_directed_messages(
            cur, aid, delivered_ts, max_ts
        )
        notifications, notifications_truncated = notification_manifest(
            cur, aid, delivered_ts
        )
        if wake_task_id is None:
            wake_task_id = newest_answer_task_id(cur, aid, delivered_ts)
    else:
        directed, wake_task_id, ack_through_ts = [], None, max_ts
        notifications, notifications_truncated = [], False

    actionable_answer_ts = (
        earliest_actionable_answer_ts(cur, aid, delivered_ts) if pending else None
    )
    auto_tasks = ready_task_ids(cur, aid, container_id)
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
    )
    triage_hint = None
    if triage_eligible(
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

    return {
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
        "has_pending_task_request": pending_task_request,
        "conv_lease_active": bool(agent["conv_lease_active"]),
        "conv_embodiment_running": bool(agent["conv_embodiment_running"]),
        "work_idle_seconds": agent["work_idle_seconds"],
        "idle_seconds": agent["idle_seconds"],
        "tmux_target": agent["tmux_target"],
        "headless_cwd": agent["headless_cwd"],
        "headless_flags": agent["headless_flags"],
        "model": resolve_model(agent["model"]),
        "model_runtime": resolve_model_runtime(agent["model"]),
        "reasoning_effort": resolve_reasoning_effort(agent["reasoning_effort"]),
    }
