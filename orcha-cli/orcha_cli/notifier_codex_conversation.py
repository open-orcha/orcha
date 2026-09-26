"""Recover and finalize one-shot Codex workers serving conversation turns."""

from __future__ import annotations

import os
import time


def maybe_pin_session(api_base: str, conversation_id: str, resident: dict, services):
    """Persist a newly observed Codex session so the next turn can resume it."""
    session_id = services._extract_codex_session_id(resident.get("log_path"))
    if not session_id or session_id == resident.get("resume_session_id"):
        return None
    response = services._post_json(
        f"{api_base}/api/conversations/{conversation_id}/session",
        {"session_id": session_id},
    )
    return session_id if response is not None else None


def finish(
    api_base: str,
    conversation_id: str,
    resident: dict,
    services,
    *,
    status: str = "exited",
    exit_code=None,
    ack_kind: str = "codex_conversation_released",
    post_reply: bool = True,
    teardown_worktree: bool = False,
) -> bool:
    """Publish the final reply, finish its run, and release the conversation lease."""
    diff = services._capture_diff(resident.get("worktree"))
    posted = False
    real_text = (
        services._conversation_reply_text(
            resident.get("log_path"), resident.get("last_message_path")
        )
        if post_reply
        else None
    )
    text = real_text
    if post_reply:
        if not text and resident.get("resume_session_id"):
            services._CODEX_RESUME_FAILED.add(conversation_id)
        elif not text and status == "exited":
            text = (
                "Codex completed without producing a final conversation reply. "
                f"See worker run {resident.get('current_run_id')} for details."
            )
        if text:
            posted = services._post_conversation_reply(
                api_base,
                conversation_id,
                resident,
                text,
                {"runtime": "codex", "exit_code": exit_code},
            )
    if real_text and posted:
        services._maybe_pin_codex_session(api_base, conversation_id, resident)
        services._CODEX_RESUME_FAILED.discard(conversation_id)

    if services._finish_run(
        api_base,
        resident.get("current_run_id"),
        status,
        exit_code,
        resident.get("log_path"),
        diff,
    ):
        services._reap_sandbox_artifacts(resident)  # I4: the turn's container, once stamped
    if teardown_worktree:
        services._safe_teardown_worktree(
            resident.get("base_cwd"),
            resident.get("worktree"),
            resident.get("branch"),
        )
    delivered_ts = resident.get("conversation_ack_ts") if posted else None
    services._post_json(
        f"{api_base}/api/agents/{resident['agent_id']}/wake-ack",
        services._conversation_ack_body(
            ack_kind, delivered_ts=delivered_ts, release_lease=True
        ),
    )
    return posted


def run_state(conversation: dict, run: dict, services, *, base_cwd=None) -> dict:
    """Rebuild the in-memory state for a durable Codex conversation run."""
    log_path = services._as_path(run.get("log_path"))
    try:
        last_size = os.path.getsize(log_path) if log_path else 0
    except OSError:
        last_size = 0
    now = time.time()
    return {
        "runtime": services.RUNTIME_CODEX,
        "proc": services._ExternalProcess(run["pid"]),
        "agent_id": conversation["agent_id"],
        "conversation_id": conversation["conversation_id"],
        "alias": conversation.get("agent_alias"),
        "log_path": log_path,
        "last_message_path": services._as_path(run.get("last_message_path")),
        "worktree": run.get("worktree"),
        "branch": run.get("branch"),
        "base_cwd": run.get("base_cwd") or base_cwd,
        "serviced_seq": conversation.get("last_turn_seq", 0),
        "current_run_id": run["run_id"],
        "run_id": run["run_id"],
        "conversation_ack_ts": (
            run.get("conversation_ack_ts")
            if run.get("conversation_ack_ts") is not None
            else conversation.get("conversation_ack_ts")
        ),
        "hard_deadline": now + services.HARD_CAP_MIN_SECS,
        "last_size": last_size,
        "last_progress_ts": now,
        "lines_offset": 0,
        "lines_buf": b"",
        "lines_seq": 1,
        "last_activity_ts": now,
    }


def reconcile(
    api_base: str,
    container_id: str,
    live_residents: dict,
    services,
    *,
    quiet: bool = False,
    base_cwd=None,
) -> None:
    """Reattach live Codex workers and recover replies left by dead workers."""
    scan = (
        services._get_json(
            f"{api_base}/api/containers/{container_id}/active-conversations"
        )
        or {}
    )
    for conversation in scan.get("conversations", []):
        if (
            services._normalize_runtime(conversation.get("model_runtime"))
            != services.RUNTIME_CODEX
        ):
            continue
        conversation_id = conversation.get("conversation_id")
        agent_id = conversation.get("agent_id")
        if not conversation_id or not agent_id:
            continue
        runs = (
            services._get_json(f"{api_base}/api/agents/{agent_id}/runs?limit=200")
            or {}
        ).get("runs", [])
        for run in runs:
            if not _is_matching_run(run, conversation_id, services):
                continue
            pid = run.get("pid")
            if pid and services._pid_alive(pid):
                if live_residents.get(conversation_id) is None:
                    live_residents[conversation_id] = services._codex_run_state(
                        conversation, run, base_cwd=base_cwd
                    )
                    if not quiet:
                        print(
                            "[notifier] reattached Codex conversation worker for "
                            f"{conversation.get('agent_alias')} "
                            f"(pid {pid}, run {run.get('run_id')})"
                        )
                continue
            state = services._codex_run_state(
                {**conversation, "last_turn_seq": conversation.get("last_turn_seq", 0)},
                {**run, "pid": pid or -1},
                base_cwd=base_cwd,
            )
            text = services._conversation_reply_text(
                state.get("log_path"), state.get("last_message_path")
            )
            services._finish_codex_conversation(
                api_base,
                conversation_id,
                state,
                status="exited" if text else "killed",
                exit_code=0 if text else -1,
                ack_kind="codex_conversation_orphan_recovered",
                post_reply=True,
                teardown_worktree=True,
            )
            if not quiet:
                outcome = "recovered reply" if text else "finished without reply"
                print(
                    f"[notifier] reconciled orphan Codex conversation run "
                    f"{run.get('run_id')} for {conversation.get('agent_alias')} ({outcome})"
                )


def _is_matching_run(run: dict, conversation_id: str, services) -> bool:
    """Return whether a run is the live Codex turn for this conversation."""
    return (
        run.get("status") == "running"
        and services._normalize_runtime(run.get("runtime")) == services.RUNTIME_CODEX
        and run.get("wake_event") == "conversation_turn"
        and run.get("conversation_id") == conversation_id
    )
