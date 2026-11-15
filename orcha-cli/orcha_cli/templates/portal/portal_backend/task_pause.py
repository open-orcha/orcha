"""A person's pause on one task or a whole workflow (GH #343).

A paused task keeps its status; ``tasks.paused_at`` is the only switch. While it is set,
nothing that wakes or starts an agent acts on the task: the wake scan skips it, the claim
never picks it, its messages, answers, nudges and self-wakes wait, and the restart after
the run cap does not respawn it. People can still read and comment. Every gate uses
``is_paused`` or ``NOT_PAUSED`` from here so they agree.

Pausing asks any run working on the task to stop through the same path as the Stop
button, so the agent saves its work first, and revokes its managed commands, including
ones that outlived their worker. Resuming wakes each assigned agent with a
``task_assigned`` event, and the messages that waited are delivered then.

Pausing a workflow pauses every open task in it (``paused_via_workflow``); resuming the
workflow lifts only those pauses, so a task a person paused on its own stays paused.
"""

from portal_backend import sql
from portal_backend.agent_status import log_event
from portal_backend.events import publish_event

# SQL fragment for a ``tasks`` alias ``t``: the task is not paused.
NOT_PAUSED = "t.paused_at IS NULL"

OPEN_STATUSES_SQL = "status NOT IN ('completed','cancelled')"


def is_paused(cur, task_id) -> bool:
    """True when a person has paused this task (directly or through its workflow)."""
    if not task_id:
        return False
    cur.execute("SELECT paused_at FROM tasks WHERE id=%s", (str(task_id),))
    row = cur.fetchone()
    return bool(row and row["paused_at"] is not None)


def pause_state(row) -> dict | None:
    """The pause badge fields for a task row, or None when it is not paused."""
    if not row or row.get("paused_at") is None:
        return None
    at = row["paused_at"]
    return {
        "paused_at": at.isoformat() if hasattr(at, "isoformat") else at,
        "paused_by": str(row["paused_by"]) if row.get("paused_by") else None,
        "paused_by_alias": row.get("paused_by_alias"),
        "reason": row.get("paused_reason"),
        "via_workflow": bool(row.get("paused_via_workflow")),
    }


def _stop_running_work(cur, task_id, actor_id) -> list[str]:
    """Ask every live work run on this task to stop (the Stop button's path).

    A run counts when the task is its main task or any task linked to it: one it
    accepted later in the same session, or the one whose instructions its prompt carries.
    """
    cur.execute(
        """SELECT run_id FROM worker_runs
           WHERE (task_id=%s OR run_id IN (
                     SELECT run_id FROM worker_run_tasks WHERE task_id=%s))
             AND status='running' AND lane='work'
             AND stop_requested_at IS NULL""",
        (str(task_id), str(task_id)),
    )
    run_ids = [str(r["run_id"]) for r in cur.fetchall()]
    for run_id in run_ids:
        cur.execute(
            "UPDATE worker_runs SET stop_requested_at=now(), stop_requested_by=%s "
            "WHERE run_id=%s AND status='running' AND stop_requested_at IS NULL",
            (str(actor_id), run_id),
        )
    return run_ids


def _revoke_task_commands(cur, task_id) -> list[str]:
    """Revoke every live managed command on this task, even one whose worker exited.

    A revoked monitor fails the command's next heartbeat, so its supervisor stops it.
    """
    cur.execute(
        """UPDATE managed_job_monitors SET revoked_at=COALESCE(revoked_at,now()),
                  stop_reason=COALESCE(stop_reason,'task_paused')
           WHERE revoked_at IS NULL AND job_id IN (
               SELECT job_id FROM managed_jobs
               WHERE task_id=%s AND state IN ('reserved','running'))
           RETURNING job_id""",
        (str(task_id),),
    )
    return [str(r["job_id"]) for r in cur.fetchall()]


def pause_task(cur, task, actor_id, reason=None, *, via_workflow=False) -> dict:
    """Pause one task. ``task`` needs id, container_id, status, paused_at.

    Idempotent: an already-paused task keeps its first pause (who and when). Returns
    ``{"paused": bool, "already_paused": bool, "stopped_runs": [...]}``.
    """
    tid = str(task["id"])
    if task["paused_at"] is not None:
        if not via_workflow and task.get("paused_via_workflow"):
            # A person pauses a step the workflow already paused: the pause becomes
            # theirs, so resuming the workflow no longer lifts it.
            cur.execute(
                """UPDATE tasks SET paused_by=%s, paused_reason=%s, paused_via_workflow=%s
                   WHERE id=%s AND paused_at IS NOT NULL""",
                (str(actor_id), reason, False, tid),
            )
            log_event(
                cur, str(task["container_id"]), "human", str(actor_id), "task", tid,
                "task_paused", {"reason": reason, "via_workflow": False, "took_over_workflow_pause": True},
            )
            return {"paused": True, "already_paused": True, "took_over": True, "stopped_runs": []}
        return {"paused": True, "already_paused": True, "stopped_runs": []}
    cur.execute(
        f"""UPDATE tasks SET paused_at=%s, paused_by=%s, paused_reason=%s,
                  paused_via_workflow=%s
            WHERE id=%s AND paused_at IS NULL AND {OPEN_STATUSES_SQL}""",
        (sql.utcnow(), str(actor_id), reason, bool(via_workflow), tid),
    )
    if not cur.rowcount:
        return {"paused": False, "already_paused": False, "stopped_runs": []}
    stopped = _stop_running_work(cur, tid, actor_id)
    revoked = _revoke_task_commands(cur, tid)
    log_event(
        cur,
        str(task["container_id"]),
        "human",
        str(actor_id),
        "task",
        tid,
        "task_paused",
        {"reason": reason, "via_workflow": bool(via_workflow), "stopped_runs": stopped,
         "stopped_commands": revoked},
    )
    return {"paused": True, "already_paused": False, "stopped_runs": stopped}


def resume_task(cur, task, actor_id, *, via_workflow=False) -> dict:
    """Lift a pause and wake each assigned agent so it picks the task back up.

    With ``via_workflow`` only a pause the workflow set is lifted.
    """
    tid = str(task["id"])
    if task["paused_at"] is None:
        return {"resumed": False, "not_paused": True, "woken": []}
    if via_workflow and not task.get("paused_via_workflow"):
        return {"resumed": False, "not_paused": False, "woken": []}
    cur.execute(
        """UPDATE tasks SET paused_at=NULL, paused_by=NULL, paused_reason=NULL,
                  paused_via_workflow=%s
           WHERE id=%s AND paused_at IS NOT NULL""",
        (False, tid),
    )
    if not cur.rowcount:
        return {"resumed": False, "not_paused": True, "woken": []}
    cid = str(task["container_id"])
    woken = []
    if task["status"] not in ("completed", "cancelled"):
        cur.execute(
            """SELECT at.agent_id FROM agent_tasks at JOIN agents a ON a.id = at.agent_id
               WHERE at.task_id=%s AND a.kind='ai'
                 AND at.assignment_status IN ('assigned','accepted','working')""",
            (tid,),
        )
        title = task.get("title") or ""
        for row in cur.fetchall():
            aid = str(row["agent_id"])
            publish_event(
                cur, cid, aid, "task_assigned",
                {"task_id": tid, "title": title, "reason": "task_resumed"},
            )
            woken.append(aid)
    log_event(
        cur, cid, "human", str(actor_id), "task", tid, "task_resumed",
        {"via_workflow": bool(via_workflow), "woken": woken},
    )
    return {"resumed": True, "not_paused": False, "woken": woken}
