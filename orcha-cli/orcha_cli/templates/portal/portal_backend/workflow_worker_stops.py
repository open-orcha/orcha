"""Worker stop/fencing transitions; caller owns graph -> workflow -> task locks.

No function commits, opens a nested connection, or contacts a runner. Terminalization
is supplied by the evidence service and MUST succeed before capacity is released.
"""

from uuid import uuid4

from portal_backend import sql
from portal_backend.workflow_graph import conflict
from portal_backend.workflow_scheduling import LIVE_EXECUTIONS, release_deadline


def fence_execution(cur, execution, *, now=None):
    now = now or sql.utcnow()
    cur.execute("UPDATE workflow_executions SET generation_revoked_at=COALESCE(generation_revoked_at,%s) WHERE id=%s",
                (now, execution["id"]))
    cur.execute("UPDATE workflow_launch_permits SET revoked_at=COALESCE(revoked_at,%s) WHERE execution_id=%s AND generation=%s",
                (now, execution["id"], execution["generation"]))
    if execution.get("run_id"):
        cur.execute("UPDATE embodiment_tokens SET revoked_at=COALESCE(revoked_at,%s) WHERE run_id=%s",
                    (now, execution["run_id"]))


def stop_execution(cur, execution, *, origin, actor_id, reason, operation_key, now=None):
    """Record a stop BEFORE asynchronous delivery. Reissue never resets its clock.

    Workflow/task cancellation and rejection own their task outcome; this adapter
    changes the task outcome only for an explicit task_stop.
    """
    if origin not in {"task_stop", "rejection", "task_cancel", "workflow_cancel", "recovery_reissue"}:
        conflict("invalid_stop_origin", "Unknown stop action.", status=422)
    cur.execute("SELECT * FROM workflow_stop_intents WHERE execution_id=%s AND operation_key=%s",
                (execution["id"], operation_key))
    previous = cur.fetchone()
    if previous:
        if (previous["origin"], str(previous["requested_by"]), previous["reason"]) != (origin, str(actor_id), reason):
            conflict("idempotency_conflict", "This stop receipt belongs to a different action.")
        return previous
    if execution["state"] not in LIVE_EXECUTIONS:
        conflict("reservation_not_live", "Nothing is running; use On hold.")
    if origin == "recovery_reissue" and execution["state"] != "stopping":
        conflict("stop_not_requested", "Request a stop first.")
    now = now or sql.utcnow()
    if origin == "task_stop":
        cur.execute("""UPDATE tasks SET status='not_ready', awaiting_owner_decision='stopped_by_owner',
                       owner_decision_at=%s WHERE id=%s AND status NOT IN ('completed','cancelled')""",
                    (now, execution["task_id"]))
    fence_execution(cur, execution, now=now)
    cur.execute("""UPDATE workflow_executions SET state='stopping', first_stop_at=COALESCE(first_stop_at,%s)
                   WHERE id=%s""", (now, execution["id"]))
    if execution.get("run_id"):
        cur.execute("UPDATE worker_runs SET stop_requested_at=COALESCE(stop_requested_at,%s) WHERE run_id=%s",
                    (now, execution["run_id"]))
    cur.execute("""INSERT INTO workflow_stop_intents
                   (id,execution_id,generation,origin,requested_by,reason,requested_at,operation_key)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
                (str(uuid4()), execution["id"], execution["generation"], origin, actor_id, reason, now, operation_key))
    return cur.fetchone()


def release_lost(cur, execution, *, actor_id, reason, terminalize, now=None):
    """Owner permission/revisions are checked by the route under the SAME locks."""
    if execution["state"] in {"released", "released_lost", "aborted"}:
        conflict("already_released", "This worker's place has already been released.")
    now = now or sql.utcnow()
    deadline = release_deadline(execution)
    if not deadline or now < deadline:
        conflict("release_not_yet_available", "The worker has not been silent long enough.",
                 release_available_at=deadline.isoformat() if deadline else None)
    fence_execution(cur, execution, now=now)
    if execution.get("run_id"):
        terminalize(cur, execution["run_id"], "killed", cause="lost_worker_release")
    cur.execute("""UPDATE workflow_executions SET state='released_lost', released_at=%s, release_reason=%s
                   WHERE id=%s""", (now, reason, execution["id"]))
    # Preserve accepted, cancelled and every pre-existing owner decision.
    cur.execute("""UPDATE tasks SET status='not_ready', awaiting_owner_decision='worker_released', owner_decision_at=%s
                   WHERE id=%s AND status NOT IN ('completed','cancelled') AND awaiting_owner_decision IS NULL""",
                (now, execution["task_id"]))
    return {"state": "released_lost", "warning": "This worker may still be running outside Orcha. Orcha will refuse anything it sends from now on."}


def confirm_stopped(cur, execution, *, run_id, generation, terminalize, now=None):
    """Only an authenticated runner's positive process-exit observation may call.

    A lease expiring, quiet heartbeat, pruned log or missing local PID for a remote
    worker is NOT confirmation. Old-generation observations cannot release a successor.
    """
    if str(execution.get("run_id")) != str(run_id) or execution["generation"] != generation:
        conflict("stale_generation", "This observation belongs to an earlier worker.")
    if execution["state"] in {"released", "released_lost", "aborted"}:
        return {"state": execution["state"]}
    now = now or sql.utcnow()
    terminalize(cur, run_id, "exited", cause="confirmed_stop")
    cur.execute("SELECT status FROM tasks WHERE id=%s", (execution["task_id"],))
    task = cur.fetchone()
    # A normal exit before acceptance keeps the turn. A checkpoint also keeps it.
    release = execution["state"] == "stopping" or task["status"] in {"completed", "cancelled"}
    if release:
        fence_execution(cur, execution, now=now)
    else:
        # A checkpoint ends this process, not its task turn. Keep continuation legal.
        cur.execute("UPDATE embodiment_tokens SET revoked_at=COALESCE(revoked_at,%s) WHERE run_id=%s", (now, run_id))
    state = "released" if release else execution["state"]
    cur.execute("""UPDATE workflow_executions SET worker_stopped_at=%s, state=%s,
                   released_at=CASE WHEN %s THEN %s ELSE released_at END WHERE id=%s""",
                (now, state, release, now, execution["id"]))
    cur.execute("UPDATE workflow_stop_intents SET satisfied_at=COALESCE(satisfied_at,%s), delivery_state='acknowledged' WHERE execution_id=%s AND generation=%s",
                (now, execution["id"], generation))
    return {"state": state}
