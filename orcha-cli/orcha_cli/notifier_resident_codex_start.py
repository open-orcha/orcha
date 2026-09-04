"""Start isolated one-shot Codex workers for pending conversation turns."""

from __future__ import annotations

import pathlib
import time


def start_candidate(
    services,
    api_base,
    conv_id,
    candidate,
    live_residents,
    *,
    base_cwd,
    quiet,
    dry_run,
) -> None:
    """Claim, launch, and register one pending Codex conversation turn."""
    if live_residents.get(conv_id) is not None:
        return
    turns = (
        services._get_json(
            f"{api_base}/api/agents/{candidate['agent_id']}"
            "/conversation?limit=200"
        )
        or {}
    ).get("turns", [])
    resolved_through = max(
        [
            turn["seq"]
            for turn in turns
            if turn.get("role") == "agent"
        ],
        default=0,
    )
    pending = [
        turn
        for turn in turns
        if turn.get("role") == "human"
        and turn.get("seq", 0) > resolved_through
    ]
    if not pending:
        return
    if dry_run:
        if not quiet:
            print(
                "[notifier] DRY-RUN would start Codex conversation worker "
                f"for {candidate.get('agent_alias')}"
            )
        return
    claim = services._post_json(
        f"{api_base}/api/agents/{candidate['agent_id']}/wake-claim",
        {
            "lease_ttl": services.WAKE_LEASE_TTL_SECS,
            "kind": "conversation",
            "event": "conversation_turn",
            "lease_kind": "ephemeral",
        },
    )
    if not (claim and claim.get("claimed")):
        if not quiet:
            print(
                "[notifier] Codex conversation skip "
                f"{candidate.get('agent_alias')} — "
                f"{(claim or {}).get('reason', 'claim failed')}"
            )
        return

    in_git = services._is_git_repo(base_cwd)
    worktree, branch = (
        services._provision_resident_worktree(base_cwd, conv_id)
        if in_git
        else (None, None)
    )
    if in_git and worktree is None:
        _fail(
            services,
            api_base,
            candidate,
            quiet,
            "worktree isolation failed (won't run in shared checkout)",
        )
        return
    run_cwd = worktree or base_cwd or str(pathlib.Path.cwd())
    log_path = services._conversation_log_path(base_cwd, conv_id)
    reply_path = services._conversation_reply_path(log_path)
    session_id = candidate.get("session_id")
    use_resume = (
        bool(session_id)
        and not candidate.get("cold_required")
        and conv_id not in services._CODEX_RESUME_FAILED
    )
    if use_resume:
        prompt = services._codex_resume_prompt(
            candidate.get("agent_alias"), pending
        )
        persona = None
    else:
        prompt = services._conversation_worker_prompt(
            candidate.get("agent_alias"),
            pending,
            [
                turn
                for turn in turns
                if turn.get("seq", 0) <= resolved_through
            ],
            api_base=api_base,
        )
        persona = services._build_persona(
            api_base, candidate["agent_id"], lane="conversation"
        )
    token = services._mint_embodiment_token(
        api_base, candidate["agent_id"], "conversation", "headless"
    )
    _spawn_info: dict = {}
    sent, _, process = services.spawn_headless(
        run_cwd,
        prompt,
        None,
        False,
        alias=candidate.get("agent_alias"),
        system_prompt=persona,
        model=candidate.get("model"),
        reasoning_effort=candidate.get("reasoning_effort"),
        runtime=services.RUNTIME_CODEX,
        resume_session_id=session_id if use_resume else None,
        log_path=log_path,
        last_message_path=reply_path,
        run_token=token,
        conversation=True,
        spawn_info=_spawn_info,
    )
    if not sent or process is None:
        services._safe_teardown_worktree(base_cwd, worktree, branch)
        services._revoke_or_defer(api_base, token)
        _fail(services, api_base, candidate, quiet)
        return
    _run_payload = {
        "wake_kind": "ephemeral",
        "wake_event": "conversation_turn",
        "log_path": str(log_path) if log_path else None,
        "pid": process.pid,
        "runtime": services.RUNTIME_CODEX,
        "conversation_id": conv_id,
        "conversation_ack_ts": candidate.get(
            "conversation_ack_ts"
        ),
        "last_message_path": str(reply_path) if reply_path else None,
        "worktree": worktree,
        "branch": branch,
        "base_cwd": base_cwd,
        "lane": "conversation",
        "token_id": token,
    }
    # Remote-runner §3.3c: a sandbox wake stamps its container name (and wake_kind)
    # so re-adoption by label + container-runtime metering work off the run row.
    if _spawn_info.get("sandbox_container_id"):
        _run_payload["sandbox_container_id"] = _spawn_info["sandbox_container_id"]
        _run_payload["wake_kind"] = "sandbox"
    run = services._post_json(
        f"{api_base}/api/agents/{candidate['agent_id']}/runs",
        _run_payload,
    )
    run_id = (run or {}).get("run_id")
    if not run_id:
        services._kill_worker(process, graceful=True)
        services._safe_teardown_worktree(base_cwd, worktree, branch)
        services._revoke_or_defer(api_base, token)
        _fail(
            services,
            api_base,
            candidate,
            quiet,
            "worker_run creation failed",
        )
        return
    live_residents[conv_id] = {
        "runtime": services.RUNTIME_CODEX,
        "proc": process,
        "agent_id": candidate["agent_id"],
        "conversation_id": conv_id,
        "alias": candidate.get("agent_alias"),
        "log_path": log_path,
        "last_message_path": reply_path,
        "worktree": worktree,
        "branch": branch,
        "base_cwd": base_cwd,
        "serviced_seq": max(turn.get("seq", 0) for turn in pending),
        "current_run_id": run_id,
        "run_id": run_id,
        # I4: this turn's sandbox container — the turn-completion path reaps
        # it (container + api-config) after the run row is stamped.
        "sandbox_container_id": _spawn_info.get("sandbox_container_id"),
        "conversation_ack_ts": candidate.get("conversation_ack_ts"),
        "resume_session_id": session_id if use_resume else None,
        "run_token": token,
        "hard_deadline": time.time() + services.HARD_CAP_MIN_SECS,
        "last_size": 0,
        "last_progress_ts": time.time(),
        "lines_offset": 0,
        "lines_buf": b"",
        "lines_seq": 1,
        "last_activity_ts": time.time(),
    }
    if not quiet:
        print(
            "[notifier] Codex conversation worker for "
            f"{candidate.get('agent_alias')} spawned (pid {process.pid})"
        )


def _fail(services, api_base, candidate, quiet, reason=None) -> None:
    services._post_json(
        f"{api_base}/api/agents/{candidate['agent_id']}/wake-ack",
        {
            "kind": "codex_conversation_failed",
            "event": "conversation_turn",
            "release_lease": True,
            "lane": "conversation",
        },
    )
    if reason and not quiet:
        print(
            "[notifier] Codex conversation skip "
            f"{candidate.get('agent_alias')} — {reason}"
        )
