"""Bind pending wake content and acknowledgement work to one task context."""

from collections.abc import Callable, Collection
from typing import Any


def resolve_context_task_id(
    cur,
    aid: str,
    delivered_ts,
    ack_through_ts,
    *,
    initial_task_id,
    pending: int,
    non_waking_events: Collection[str],
    drain_class: Callable[..., dict],
    drain_task_status: Callable[[Any, str], str | None],
    task_bound_bucket: str,
    directive_bucket: str,
):
    """Resolve the live task that owns this wake, newest directive last."""
    if initial_task_id is not None or not pending:
        return initial_task_id
    cur.execute(
        """SELECT e.event_name, e.payload, e.target_id FROM agent_events e
           WHERE e.event_key=%s AND e.ts > %s AND e.ts <= %s
             AND e.event_name <> ALL(%s)
             AND NOT EXISTS (
               SELECT 1 FROM agent_event_acks a
               WHERE a.agent_id=%s AND a.event_id=e.id
             )
           ORDER BY e.ts DESC, e.id DESC""",
        (aid, delivered_ts, ack_through_ts, list(non_waking_events), aid),
    )
    for row in cur.fetchall():
        classification = drain_class(
            cur,
            row["event_name"],
            row["payload"],
            target_id=row["target_id"],
        )
        task_id = classification["task_id"]
        if (
            classification["bucket"] in (task_bound_bucket, directive_bucket)
            and task_id
            and drain_task_status(cur, task_id) not in (None, "completed", "cancelled")
        ):
            return str(task_id)
    return None


def filter_context_content(
    directed_messages,
    notifications,
    context_task_id,
    *,
    is_cross_task: Callable[[str | None, str | None, str | None], bool],
):
    """Remove task-scoped prompt and manifest rows owned by another task."""
    prompts = [
        message["text"]
        for message in directed_messages
        if not is_cross_task(message["bucket"], message["task_id"], context_task_id)
    ]
    filtered_notifications = [
        notification
        for notification in notifications
        if not is_cross_task(
            notification.get("drain_bucket"),
            notification.get("drain_task_id"),
            context_task_id,
        )
    ]
    return prompts, filtered_notifications


def handled_event_ids(
    cur,
    aid: str,
    delivered_ts,
    ack_through_ts,
    *,
    pending: int,
    context_task_id,
    non_waking_events: Collection[str],
    drain_class: Callable[..., dict],
    run_ackable_buckets: Collection[str],
    task_bound_bucket: str,
):
    """Return events this task-bound run may safely acknowledge on completion."""
    if not pending:
        return []
    cur.execute(
        """SELECT e.id, e.event_name, e.payload, e.target_id
           FROM agent_events e
           WHERE e.event_key=%s AND e.ts > %s AND e.ts <= %s
             AND e.event_name <> ALL(%s)
             AND NOT EXISTS (
               SELECT 1 FROM agent_event_acks a
               WHERE a.agent_id=%s AND a.event_id=e.id
             )
           ORDER BY e.ts, e.id""",
        (aid, delivered_ts, ack_through_ts, list(non_waking_events), aid),
    )
    handled = []
    for row in cur.fetchall():
        classification = drain_class(
            cur,
            row["event_name"],
            row["payload"],
            target_id=row["target_id"],
        )
        bucket = classification["bucket"]
        task_id = classification["task_id"]
        if bucket in run_ackable_buckets or (
            bucket == task_bound_bucket
            and task_id
            and context_task_id
            and str(task_id) == str(context_task_id)
        ):
            handled.append(row["id"])
    return handled
