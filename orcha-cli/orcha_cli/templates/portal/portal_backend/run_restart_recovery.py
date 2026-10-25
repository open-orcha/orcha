"""Restore unfinished task work after losing a worker during a notifier restart."""

import json

from portal_backend.events import publish_event


def requeue_interrupted_run(cur, run, body):
    if body.status != "killed" or run.get("lane") != "work" or run.get("stop_requested_at"):
        return
    try:
        reason = json.loads(body.kill_reason or "{}")
    except (ValueError, TypeError):
        return
    if not isinstance(reason, dict) or reason.get("cause") != "host_process_missing_after_notifier_restart":
        return
    aid, tid = str(run["agent_id"]), run.get("task_id")
    if not tid:
        return  # taskless requests/events are left pending by the unsuccessful run
    cur.execute(
        """SELECT t.container_id, t.title FROM tasks t JOIN agent_tasks a ON a.task_id=t.id
           WHERE t.id=%s AND a.agent_id=%s AND t.status IN ('ready','in_progress')
             AND a.assignment_status IN ('assigned','accepted','working') AND t.is_root=false""",
        (tid, aid),
    )
    task = cur.fetchone()
    if task:
        # Reuse the completion-safe task directive: a failed retry cannot consume it.
        # The original run stays killed in history; a new run receives the task normally.
        publish_event(cur, str(task["container_id"]), aid, "task_assigned",
                      {"task_id": str(tid), "title": task["title"],
                       "reason": "notifier_restart_recovery", "interrupted_run_id": str(run["run_id"])})
