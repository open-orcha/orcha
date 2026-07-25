"""Compute wake eligibility, explanation, and narrow triage eligibility."""


def decide_wake(
    *,
    container_status: str,
    wakes_enabled: bool,
    agent_wake_enabled: bool,
    pending: int,
    latest,
    notifications,
    auto_tasks,
    auto_interval,
    secs_since_woken,
    pending_task_request: bool,
    self_wake_due: bool,
    work_idle_seconds,
    min_idle: float,
    in_cooldown: bool,
    lease_active: bool,
    lease_kind,
    embodiment_running: bool,
):
    """Return scheduled-wake state, final verdict, and a human-readable reason."""
    auto_wake_due = bool(
        auto_interval is not None
        and (secs_since_woken is None or secs_since_woken >= auto_interval)
    )
    has_work = bool(
        pending or auto_tasks or auto_wake_due or pending_task_request or self_wake_due
    )
    is_idle = work_idle_seconds is None or work_idle_seconds >= min_idle
    active = container_status == "active"
    should_wake = bool(
        active
        and wakes_enabled
        and agent_wake_enabled
        and has_work
        and is_idle
        and not in_cooldown
        and not lease_active
        and not embodiment_running
    )
    if not active:
        reason = f"container {container_status} — wakes suppressed"
    elif not wakes_enabled:
        reason = "global wake kill-switch is OFF (wakes_enabled=false)"
    elif not agent_wake_enabled:
        reason = "wake disabled (opt-out)"
    elif lease_active:
        reason = {
            "resident": "a resident session is live (single-embodiment)",
            "live": "a live terminal session is held (single-embodiment) — events queue",
        }.get(lease_kind, "a worker is already live (single-flight lease held)")
    elif embodiment_running:
        reason = (
            "an embodiment is still running (single-embodiment) — lapsed-lease orphan"
        )
    elif not has_work:
        reason = "no pending events or ready tasks"
    elif not is_idle:
        reason = f"agent active (work idle {work_idle_seconds:.0f}s < {min_idle:.0f}s)"
    elif in_cooldown:
        reason = "within cooldown window"
    else:
        reasons = []
        if pending:
            top = notifications[0] if notifications else None
            if top:
                reasons.append(
                    f"{pending} event(s) "
                    f"(top=rank-{top['rank']} {top['type']}, latest={latest})"
                )
            else:
                reasons.append(f"{pending} event(s) (latest={latest})")
        if auto_tasks:
            reasons.append(f"{len(auto_tasks)} assigned ready task(s)")
        if pending_task_request:
            reasons.append("open task-request awaiting accept")
        if self_wake_due:
            reasons.append("self-scheduled task wake")
        if auto_wake_due:
            reasons.append(f"scheduled auto-wake (every {auto_interval}s)")
        reason = "wake: " + ", ".join(reasons)
    return auto_wake_due, should_wake, reason


def triage_eligible(
    *,
    should_wake: bool,
    pending_task_request: bool,
    self_wake_due: bool,
    pending: int,
    auto_tasks,
    wake_task_id,
    prompt_messages,
    latest,
    actionable_answer_ts,
) -> bool:
    """Return whether the sole wake signal is safe for cheap triage."""
    return bool(
        should_wake
        and not pending_task_request
        and not self_wake_due
        and pending == 1
        and not auto_tasks
        and not wake_task_id
        and not prompt_messages
        and latest
        and actionable_answer_ts is None
    )
