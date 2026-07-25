"""Collect bounded, task-aware messages for wake and resident prompts."""

from collections.abc import Callable
from typing import Any


def collect_directed_messages(
    cur,
    aid: str,
    delivered_ts,
    max_ts,
    *,
    max_chars: int,
    render_attachment_feed_line: Callable[[Any], str],
    drain_class: Callable[[Any, str, dict], dict],
):
    """Return pending prompt text, its task, and the safe acknowledgement ceiling."""
    messages = []
    wake_task_id = None
    ack_through_ts = max_ts
    cur.execute(
        """SELECT wr.task_id FROM worker_runs wr
           JOIN agent_wake_state ws ON ws.agent_id = wr.agent_id
           WHERE wr.agent_id=%s AND wr.status='running' AND wr.lane='work'
             AND ws.wake_lease_until IS NOT NULL AND ws.wake_lease_until > now()
           ORDER BY wr.started_at DESC LIMIT 1""",
        (aid,),
    )
    live_row = cur.fetchone()
    live_task_id = live_row["task_id"] if live_row else None
    cur.execute(
        """SELECT e.ts, e.event_name, e.payload FROM agent_events e
           WHERE e.event_key = %s AND e.ts > %s
             AND e.event_name IN ('prompt', 'task_message', 'task_assigned', 'conversation_turn')
             AND NOT EXISTS (SELECT 1 FROM agent_event_acks a
                              WHERE a.agent_id = %s AND a.event_id = e.id)
           ORDER BY e.ts, e.id""",
        (aid, delivered_ts, aid),
    )
    budget = max_chars
    included_ts = delivered_ts
    for row in cur.fetchall():
        payload = row["payload"] or {}
        event_name = row["event_name"]
        if event_name == "task_message":
            event_task_id = payload.get("task_id")
            preview = payload.get("preview") or ""
            feed = ""
            message_id = payload.get("message_id")
            if message_id:
                cur.execute(
                    "SELECT attachments FROM task_messages WHERE id=%s",
                    (message_id,),
                )
                message_row = cur.fetchone()
                if message_row:
                    feed = render_attachment_feed_line(message_row["attachments"])
            message = (
                f"[task-thread message on task {event_task_id}] {preview} "
                f"— READ that task's thread and RESPOND on it{feed}"
                if event_task_id
                else f"{preview}{feed}"
            )
        elif event_name == "task_assigned":
            event_task_id = payload.get("task_id")
            title = payload.get("title") or "(untitled)"
            if event_task_id:
                cur.execute("SELECT status FROM tasks WHERE id=%s", (event_task_id,))
                task_row = cur.fetchone()
                task_status = task_row["status"] if task_row else None
            else:
                task_status = None
            if not event_task_id or task_status in (None, "completed", "cancelled"):
                message = None
            elif task_status == "in_progress":
                message = (
                    f"[new task assigned to you: {title} (task {event_task_id})] "
                    f"— it's already in_progress, so /orcha-next will NOT list it; READ its thread "
                    f"(/api/tasks/{event_task_id}/messages) and begin the work directly"
                )
            elif task_status == "ready":
                message = (
                    f"[new task assigned to you: {title} (task {event_task_id})] "
                    f"— claim it with /orcha-next (or READ its thread "
                    f"/api/tasks/{event_task_id}/messages) and begin"
                )
            else:
                message = (
                    f"[new task assigned to you: {title} (task {event_task_id})] "
                    f"— it's '{task_status}'; READ its thread "
                    f"(/api/tasks/{event_task_id}/messages); "
                    f"it may be waiting on dependencies before it's ready"
                )
            if (
                message is not None
                and live_task_id is not None
                and str(live_task_id) != str(event_task_id)
            ):
                ack_through_ts = included_ts
                break
        elif event_name == "conversation_turn":
            event_task_id = None
            content = payload.get("content") or ""
            message = (
                f"[unanswered chat message on this agent's conversation] {content} — the human is "
                f"still waiting on a reply; answer it directly."
                if content
                else None
            )
        else:
            event_task_id = None
            message = payload.get("message")
        if message and messages and len(message) > budget:
            ack_through_ts = included_ts
            break
        if message:
            bucket = drain_class(cur, event_name, payload)["bucket"]
            messages.append(
                {"text": message, "task_id": event_task_id, "bucket": bucket}
            )
            budget -= len(message)
            if event_task_id:
                wake_task_id = event_task_id
        included_ts = row["ts"]
    return messages, wake_task_id, ack_through_ts
