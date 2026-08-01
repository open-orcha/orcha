"""Finish, stop, and append streamed output to worker runs."""

from fastapi import HTTPException, Request

from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.auth_provider import authorize, resolve_actor
from portal_backend.database import db_cursor
from portal_backend.guards import require_kind, valid_uuid
from portal_backend.schemas.worker_runs import (
    WorkerRunFinish,
    WorkerRunLines,
    WorkerRunStop,
)
from portal_backend.worker_run_support import (
    infer_agent_active_task,
    is_non_task_work,
    revoke_tokens_for_runs,
)


@app.post("/api/runs/{run_id}/finish", status_code=200)
def finish_worker_run(run_id: str, body: WorkerRunFinish):
    """A2: the notifier finishes a run on reap — exited (clean) or killed (ISS-15 watchdog),
    with the captured stream-json output. Idempotent-ish: finishing an already-finished run
    just overwrites the terminal fields."""
    if not valid_uuid(run_id):
        raise HTTPException(400, "run_id is not a valid UUID")
    if body.status not in ("exited", "killed", "rate_limited", "failed"):
        raise HTTPException(
            422, "status must be 'exited', 'killed', 'rate_limited', or 'failed'"
        )
    with db_cursor() as (conn, cur):
        cur.execute(
            "SELECT run_id, agent_id, task_id, wake_kind, wake_event, conversation_id "
            "FROM worker_runs WHERE run_id=%s",
            (run_id,),
        )
        existing = cur.fetchone()
        if not existing:
            raise HTTPException(404, f"worker run {run_id} not found")
        late_task_id = (
            infer_agent_active_task(cur, str(existing["agent_id"]))
            if existing["task_id"] is None
            and not is_non_task_work(
                existing["wake_kind"],
                existing["wake_event"],
                existing["conversation_id"],
            )
            else None
        )
        cur.execute(
            """UPDATE worker_runs SET status=%s, exit_code=%s, output=%s,
                      task_id=COALESCE(task_id, %s),
                      diff=COALESCE(%s, diff), kill_reason=COALESCE(%s, kill_reason),
                      input_tokens=COALESCE(%s, input_tokens),
                      output_tokens=COALESCE(%s, output_tokens),
                      cache_read_input_tokens=COALESCE(%s, cache_read_input_tokens),
                      cache_creation_input_tokens=COALESCE(%s, cache_creation_input_tokens),
                      total_cost_usd=COALESCE(%s, total_cost_usd),
                      ended_at=now()
               WHERE run_id=%s RETURNING agent_id, status, ended_at""",
            (
                body.status,
                body.exit_code,
                body.output,
                late_task_id,
                body.diff,
                body.kill_reason,
                body.input_tokens,
                body.output_tokens,
                body.cache_read_input_tokens,
                body.cache_creation_input_tokens,
                body.total_cost_usd,
                run_id,
            ),
        )
        row = cur.fetchone()
        revoke_tokens_for_runs(cur, [run_id])
        conn.commit()
    return {
        "run_id": run_id,
        "status": row["status"],
        "ended_at": row["ended_at"].isoformat() if row["ended_at"] else None,
    }


@app.post("/api/runs/{run_id}/stop", status_code=200)
def stop_worker_run(run_id: str, body: WorkerRunStop, request: Request):
    """#240 + #171/ISS-72: a human requests a graceful STOP of a RUNNING worker run / resident
    turn. The API runs in Docker and cannot signal host PIDs, so it only RECORDS the intent on
    the run row; the host notifier reads it back on its next per-tick wake-renew (zero new poll)
    and reaps the run via the same graceful teardown the stall watchdog uses. Human-gated.

    Idempotent + async: re-stopping an already-stop-requested running run is a no-op 200; a run
    that is no longer 'running' cannot be stopped (returns stop_requested=false with its terminal
    status) — there is nothing live to signal."""
    if not valid_uuid(run_id):
        raise HTTPException(400, "run_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        require_kind(cur, body.actor_agent_id, ("human",))
        cur.execute(
            "SELECT run_id, agent_id, status, stop_requested_at FROM worker_runs "
            "WHERE run_id=%s",
            (run_id,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, f"worker run {run_id} not found")
        if row["status"] != "running":
            return {
                "run_id": run_id,
                "stop_requested": False,
                "status": row["status"],
                "already_finished": True,
            }
        if row["stop_requested_at"] is not None:
            return {
                "run_id": run_id,
                "stop_requested": True,
                "status": "running",
                "already_requested": True,
            }
        cur.execute(
            "UPDATE worker_runs SET stop_requested_at=now(), stop_requested_by=%s "
            "WHERE run_id=%s AND status='running' RETURNING agent_id",
            (body.actor_agent_id, run_id),
        )
        updated = cur.fetchone()
        cur.execute("SELECT container_id FROM agents WHERE id=%s", (row["agent_id"],))
        container = cur.fetchone()
        if container:
            # SEAM A (#211): default no-op resolve/authorize; downstream overridable.
            # The run's container is only known here (from the run's agent), so the
            # authorize lane runs at this point — after the existing human-kind gate.
            resolved_actor = resolve_actor(
                cur, request, str(container["container_id"]), body.actor_agent_id
            )
            authorize(
                cur,
                request,
                resolved_actor,
                "container_control",
                str(container["container_id"]),
            )
            log_event(
                cur,
                str(container["container_id"]),
                "human",
                body.actor_agent_id,
                "agent",
                str(row["agent_id"]),
                "worker_run_stop_requested",
                {"run_id": run_id},
            )
        conn.commit()
    return {"run_id": run_id, "stop_requested": bool(updated), "status": "running"}


@app.post("/api/runs/{run_id}/lines", status_code=200)
def append_worker_run_lines(run_id: str, body: WorkerRunLines):
    """ISS-39: the daemon streams a running worker's stream-json lines here as they're
    written (it reads its OWN host log — no Docker mount lag). The SSE /stream endpoint tails
    this table instead of the bind-mounted file, so the portal no longer depends on seeing
    host appends through the macOS VirtioFS attribute cache. Idempotent: a re-POSTed batch
    (same start_seq) collides on the PK and is dropped, so a lost-response retry is safe."""
    if not valid_uuid(run_id):
        raise HTTPException(400, "run_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        cur.execute("SELECT run_id FROM worker_runs WHERE run_id=%s", (run_id,))
        if not cur.fetchone():
            raise HTTPException(404, f"worker run {run_id} not found")
        rows = [(run_id, body.start_seq + i, line) for i, line in enumerate(body.lines)]
        if rows:
            cur.executemany(
                """INSERT INTO worker_run_lines (run_id, seq, line) VALUES (%s, %s, %s)
                   ON CONFLICT (run_id, seq) DO NOTHING""",
                rows,
            )
        conn.commit()
    return {
        "run_id": run_id,
        "accepted": len(rows),
        "max_seq": (body.start_seq + len(rows) - 1) if rows else None,
    }
