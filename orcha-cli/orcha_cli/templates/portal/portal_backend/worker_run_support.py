"""Shared serialization and task-attribution rules for worker runs."""

from typing import Optional

from portal_backend import sql
from portal_backend.container_metrics_routes import OUTPUT_TAIL_BYTES

# Retention: each agent keeps full detail (output, diff, streamed line log) for its newest
# runs only. Older finished runs keep their row and stats; see prune_old_run_detail.
RUN_DETAIL_KEEP_PER_AGENT = 20
# Most runs pruned per call, so a large backlog drains over several finishes instead of
# holding the write lock for one long delete.
RUN_DETAIL_PRUNE_BATCH = 100


def run_row(row: dict) -> dict:
    """Serialize a worker-run database row for the API."""
    return {
        "run_id": str(row["run_id"]),
        "agent_id": str(row["agent_id"]),
        "task_id": str(row["task_id"]) if row["task_id"] else None,
        "wake_kind": row["wake_kind"],
        "wake_event": row["wake_event"],
        "lane": row.get("lane") or "work",
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
        "sandbox_container_id": row.get("sandbox_container_id"),
        "output": row.get("output"),
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
        wake_event in ("conversation_turn", "prompt")
        or wake_kind == "live"
        or conversation_id is not None
    )


def revoke_tokens_for_runs(cur, run_ids) -> None:
    """Revoke every live embodiment token bound to the given terminal runs."""
    if run_ids:
        cur.execute(
            "UPDATE embodiment_tokens SET revoked_at=now() "
            f"WHERE {sql.in_list('run_id')} AND revoked_at IS NULL",
            (sql.list_param(run_ids),),
        )


def prune_old_run_detail(cur, agent_id) -> int:
    """Clear the heavy detail of an agent's finished runs beyond its newest
    RUN_DETAIL_KEEP_PER_AGENT: delete the line log, drop the diff, and cut output to its last
    OUTPUT_TAIL_BYTES (the tail is where Metrics and Budgets read cost when a run reported no
    usage columns). Status, tokens, cost, branch and worktree stay. Returns runs pruned."""
    cur.execute(
        """SELECT run_id FROM worker_runs wr
           WHERE agent_id=%s AND ended_at IS NOT NULL
             AND run_id NOT IN (SELECT run_id FROM worker_runs WHERE agent_id=%s
                                ORDER BY started_at DESC LIMIT %s)
             AND (diff IS NOT NULL OR length(output) > %s
                  OR EXISTS (SELECT 1 FROM worker_run_lines l WHERE l.run_id = wr.run_id))
           ORDER BY started_at LIMIT %s""",
        (agent_id, agent_id, RUN_DETAIL_KEEP_PER_AGENT, OUTPUT_TAIL_BYTES,
         RUN_DETAIL_PRUNE_BATCH),
    )
    run_ids = [str(row["run_id"]) for row in cur.fetchall()]
    if not run_ids:
        return 0
    cur.execute(
        f"DELETE FROM worker_run_lines WHERE {sql.in_list('run_id')}",
        (sql.list_param(run_ids),),
    )
    tail_expr = sql.right("output", OUTPUT_TAIL_BYTES)
    cur.execute(
        f"""UPDATE worker_runs SET diff=NULL, output={tail_expr}
             WHERE {sql.in_list('run_id')}""",
        (sql.list_param(run_ids),),
    )
    return len(run_ids)
