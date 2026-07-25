"""Clean stale self-wakes and select the due task resume for a wake scan."""

from collections.abc import Callable


def select_due_self_wake(
    cur,
    aid: str,
    wake_task_id,
    *,
    auto_tasks: list[str],
    pending_task_request: bool,
    valid_uuid: Callable[[str], bool],
):
    """Return due flag, context, task id, and the resulting wake task id."""
    cur.execute(
        """DELETE FROM agent_self_wake sw
           WHERE sw.agent_id=%s
             AND NOT EXISTS (
               SELECT 1
               FROM tasks t
               JOIN agent_tasks at
                 ON at.task_id = t.id AND at.agent_id = sw.agent_id
               WHERE t.id = sw.task_id
                 AND t.status = 'in_progress'
                 AND at.assignment_status IN ('assigned','accepted','working')
             )""",
        (aid,),
    )
    if auto_tasks or pending_task_request:
        return False, None, None, wake_task_id
    params = [aid]
    task_filter = ""
    if wake_task_id and valid_uuid(wake_task_id):
        task_filter = "AND sw.task_id=%s"
        params.append(wake_task_id)
    cur.execute(
        f"""SELECT sw.task_id, sw.context
            FROM agent_self_wake sw
            JOIN tasks t ON t.id = sw.task_id
            JOIN agent_tasks at
              ON at.task_id = sw.task_id AND at.agent_id = sw.agent_id
            WHERE sw.agent_id=%s {task_filter}
              AND sw.resume_at <= now()
              AND t.status = 'in_progress'
              AND at.assignment_status IN ('assigned','accepted','working')
            ORDER BY sw.resume_at
            LIMIT 1""",
        tuple(params),
    )
    row = cur.fetchone()
    if not row:
        return False, None, None, wake_task_id
    task_id = str(row["task_id"])
    return True, row["context"], task_id, task_id
