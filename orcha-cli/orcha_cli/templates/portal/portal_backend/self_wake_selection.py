"""Read-only selection of a due, unparked task resume for a wake scan."""

from collections.abc import Callable


def select_due_self_wake(
    cur,
    aid: str,
    wake_task_id,
    *,
    auto_tasks: list[str],
    pending_task_request: bool,
    valid_uuid: Callable[[str], bool],
    selected: dict | None = None,
    is_parked: Callable | None = None,
):
    """Return due flag, context, task id, and the resulting wake task id."""
    if auto_tasks or pending_task_request:
        return False, None, None, wake_task_id
    params = [aid]
    task_filter = ""
    if wake_task_id and valid_uuid(wake_task_id):
        task_filter = "AND sw.task_id=%s"
        params.append(wake_task_id)
    cur.execute(
        f"""SELECT sw.*
            FROM agent_self_wake sw
            JOIN tasks t ON t.id = sw.task_id
            JOIN agent_tasks at
              ON at.task_id = sw.task_id AND at.agent_id = sw.agent_id
            WHERE sw.agent_id=%s {task_filter}
              AND sw.resume_at <= now()
              AND t.status = 'in_progress'
              AND at.assignment_status IN ('assigned','accepted','working')
            ORDER BY sw.resume_at""",
        tuple(params),
    )
    from portal_backend.workflow_continuation import schedule_eligible
    for row in cur.fetchall():
        task_id = str(row["task_id"])
        if is_parked and is_parked(task_id):
            continue
        if row["auto_continue_run_id"] and not schedule_eligible(cur, row, aid):
            continue
        if selected is not None:
            selected.update(self_wake_id=str(row["id"]))
            if row["auto_continue_run_id"]:
                selected.update(automatic_schedule_id=str(row["id"]),
                                auto_continue_run_id=str(row["auto_continue_run_id"]))
        return True, row["context"], task_id, task_id
    return False, None, None, wake_task_id
