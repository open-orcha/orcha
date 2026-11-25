"""Feed one pending human turn into an already-running Claude resident."""

from __future__ import annotations

import time

from .notifier_reply_style import delivered_style, remember_delivered


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
    reply_style = candidate.get("reply_style")
    if not services._send_user_turn(
        resident["proc"],
        services._wrap_conversation_turn(
            next_turn["content"],
            reply_style=reply_style,
            delivered_style=delivered_style(conv_id),
        ),
    ):
        return
    # The session now writes in this style (the note rode on the turn, or it already had it).
    if reply_style is not None:
        remember_delivered(conv_id, reply_style)
    _run_payload = {
        "wake_kind": "resident",
        "wake_event": "conversation_turn",
        "log_path": (
            str(resident["log_path"])
            if resident.get("log_path")
            else None
        ),
        "pid": getattr(resident.get("proc"), "pid", None),
        "worktree": resident.get("worktree"),
        "base_cwd": resident.get("base_cwd"),
        "lane": "conversation",
    }
    # Remote-runner §3.3c (resident lane): a sandboxed session stamps its container
    # name so the sweep reconciles this turn's row by CONTAINER liveness (the pid
    # is only the docker client). wake_kind stays 'resident' — that is what tells
    # the sweep the session is long-lived BY DESIGN and must never be
    # deadline-stopped. worktree/base_cwd ride along for the sweep's SandboxConfig
    # + api-config resolution, exactly like the one-shot sandbox rows. Every
    # resident records its checkout above so restart recovery can treat a live
    # host resident as an owner of a shared main checkout too.
    if resident.get("sandbox_container_id"):
        _run_payload["sandbox_container_id"] = resident["sandbox_container_id"]
    run = services._post_json(
        f"{api_base}/api/agents/{candidate['agent_id']}/runs",
        _run_payload,
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
