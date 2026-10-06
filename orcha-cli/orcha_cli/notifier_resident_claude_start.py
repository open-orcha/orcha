"""Boot or feed warm Claude residents for pending conversation turns."""

from __future__ import annotations

import pathlib
import time

from . import notifier_checkout_consent as _consent
from . import notifier_resident_claude_feed as _feed_service
from .notifier_checkout_activity import preserve_unregistered_writer
from .notifier_routing_handoff import (
    checkout_owner_key,
    prepare_checkout_start,
)


def start_or_feed_candidate(
    services,
    api_base,
    conv_id,
    candidate,
    live_residents,
    live_pids,
    *,
    base_cwd,
    quiet,
    dry_run,
) -> None:
    """Ensure a suitable resident exists, then send its next human turn."""
    resident = live_residents.get(conv_id)
    if resident is not None and (
        resident.get("snapshot_retry_pending")
        or resident.get("snapshot_retry_close")
    ):
        # The stopped resident remains the sole retry owner.  Do not pop it or
        # boot a replacement into another checkout until its exact snapshot is
        # durable and the original lease has been released.
        return
    if resident is not None and resident.get("awaiting_result"):
        return
    desired_worktree_routing = bool(candidate.get("worktrees_disabled"))
    routing_source_cwd = None
    if (
        resident is not None
        and bool(resident.get("worktrees_disabled", False)) != desired_worktree_routing
    ):
        # A project toggle applies to the next turn even when a warm resident exists.  Retire the
        # process/lease but preserve its old worktree exactly as-is; the replacement boots with the
        # newly selected routing below.
        routing_source_cwd = resident.get("worktree") or resident.get("base_cwd")
        closed = services._close_resident(
            api_base,
            resident,
            reason="worktree_routing_changed",
            teardown_worktree=False,
            stamp_woken=False,
        )
        if not closed:
            return
        live_residents.pop(conv_id, None)
        resident = None
    serviced = resident.get("serviced_seq", 0) if resident else 0
    if candidate.get("last_turn_seq", 0) <= serviced:
        return
    desired_model = candidate.get("model")
    if (
        resident is not None
        and services._resident_runtime(resident) == services.RUNTIME_CLAUDE
        and desired_model is not None
        and resident.get("model") is not None
        and desired_model != resident.get("model")
    ):
        if not quiet:
            print(
                f"[notifier] resident {resident.get('alias')} model changed "
                f"{resident.get('model')}→{desired_model} — recycling "
                "before feed (GH#88)"
            )
        closed = services._close_resident(
            api_base, resident, reason="model_changed"
        )
        if not closed:
            return
        services._RESIDENT_RESUME_FAILED.add(conv_id)
        live_residents.pop(conv_id, None)
        resident = None
    if resident is None:
        resident = _boot(
            services,
            api_base,
            conv_id,
            candidate,
            live_residents,
            live_pids,
            serviced,
            base_cwd=base_cwd,
            quiet=quiet,
            dry_run=dry_run,
            routing_source_cwd=routing_source_cwd,
        )
    if resident is not None:
        retained = _feed_service.feed(
            services,
            api_base,
            conv_id,
            candidate,
            resident,
        )
        if retained is False:
            services._retire_resident(api_base, live_residents, conv_id)


def _boot(
    services,
    api_base,
    conv_id,
    candidate,
    live_residents,
    live_pids,
    serviced,
    *,
    base_cwd,
    quiet,
    dry_run,
    routing_source_cwd=None,
):
    if not dry_run:
        services._reap_dead_pid_resident_runs(
            api_base,
            candidate["agent_id"],
            live_pids,
            quiet=quiet,
        )
    claim = (
        None
        if dry_run
        else services._post_json(
            f"{api_base}/api/agents/{candidate['agent_id']}/wake-claim",
            {
                "lease_ttl": services.WAKE_LEASE_TTL_SECS,
                "kind": "resident",
                "lease_kind": "resident",
            },
        )
    )
    if not (claim and claim.get("claimed")):
        if not quiet:
            print(
                f"[notifier] resident skip {candidate.get('agent_alias')} — "
                f"{(claim or {}).get('reason', 'claim failed')}"
            )
        return None
    session_id = candidate.get("session_id")
    cold = (
        not session_id
        or conv_id in services._RESIDENT_RESUME_FAILED
        or bool(candidate.get("cold_required"))
    )
    turns = (
        services._get_json(
            f"{api_base}/api/agents/{candidate['agent_id']}"
            "/conversation?limit=200"
        )
        or {}
    ).get("turns", [])
    resolved_through = _consent.resolved_through(turns)
    serviced = max(serviced, resolved_through)
    persona = (
        services._build_persona(
            api_base, candidate["agent_id"], lane="conversation"
        )
        if cold
        else None
    )
    if cold and services._format_history is not None:
        history = services._cold_boot_history(
            [
                turn
                for turn in turns
                if turn.get("seq", 0) <= resolved_through
            ]
        )
        if history:
            persona = (
                "\n\n".join(
                    part for part in (persona, history) if part
                )
                or None
            )
    log_path = services._resident_log_path(base_cwd, conv_id)
    existing = (
        log_path.stat().st_size
        if log_path and log_path.exists()
        else 0
    )
    worktrees_disabled = bool(candidate.get("worktrees_disabled"))
    in_git = not dry_run and services._is_git_repo(base_cwd)
    worktree, branch = (
        services._provision_resident_worktree(base_cwd, conv_id)
        if in_git and not worktrees_disabled
        else (None, None)
    )
    if in_git and not worktrees_disabled and worktree is None:
        if not quiet:
            print(
                f"[notifier] resident skip {candidate.get('agent_alias')} — "
                "worktree isolation failed (won't run in shared checkout)"
            )
        _release_failed(services, api_base, candidate)
        return None
    run_cwd = worktree or base_cwd or str(pathlib.Path.cwd())

    def _prepare():
        return prepare_checkout_start(
            api_base,
            candidate["agent_id"],
            run_cwd,
            services,
            shared_checkout=bool(in_git and worktree is None),
            source_cwd=routing_source_cwd,
            conversation_id=conv_id,
        )

    preparation = None if dry_run else _prepare()
    handoff = None if preparation is None else preparation.handoff
    if not dry_run and not handoff:
        # Ask the human (discard the old worktree, or re-enable worktrees) instead of
        # silently retrying every tick; retry the carry right away on consent.
        consented = False
        if getattr(handoff, "code", None) == "destination_has_independent_changes":
            consented = _consent.handle_carry_failure(
                services,
                api_base,
                conv_id,
                candidate,
                turns,
                base_cwd=base_cwd,
                quiet=quiet,
            )
        else:
            _consent.post_blocked_notice(
                services, api_base, conv_id, candidate, base_cwd, turns, handoff, quiet
            )
        if consented:
            preparation = _prepare()
            handoff = preparation.handoff
        if not (consented and preparation):
            _release_failed(services, api_base, candidate)
            if not quiet:
                print(
                    f"[notifier] resident skip {candidate.get('agent_alias')} — "
                    "saved files could not be carried into the selected checkout"
                )
            return None
    checkout_activity = (
        preparation.activity if preparation is not None else None
    )
    token = (
        None
        if dry_run
        else services._mint_embodiment_token(
            api_base,
            candidate["agent_id"],
            "conversation",
            "resident",
        )
    )
    _spawn_info: dict = {}
    sent, spawn_repr, process = services.spawn_resident(
        run_cwd,
        system_prompt=persona,
        log_path=log_path,
        resume_session_id=None if cold else session_id,
        alias=candidate.get("agent_alias"),
        model=candidate.get("model"),
        reasoning_effort=candidate.get("reasoning_effort"),
        runtime=candidate.get("model_runtime"),
        run_token=token,
        conversation=True,
        dry_run=dry_run,
        spawn_info=_spawn_info,
        checkout_activity=checkout_activity,
    )
    if not sent or process is None:
        if checkout_activity is not None:
            services._release_checkout_activity(
                run_cwd, activity=checkout_activity
            )
        # Issue #75: the box-wide concurrency cap deferred this resident boot (a
        # resident IS a sandbox container, counted against the same budget). Release
        # the claimed lease so the conversation re-competes on a later tick, but log it
        # as a cap-defer (expected back-pressure), NOT a loud spawn failure. A worktree
        # was provisioned above — teardown so a deferred boot leaves no orphan tree.
        if _spawn_info.get("deferred"):
            if worktree:
                services._safe_teardown_worktree(base_cwd, worktree, branch)
            if not quiet:
                print(
                    f"[notifier] cap-deferred resident boot for "
                    f"{candidate.get('agent_alias')}: {spawn_repr} — "
                    "stays eligible next tick"
                )
            services._revoke_or_defer(api_base, token)
            _release_failed(services, api_base, candidate)
            return None
        # Fail LOUD (spec §3.2): a sandbox-mode preflight/api-config failure
        # surfaces its "(sandbox unavailable: …)" reason here instead of the
        # conversation silently queueing forever.
        if not quiet:
            print(
                f"[notifier] resident skip {candidate.get('agent_alias')} — "
                f"spawn failed {spawn_repr}"
            )
        services._revoke_or_defer(api_base, token)
        _release_failed(services, api_base, candidate)
        return None
    if checkout_activity is not None:
        try:
            activity_bound = services._bind_checkout_activity(
                checkout_activity,
                pid=getattr(process, "pid", None),
                sandbox_container_id=_spawn_info.get("sandbox_container_id"),
            )
        except Exception:
            activity_bound = False
        if not activity_bound:
            services._kill_worker(process, graceful=True)
            preserve_unregistered_writer(
                api_base,
                services,
                cwd=run_cwd,
                owner_key=checkout_owner_key(
                    candidate["agent_id"],
                    conversation_id=conv_id,
                    lane="conversation",
                ),
                agent_id=candidate["agent_id"],
                activity=checkout_activity,
                identity=token or getattr(process, "pid", "unknown"),
            )
            services._reap_sandbox_artifacts(
                {
                    "sandbox_container_id": _spawn_info.get("sandbox_container_id"),
                    "base_cwd": base_cwd,
                }
            )
            services._revoke_or_defer(api_base, token)
            _release_failed(services, api_base, candidate)
            return None
    resident = {
        "runtime": services.RUNTIME_CLAUDE,
        "proc": process,
        "agent_id": candidate["agent_id"],
        "conversation_id": conv_id,
        "alias": candidate.get("agent_alias"),
        "log_path": log_path,
        "model": candidate.get("model"),
        "worktree": worktree,
        "branch": branch,
        "base_cwd": base_cwd,
        "worktrees_disabled": worktrees_disabled,
        "session_id": session_id,
        "session_pinned": not cold,
        "cold": cold,
        # Sandbox resident (remote-runner un-deferral): the warm session's ONE
        # container, threaded through the handle so every turn's run row records
        # it and the close/exit/stop paths can reap it (container + api-config).
        "sandbox_container_id": _spawn_info.get("sandbox_container_id"),
        "run_token": token,
        "checkout_activity": checkout_activity,
        "serviced_seq": serviced,
        "current_run_id": None,
        "run_id": None,
        "awaiting_result": False,
        "turn_scan_offset": existing,
        "lines_offset": existing,
        "lines_buf": b"",
        "lines_seq": 1,
        "booted_ts": time.time(),
        "last_activity_ts": time.time(),
    }
    live_residents[conv_id] = resident
    if cold:
        services._RESIDENT_RESUME_FAILED.discard(conv_id)
    return resident


def _release_failed(services, api_base, candidate) -> None:
    services._post_json(
        f"{api_base}/api/agents/{candidate['agent_id']}/wake-ack",
        {
            "kind": "resident_failed",
            "release_lease": True,
            "lane": "conversation",
        },
    )
