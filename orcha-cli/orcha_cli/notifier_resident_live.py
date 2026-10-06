"""Advance one already-running resident through a single lifecycle transition."""

from __future__ import annotations

import time

from . import notifier_resident_turn as _turn
from .notifier_routing_handoff import (
    capture_stopped_checkout_diff,
    record_stopped_checkout_snapshot,
    stopped_snapshot_requires_retry,
)


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
    retry_close = resident.get("snapshot_retry_close")
    if isinstance(retry_close, dict):
        if services._close_resident(
            api_base,
            resident,
            reason=retry_close.get("reason", "snapshot_retry"),
            teardown_worktree=bool(
                retry_close.get("teardown_worktree", False)
            ),
            stamp_woken=bool(retry_close.get("stamp_woken", True)),
        ):
            _retire_after_close(
                services,
                api_base,
                conv_id,
                resident,
                live_residents,
                retry_close.get("reason"),
            )
        return

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
        if services._close_resident(
            api_base, resident, reason="runtime_changed"
        ):
            _retire_after_close(
                services, api_base, conv_id, resident,
                live_residents, "runtime_changed"
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
        if services._close_resident(
            api_base, resident, reason="model_changed"
        ):
            _retire_after_close(
                services, api_base, conv_id, resident,
                live_residents, "model_changed"
            )
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
        closed = services._close_resident(
            api_base,
            resident,
            reason="conversation_ended",
            teardown_worktree=True,
        )
        if closed:
            _retire_after_close(
                services, api_base, conv_id, resident,
                live_residents, "conversation_ended"
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
            live_residents=live_residents,
        )
        if conv_id not in live_residents:
            # capture_result retired this resident (warm resume produced an
            # empty result — sandbox-continuity fix). Next tick boots FRESH.
            return
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
            # Stop the writer before claiming an immutable stopped-run view.
            services._kill_worker(process, graceful=True)
            snapshot = record_stopped_checkout_snapshot(
                resident,
                resident["agent_id"],
                services,
                api_base=api_base,
            )
            if stopped_snapshot_requires_retry(snapshot):
                resident["snapshot_retry_pending"] = snapshot.code
                return
            resident.pop("snapshot_retry_pending", None)
            services._finish_run(
                api_base,
                resident["current_run_id"],
                "killed",
                -1,
                resident.get("log_path"),
                capture_stopped_checkout_diff(
                    snapshot,
                    resident.get("worktree") or resident.get("base_cwd"),
                    services,
                ),
            )
            resident["current_run_id"] = None
        if services._close_resident(api_base, resident, reason="hung"):
            _retire_after_close(
                services, api_base, conv_id, resident,
                live_residents, "hung"
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
        if services._close_resident(
            api_base, resident, reason="digest_resync"
        ):
            _retire_after_close(
                services, api_base, conv_id, resident,
                live_residents, "digest_resync"
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
        if services._close_resident(
            api_base, resident, reason="preempted"
        ):
            _retire_after_close(
                services, api_base, conv_id, resident,
                live_residents, "preempted"
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


def _retire_after_close(
    services,
    api_base,
    conv_id,
    resident,
    live_residents,
    reason,
) -> None:
    """Apply reason-specific state only after snapshot-backed close succeeds."""
    if reason == "model_changed":
        services._RESIDENT_RESUME_FAILED.add(conv_id)
    elif reason == "conversation_ended":
        services._RESIDENT_RESUME_FAILED.discard(conv_id)
        services._RESIDENT_DRAIN_YIELD.pop(conv_id, None)
    elif reason == "digest_resync":
        services._PERSONA_CACHE.pop(resident.get("agent_id"), None)
    services._retire_resident(api_base, live_residents, conv_id)


def _handle_exited(
    services, api_base, conv_id, resident, live_residents, quiet
) -> None:
    process = resident["proc"]
    if resident.get("checkout_activity") is not None and not resident.get(
        "current_run_id"
    ):
        if services._close_resident(
            api_base, resident, reason="exited", stamp_woken=False
        ):
            services._retire_resident(api_base, live_residents, conv_id)
        return
    finished = True
    if resident.get("current_run_id"):
        snapshot = record_stopped_checkout_snapshot(
            resident,
            resident["agent_id"],
            services,
            api_base=api_base,
        )
        if stopped_snapshot_requires_retry(snapshot):
            resident["snapshot_retry_pending"] = snapshot.code
            return
        resident.pop("snapshot_retry_pending", None)
        finished = services._finish_run(
            api_base,
            resident["current_run_id"],
            "killed",
            process.returncode,
            resident.get("log_path"),
            capture_stopped_checkout_diff(
                snapshot,
                resident.get("worktree") or resident.get("base_cwd"),
                services,
            ),
        )
    # I4 (resident lane): the docker client exited → the sandboxed session is
    # over; reap its container + api-config once the stamp landed (or when no
    # turn row was open). A failed stamp keeps the exited container as evidence
    # for the container-liveness sweep (I5). No-op for host mode.
    if finished:
        services._reap_sandbox_artifacts(resident)
    if not resident.get("cold") and (
        time.time() - resident.get("booted_ts", 0)
        < services.RESUME_FAIL_WINDOW_SECS
        # Sandbox-continuity fix: a sandboxed boot (docker pull/start latency)
        # can straggle past the died-fast window, so ALSO recognize claude's
        # explicit "No conversation found with session ID" line in this boot's
        # log slice — without it the next boot warm-resumes the same dead
        # session forever.
        or services._resume_error_in_log(
            resident.get("log_path"), resident.get("turn_scan_offset", 0)
        )
    ):
        services._RESIDENT_RESUME_FAILED.add(conv_id)
        if not quiet:
            print(
                f"[notifier] resident {resident.get('alias')} warm --resume "
                "failed (fast exit or no-conversation error) → dropping "
                "pinned session, next boot COLD (ISS-61)"
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
