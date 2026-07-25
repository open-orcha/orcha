"""Shared serialization and task-attribution rules for worker runs."""

from typing import Optional


def run_row(row: dict) -> dict:
    """Serialize a worker-run database row for the API."""
    return {
        "run_id": str(row["run_id"]),
        "agent_id": str(row["agent_id"]),
        "task_id": str(row["task_id"]) if row["task_id"] else None,
        "wake_kind": row["wake_kind"],
        "wake_event": row["wake_event"],
        "status": row["status"],
        "exit_code": row["exit_code"],
        "log_path": row["log_path"],
        "pid": row.get("pid"),
        "runtime": row.get("runtime"),
        "conversation_id": (
            str(row["conversation_id"]) if row.get("conversation_id") else None
        ),
        "conversation_ack_ts": row.get("conversation_ack_ts"),
        "last_message_path": row.get("last_message_path"),
        "worktree": row.get("worktree"),
        "branch": row.get("branch"),
        "base_cwd": row.get("base_cwd"),
        "output": row["output"],
        "diff": row.get("diff"),
        "kill_reason": row.get("kill_reason"),
        "started_at": (row["started_at"].isoformat() if row["started_at"] else None),
        "ended_at": row["ended_at"].isoformat() if row["ended_at"] else None,
    }


def infer_agent_active_task(cur, aid: str) -> Optional[str]:
    """Return an agent's sole active non-root task, if it is unambiguous."""
    cur.execute(
        """SELECT t.id
           FROM tasks t
           JOIN agent_tasks at ON at.task_id = t.id
           WHERE at.agent_id=%s AND at.assignment_status IN ('assigned','accepted','working')
             AND t.status='in_progress' AND t.is_root = false
           ORDER BY t.started_at DESC NULLS LAST, t.created_at DESC
           LIMIT 2""",
        (aid,),
    )
    rows = cur.fetchall()
    return str(rows[0]["id"]) if len(rows) == 1 else None


def is_non_task_work(wake_kind, wake_event, conversation_id) -> bool:
    """Return whether a run is intentionally independent of task work."""
    return (
        wake_event == "conversation_turn"
        or wake_kind == "live"
        or conversation_id is not None
    )


def revoke_tokens_for_runs(cur, run_ids) -> None:
    """Revoke every live embodiment token bound to the given terminal runs."""
    if run_ids:
        cur.execute(
            "UPDATE embodiment_tokens SET revoked_at=now() "
            "WHERE run_id = ANY(%s) AND revoked_at IS NULL",
            (list(run_ids),),
        )
