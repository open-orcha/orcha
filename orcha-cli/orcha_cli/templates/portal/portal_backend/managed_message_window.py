"""Persist the initial task-thread boundary before dispatch acknowledgements.

Task history is startup context, not new guidance. Pending message events can
precede dispatch, so include their oldest message and keep that boundary across
every replacement, even if no worker managed to poll or create a receipt.
"""


def ensure_message_window(cur, tid, aid, rid, started_at):
    tid, aid, rid = str(tid), str(aid), str(rid)
    cur.execute('SELECT started_at FROM managed_message_windows WHERE task_id=%s AND agent_id=%s',
                (tid, aid))
    existing = cur.fetchone()
    if existing:
        return existing['started_at']
    # An accepted task can outlive an unregistered first worker. Its saved
    # boundary belongs to the task/agent, not to a replaceable scheduling claim.
    cur.execute('SELECT started_at FROM managed_task_dispatches WHERE task_id=%s AND agent_id=%s',
                (tid, aid))
    accepted = cur.fetchone()
    if accepted:
        started_at = min(started_at, accepted['started_at'])
    cur.execute("""SELECT m.created_at FROM task_messages m
                   WHERE m.task_id=%s AND (m.author_id IS NULL OR m.author_id<>%s)
                     AND (EXISTS (
                       SELECT 1 FROM agent_events e
                       WHERE e.event_key=%s AND e.event_name='task_message'
                         AND e.payload->>'task_id'=%s AND e.payload->>'message_id'=CAST(m.id AS TEXT)
                         AND e.ts>COALESCE((SELECT delivered_ts FROM agent_wake_state WHERE agent_id=%s),0)
                         AND NOT EXISTS (SELECT 1 FROM agent_event_acks a
                                         WHERE a.agent_id=%s AND a.event_id=e.id))
                       OR EXISTS (SELECT 1 FROM managed_message_receipts r
                                  WHERE r.task_id=m.task_id AND r.agent_id=%s AND r.message_id=m.id))
                   ORDER BY m.created_at,m.id LIMIT 1""", (tid, aid, aid, tid, aid, aid, aid))
    pending = cur.fetchone()
    floor = min(started_at, pending['created_at']) if pending else started_at
    cur.execute("""INSERT INTO managed_message_windows (task_id,agent_id,first_run_id,started_at)
                   VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING""", (tid, aid, rid, floor))
    cur.execute('SELECT started_at FROM managed_message_windows WHERE task_id=%s AND agent_id=%s',
                (tid, aid))
    return cur.fetchone()['started_at']
