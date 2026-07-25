"""Capture, finish, and interrupt in-flight Claude resident turns."""

from __future__ import annotations

import json
import time


def capture_result(
    services, api_base, conv_id, resident, candidate, quiet
) -> None:
    """Persist a completed reply and update the resident's session cursor."""
    services._pump_one(api_base, resident["agent_id"], resident)
    result = services._result_after(
        resident.get("log_path"), resident.get("turn_scan_offset", 0)
    )
    if result is None:
        return
    posted = services._post_conversation_reply(
        api_base,
        conv_id,
        resident,
        result.get("text") or "",
        {
            "subtype": result.get("subtype"),
            "num_turns": result.get("num_turns"),
            "session_id": result.get("session_id"),
        },
    )
    delivered_ts = (
        resident.get("conversation_ack_ts") if posted else None
    )
    services._post_json(
        f"{api_base}/api/agents/{resident['agent_id']}/wake-ack",
        services._conversation_ack_body(
            "resident_conversation_turn",
            delivered_ts=delivered_ts,
            release_lease=False,
        ),
    )
    services._finish_run(
        api_base,
        resident["current_run_id"],
        "exited",
        0,
        resident.get("log_path"),
    )
    model_switched = (
        services._resident_runtime(resident) == services.RUNTIME_CLAUDE
        and candidate is not None
        and candidate.get("model") is not None
        and resident.get("model") is not None
        and candidate.get("model") != resident.get("model")
    )
    if model_switched:
        services._RESIDENT_RESUME_FAILED.add(conv_id)
        if not quiet:
            print(
                f"[notifier] resident {resident.get('alias')} model switched "
                f"mid-turn {resident.get('model')}→{candidate.get('model')} — "
                "captured old reply but leaving session UNPINNED"
            )
    if not resident.get("session_pinned") and not model_switched:
        session_id = result.get(
            "session_id"
        ) or services._extract_session_id(resident.get("log_path"))
        if session_id:
            services._post_json(
                f"{api_base}/api/conversations/{conv_id}/session",
                {"session_id": session_id},
            )
            resident["session_id"] = session_id
            resident["session_pinned"] = True
    resident["turn_scan_offset"] = result.get(
        "end_offset", resident.get("turn_scan_offset", 0)
    )
    resident["awaiting_result"] = False
    resident["current_run_id"] = None
    resident["last_activity_ts"] = time.time()


def stop_requested(renew, resident) -> bool:
    """Return whether a lease renewal targets the current in-flight turn."""
    return bool(
        renew
        and renew.get("stop_requested")
        and resident.get("current_run_id")
        and str(renew.get("stop_run_id"))
        == str(resident.get("current_run_id"))
    )


def stop_turn(
    services,
    api_base,
    conv_id,
    resident,
    live_residents,
    renew,
    quiet,
) -> None:
    """Gracefully interrupt one turn while keeping its conversation resumable."""
    process = resident["proc"]
    services._pump_one(api_base, resident["agent_id"], resident)
    services._kill_worker(process, graceful=True)
    stopped_by = renew.get("stop_requested_by") or "a human"
    services._post_conversation_reply(
        api_base,
        conv_id,
        resident,
        f"[turn stopped by {stopped_by}]",
        {"stopped": True, "by": renew.get("stop_requested_by")},
    )
    services._finish_run(
        api_base,
        resident.get("current_run_id"),
        "killed",
        process.returncode,
        resident.get("log_path"),
        services._capture_diff(resident.get("worktree")),
        kill_reason=json.dumps(
            {
                "cause": "human_stop",
                "run_id": str(resident.get("current_run_id")),
                "agent_id": resident["agent_id"],
                "by": renew.get("stop_requested_by"),
            }
        ),
    )
    services._post_json(
        f"{api_base}/api/agents/{resident['agent_id']}/wake-ack",
        services._conversation_ack_body(
            "resident_human_stopped", release_lease=True
        ),
    )
    services._retire_resident(api_base, live_residents, conv_id)
    if not quiet:
        print(
            f"[notifier] resident {resident.get('alias')} TURN STOPPED by "
            f"{stopped_by} (run {resident.get('current_run_id')}) — partial "
            "flushed, conversation kept, lease released"
        )
