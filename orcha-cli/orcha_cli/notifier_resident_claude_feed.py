"""Feed one pending human turn into an already-running Claude resident."""

from __future__ import annotations

import time


def feed(services, api_base, conv_id, candidate, resident) -> None:
    """Send first, then persist the run so broken pipes cannot orphan rows."""
    next_turn = services._next_human_turn(
        api_base, conv_id, resident["serviced_seq"]
    )
    if next_turn is None:
        return
    attachment_feed = services._render_attachment_feed(
        next_turn.get("attachments"),
        api_base=api_base,
        runtime="claude",
    )
    if attachment_feed:
        next_turn["content"] = (
            f"{next_turn['content']}\n\n{attachment_feed}"
            if next_turn["content"]
            else attachment_feed
        )
    if not services._send_user_turn(
        resident["proc"],
        services._wrap_conversation_turn(next_turn["content"]),
    ):
        return
    run = services._post_json(
        f"{api_base}/api/agents/{candidate['agent_id']}/runs",
        {
            "wake_kind": "resident",
            "wake_event": "conversation_turn",
            "log_path": (
                str(resident["log_path"])
                if resident.get("log_path")
                else None
            ),
            "pid": getattr(resident.get("proc"), "pid", None),
            "lane": "conversation",
        },
    )
    run_id = (run or {}).get("run_id")
    resident.update(
        {
            "current_run_id": run_id,
            "run_id": run_id,
            "lines_seq": 1,
            "current_run_kind": "conversation",
            "conversation_ack_ts": candidate.get(
                "conversation_ack_ts"
            ),
            "awaiting_result": True,
            "awaiting_since": time.time(),
            "serviced_seq": next_turn["seq"],
            "last_activity_ts": time.time(),
        }
    )
