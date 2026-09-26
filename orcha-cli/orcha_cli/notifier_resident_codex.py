"""Advance live one-shot Codex workers that serve conversation turns."""

from __future__ import annotations

import json
import os
import time


def advance_codex_resident(
    compat,
    api_base: str,
    conv_id: str,
    resident: dict,
    live_residents: dict,
    active_ids: set,
    *,
    quiet: bool,
) -> None:
    """Advance one Codex conversation worker through completion, stop, or timeout."""
    proc = resident["proc"]
    agent_id = resident["agent_id"]
    if conv_id not in active_ids:
        compat._kill_worker(proc, graceful=True)
        compat._finish_run(
            api_base,
            resident.get("current_run_id"),
            "killed",
            proc.returncode,
            resident.get("log_path"),
            compat._capture_diff(resident.get("worktree")),
        )
        compat._safe_teardown_worktree(
            resident.get("base_cwd"),
            resident.get("worktree"),
            resident.get("branch"),
        )
        compat._post_json(
            f"{api_base}/api/agents/{agent_id}/wake-ack",
            compat._conversation_ack_body(
                "codex_conversation_ended", release_lease=True
            ),
        )
        compat._CODEX_RESUME_FAILED.discard(conv_id)
        compat._retire_resident(api_base, live_residents, conv_id)
        return

    compat._pump_one(api_base, agent_id, resident)
    if proc.poll() is not None:
        compat._finish_codex_conversation(
            api_base,
            conv_id,
            resident,
            status="exited",
            exit_code=proc.returncode,
            ack_kind="codex_conversation_released",
            post_reply=True,
        )
        compat._retire_resident(api_base, live_residents, conv_id)
        if not quiet:
            print(
                f"[notifier] Codex conversation worker for {resident.get('alias')} "
                f"(pid {proc.pid}, rc={proc.returncode}) replied — lease released"
            )
        return

    renew = compat._post_json(
        f"{api_base}/api/agents/{agent_id}/wake-renew",
        {"lease_ttl": compat.WAKE_LEASE_TTL_SECS, "lane": "conversation"},
    )
    if _stop_requested(renew, resident):
        _stop_turn(
            compat,
            api_base,
            conv_id,
            resident,
            live_residents,
            renew,
            quiet=quiet,
        )
        return

    _record_progress(resident)
    if time.time() <= resident.get("hard_deadline", time.time()):
        return
    compat._kill_worker(proc, graceful=True)
    compat._finish_run(
        api_base,
        resident.get("current_run_id"),
        "killed",
        proc.returncode,
        resident.get("log_path"),
        compat._capture_diff(resident.get("worktree")),
    )
    compat._post_json(
        f"{api_base}/api/agents/{agent_id}/wake-ack",
        compat._conversation_ack_body("codex_conversation_killed", release_lease=True),
    )
    compat._retire_resident(api_base, live_residents, conv_id)


def _stop_requested(renew: dict | None, resident: dict) -> bool:
    return bool(
        renew
        and renew.get("stop_requested")
        and resident.get("current_run_id")
        and str(renew.get("stop_run_id")) == str(resident.get("current_run_id"))
    )


def _stop_turn(
    compat,
    api_base: str,
    conv_id: str,
    resident: dict,
    live_residents: dict,
    renew: dict,
    *,
    quiet: bool,
) -> None:
    proc = resident["proc"]
    agent_id = resident["agent_id"]
    compat._kill_worker(proc, graceful=True)
    stopped_by = renew.get("stop_requested_by") or "a human"
    compat._post_conversation_reply(
        api_base,
        conv_id,
        resident,
        f"[turn stopped by {stopped_by}]",
        {
            "runtime": "codex",
            "stopped": True,
            "by": renew.get("stop_requested_by"),
        },
    )
    compat._finish_run(
        api_base,
        resident.get("current_run_id"),
        "killed",
        proc.returncode,
        resident.get("log_path"),
        compat._capture_diff(resident.get("worktree")),
        kill_reason=json.dumps(
            {
                "cause": "human_stop",
                "run_id": str(resident.get("current_run_id")),
                "agent_id": agent_id,
                "runtime": "codex",
                "by": renew.get("stop_requested_by"),
            }
        ),
    )
    compat._post_json(
        f"{api_base}/api/agents/{agent_id}/wake-ack",
        compat._conversation_ack_body(
            "codex_conversation_human_stopped", release_lease=True
        ),
    )
    compat._retire_resident(api_base, live_residents, conv_id)
    if not quiet:
        print(
            f"[notifier] Codex conversation worker for {resident.get('alias')} "
            f"TURN STOPPED by {stopped_by} (run {resident.get('current_run_id')}) — "
            "conversation kept, lease released"
        )


def _record_progress(resident: dict) -> None:
    size = resident.get("last_size", 0)
    log_path = resident.get("log_path")
    if log_path:
        try:
            size = os.path.getsize(log_path)
        except OSError:
            pass
    if size > resident.get("last_size", 0):
        resident["last_size"] = size
        resident["last_progress_ts"] = time.time()
