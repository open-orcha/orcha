"""Arbitrate drain-sidecar, work-yield, auto-wake, and idle resident transitions."""

from __future__ import annotations

import time


def _finish_sidecar(api_base, resident, sidecar, *, quiet, services) -> None:
    """Reap one finished or expired sidecar without releasing the resident lease."""
    proc = sidecar.get("proc")
    natural = proc is not None and proc.poll() is not None
    done = proc is None or natural
    if not done and time.time() > sidecar.get("hard_deadline", time.time()):
        services._kill_worker(proc, graceful=True)
        done = True
        if not quiet:
            print(
                f"[notifier] resident {resident.get('alias')} drain sidecar "
                f"(pid {getattr(proc, 'pid', None)}) exceeded its hard cap — killed; "
                "warm resident + lease KEPT, cursor NOT advanced (#247 B3)"
            )
    if not done:
        return

    success = natural and proc.returncode == 0
    ackable_ids = sidecar.get("ackable_ids") or []
    # I4: no run row to stamp (by design), so reap the sidecar's sandbox
    # container + api-config directly on completion — it is label-exempt
    # from the orphan pass, so nothing else would ever remove it.
    services._reap_sandbox_artifacts(sidecar)
    resident["sidecar"] = None
    if success:
        services._post_json(
            f"{api_base}/api/agents/{resident['agent_id']}/events/ack-handled",
            {"event_ids": ackable_ids},
        )
        if not quiet:
            print(
                f"[notifier] resident {resident.get('alias')} drain sidecar finished — "
                f"{len(ackable_ids)} event(s) acked-handled; warm conversation kept"
            )
    elif not quiet:
        print(
            f"[notifier] resident {resident.get('alias')} drain sidecar ended without "
            "a clean completion — cursor NOT advanced"
        )


def _yield_for_work(api_base, conv_id, resident, live_residents, *, reason, quiet, services) -> None:
    if not quiet:
        print(
            f"[notifier] resident {resident.get('alias')} {reason} — yielding the "
            "conversation lease for an isolated work worker"
        )
    services._close_resident(api_base, resident, reason="inbox_drain_yield")
    services._retire_resident(api_base, live_residents, conv_id)


def _maybe_drain_inbox(
    api_base,
    conv_id,
    resident,
    candidate,
    live_residents,
    *,
    pending,
    quiet,
    dry_run,
    services,
) -> bool:
    """Handle a drainable work backlog; return whether this tick was consumed."""
    inbox = (candidate or {}).get("pending_inbox", 0) or 0
    ack_ts = (candidate or {}).get("inbox_ack_ts")
    drainable = (candidate or {}).get("drainable_inbox")
    if drainable is None:
        drainable = inbox
    taskbound = (candidate or {}).get("drain_taskbound", 0) or 0
    previous = services._RESIDENT_DRAIN_YIELD.get(conv_id)
    stalled = (
        ack_ts is not None
        and previous is not None
        and previous[0] is not None
        and ack_ts <= previous[0]
        and time.time() - previous[1] < services.RESIDENT_DRAIN_COOLDOWN_SECS
    )
    should_drain = (
        services.RESIDENT_WORK_TEARDOWN_ENABLED
        and not resident.get("awaiting_result")
        and not pending
        and drainable > 0
        and not stalled
    )
    if not should_drain:
        return False

    if (candidate or {}).get("inbox_wake_task_id"):
        if not quiet:
            print(
                f"[notifier] resident {resident.get('alias')} has task-thread work "
                "queued — leaving it for the work worker; warm conversation kept"
            )
        return True
    if taskbound > 0:
        _yield_for_work(
            api_base,
            conv_id,
            resident,
            live_residents,
            reason=f"has {taskbound} protocol-bound inbox row(s)",
            quiet=quiet,
            services=services,
        )
        return True

    services._RESIDENT_DRAIN_YIELD[conv_id] = (ack_ts, time.time())
    spawned = services._spawn_drain_sidecar(
        api_base,
        resident,
        inbox,
        messages=(candidate or {}).get("inbox_messages"),
        ack_ts=ack_ts,
        ackable_ids=(candidate or {}).get("drain_ackable_ids") or [],
        model=(candidate or {}).get("model"),
        reasoning_effort=(candidate or {}).get("reasoning_effort"),
        dry_run=dry_run,
        quiet=quiet,
    )
    if not spawned:
        _yield_for_work(
            api_base,
            conv_id,
            resident,
            live_residents,
            reason="could not start its isolated drain sidecar",
            quiet=quiet,
            services=services,
        )
    return True


def service_idle_resident(
    api_base,
    conv_id,
    resident,
    candidate,
    live_residents,
    renew,
    pending,
    *,
    quiet=False,
    dry_run=False,
    services,
) -> None:
    """Apply the final idle-state transition for one live Claude resident."""
    sidecar = resident.get("sidecar")
    if sidecar is not None:
        _finish_sidecar(api_base, resident, sidecar, quiet=quiet, services=services)
        return

    if _maybe_drain_inbox(
        api_base,
        conv_id,
        resident,
        candidate,
        live_residents,
        pending=pending,
        quiet=quiet,
        dry_run=dry_run,
        services=services,
    ):
        return

    auto_wake_due = (
        services.RESIDENT_WORK_TEARDOWN_ENABLED
        and not resident.get("awaiting_result")
        and not pending
        and (candidate or {}).get("auto_wake_due")
    )
    if auto_wake_due:
        if not quiet:
            print(
                f"[notifier] resident {resident.get('alias')} idle + auto-wake due — "
                "yielding without resetting the clock"
            )
        services._close_resident(
            api_base, resident, reason="auto_wake_yield", stamp_woken=False
        )
        services._retire_resident(api_base, live_residents, conv_id)
        return

    is_idle = (
        not resident.get("awaiting_result")
        and not pending
        and time.time() - resident.get("last_activity_ts", 0)
        > services.RESIDENT_IDLE_REAP_SECS
    )
    if is_idle:
        services._close_resident(api_base, resident, reason="idle")
        services._retire_resident(api_base, live_residents, conv_id)
