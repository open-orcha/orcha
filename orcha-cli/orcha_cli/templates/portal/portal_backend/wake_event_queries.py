"""Query pending wake events that must remain bound to owned task work."""

from collections.abc import Callable


def earliest_actionable_answer_ts(cur, aid: str, delivered_ts):
    """Return the first pending answer or close event that unblocks task work."""
    cur.execute(
        """SELECT min(e.ts) AS floor_ts
             FROM agent_events e
             LEFT JOIN requests r
               ON r.id::text = NULLIF(e.payload->>'request_id', '')
            WHERE e.event_key = %s AND e.ts > %s
              AND e.event_name IN ('request_answered', 'request_closed')
              AND ( (r.type = 'task' AND r.requester_id::text = %s)
                    OR (e.payload->>'originating_task_id') IS NOT NULL )""",
        (aid, delivered_ts, aid),
    )
    row = cur.fetchone()
    return row["floor_ts"] if row else None


def resident_inbox_task_work_id(
    cur,
    aid: str,
    delivered_ts,
    max_ts,
    *,
    valid_uuid: Callable[[str], bool],
):
    """Return newest pending task work a resident must leave for the work lane."""
    if max_ts is None:
        return None
    cur.execute(
        """SELECT event_name, payload FROM agent_events
           WHERE event_key = %s AND ts > %s AND ts <= %s
             AND (event_name IN ('task_message', 'task_assigned')
                  OR (event_name='request_answered'
                      AND payload->>'originating_task_id' IS NOT NULL))
           ORDER BY ts DESC, id DESC""",
        (aid, delivered_ts, max_ts),
    )
    for event in cur.fetchall():
        payload = event["payload"] or {}
        task_id = (
            payload.get("originating_task_id")
            if event["event_name"] == "request_answered"
            else payload.get("task_id")
        )
        if not task_id or not valid_uuid(task_id):
            continue
        cur.execute(
            """SELECT 1 FROM tasks t
               JOIN agent_tasks at ON at.task_id = t.id
               WHERE t.id = %s AND at.agent_id = %s
                 AND t.status = 'in_progress' AND t.is_root = false
                 AND at.assignment_status IN ('assigned','accepted','working')
               LIMIT 1""",
            (task_id, aid),
        )
        if cur.fetchone():
            return task_id
    return None
