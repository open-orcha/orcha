"""Advance one already-running resident through a single lifecycle transition."""

from __future__ import annotations

import time

from . import notifier_resident_turn as _turn


def advance_live_resident(
    services,
    api_base,
    conv_id,
    resident,
    candidate,
    active_ids,
    live_residents,
    *,
    quiet,
    dry_run,
) -> None:
    """Capture results, renew leases, and arbitrate stop or idle transitions."""
    process = resident["proc"]
    desired_runtime = (
        services._normalize_runtime(candidate.get("model_runtime"))
        if candidate and candidate.get("model_runtime")
        else None
    )
    if (
        desired_runtime is not None
        and desired_runtime != services._resident_runtime(resident)
        and not resident.get("awaiting_result")
    ):
        if not quiet:
            print(
                f"[notifier] resident {resident.get('alias')} runtime changed "
                f"{services._resident_runtime(resident)}→{desired_runtime} — "
                "releasing old resident lease"
            )
        services._close_resident(
            api_base, resident, reason="runtime_changed"
        )
        services._retire_resident(
            api_base, live_residents, conv_id
        )
        return

    desired_model = candidate.get("model") if candidate else None
    if (
        services._resident_runtime(resident) == services.RUNTIME_CLAUDE
        and desired_model is not None
        and resident.get("model") is not None
        and desired_model != resident.get("model")
        and not resident.get("awaiting_result")
    ):
        if not quiet:
            print(
                f"[notifier] resident {resident.get('alias')} model changed "
                f"{resident.get('model')}→{desired_model} — recycling for "
                "cold reboot (GH#88)"
            )
        services._RESIDENT_RESUME_FAILED.add(conv_id)
        services._close_resident(
            api_base, resident, reason="model_changed"
        )
        live_residents.pop(conv_id, None)
        return

    if services._resident_runtime(resident) == services.RUNTIME_CODEX:
        services._resident_codex.advance_codex_resident(
            services,
            api_base,
            conv_id,
            resident,
            live_residents,
            active_ids,
            quiet=quiet,
        )
        return
    if process.poll() is not None:
        _handle_exited(
            services,
            api_base,
            conv_id,
            resident,
            live_residents,
            quiet,
        )
        return
    if conv_id not in active_ids:
        services._close_resident(
            api_base,
            resident,
            reason="conversation_ended",
            teardown_worktree=True,
        )
        services._RESIDENT_RESUME_FAILED.discard(conv_id)
        services._RESIDENT_DRAIN_YIELD.pop(conv_id, None)
        services._retire_resident(
            api_base, live_residents, conv_id
        )
        return

    if resident.get("awaiting_result"):
        _turn.capture_result(
            services,
            api_base,
            conv_id,
            resident,
            candidate,
            quiet,
        )
    if (
        resident.get("awaiting_result")
        and time.time() - resident.get("awaiting_since", 0)
        > services.HARD_CAP_MIN_SECS
    ):
        if not quiet:
            print(
                f"[notifier] resident {resident.get('alias')} HUNG awaiting "
                f"result >{services.HARD_CAP_MIN_SECS:.0f}s — reaping + "
                "releasing lease (ISS-60)"
            )
        if resident.get("current_run_id"):
            services._finish_run(
                api_base,
                resident["current_run_id"],
                "killed",
                -1,
                resident.get("log_path"),
            )
            resident["current_run_id"] = None
        services._close_resident(api_base, resident, reason="hung")
        services._retire_resident(
            api_base, live_residents, conv_id
        )
        return

    renew = services._post_json(
        f"{api_base}/api/agents/{resident['agent_id']}/wake-renew",
        {
            "lease_ttl": services.WAKE_LEASE_TTL_SECS,
            "lane": "conversation",
        },
    )
    if _turn.stop_requested(renew, resident):
        _turn.stop_turn(
            services,
            api_base,
            conv_id,
            resident,
            live_residents,
            renew,
            quiet,
        )
        return

    pending = bool(
        candidate
        and candidate.get("pending_human")
        and candidate.get("last_turn_seq", 0)
        > resident.get("serviced_seq", 0)
    )
    if (
        pending
        and (candidate or {}).get("cold_required")
        and not resident.get("awaiting_result")
    ):
        if not quiet:
            print(
                f"[notifier] resident {resident.get('alias')} has a newer "
                "digest than its pinned session — checkpointing and "
                "cold-restarting before the next turn (#222)"
            )
        services._PERSONA_CACHE.pop(resident.get("agent_id"), None)
        services._close_resident(
            api_base, resident, reason="digest_resync"
        )
        services._retire_resident(
            api_base, live_residents, conv_id
        )
        return
    if (
        renew
        and renew.get("preempt_requested")
        and not resident.get("awaiting_result")
        and not pending
    ):
        if not quiet:
            print(
                f"[notifier] resident {resident.get('alias')} YIELDING to a "
                "live terminal (preempt=1, idle) — snapshot + release lease "
                "(ISS-69b)"
            )
        services._close_resident(
            api_base, resident, reason="preempted"
        )
        services._retire_resident(
            api_base, live_residents, conv_id
        )
        return
    services._resident_idle.service_idle_resident(
        api_base,
        conv_id,
        resident,
        candidate,
        live_residents,
        renew,
        pending,
        quiet=quiet,
        dry_run=dry_run,
        services=services,
    )


def _handle_exited(
    services, api_base, conv_id, resident, live_residents, quiet
) -> None:
    process = resident["proc"]
    if resident.get("current_run_id"):
        services._finish_run(
            api_base,
            resident["current_run_id"],
            "killed",
            process.returncode,
            resident.get("log_path"),
        )
    if (
        not resident.get("cold")
        and time.time() - resident.get("booted_ts", 0)
        < services.RESUME_FAIL_WINDOW_SECS
    ):
        services._RESIDENT_RESUME_FAILED.add(conv_id)
        if not quiet:
            print(
                f"[notifier] resident {resident.get('alias')} warm --resume "
                "failed fast → next boot COLD (ISS-61)"
            )
    services._post_json(
        f"{api_base}/api/agents/{resident['agent_id']}/wake-ack",
        {
            "kind": "resident_exited",
            "release_lease": True,
            "lane": "conversation",
        },
    )
    services._retire_resident(api_base, live_residents, conv_id)
