"""Finish, stop, and append streamed output to worker runs."""

from fastapi import HTTPException, Request

from portal_backend.agent_status import log_event
from portal_backend.codex_pricing import estimate_codex_cost_usd
from portal_backend.model_policy import resolve_model_runtime
from portal_backend.application import app
from portal_backend import stream_signal
from portal_backend.database import db_cursor
from portal_backend.events import publish_event
from portal_backend.guards import require_kind, valid_uuid
from portal_backend.identity_routes import require_machine_lane_member, trusted_actor
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


def _require_run_machine_lane(cur, request: Request, agent_id) -> None:
    """PS-07: a trusted human touching a run's machine lane must be a non-viewer member of
    the run's project; the header-less daemon lane passes through unchanged."""
    cur.execute("SELECT container_id FROM agents WHERE id=%s", (agent_id,))
    owner = cur.fetchone()
    if owner:
        require_machine_lane_member(cur, request, str(owner["container_id"]))


def _codex_cost_estimate(cur, run, body):
    """Codex reports tokens but no dollar figure: estimate it from the agent's model
    (codex_pricing — an ESTIMATE). Only for a Codex run that reported tokens; a Claude run
    without a CLI-reported cost stays NULL (never a guessed $0)."""
    if (
        body.input_tokens is None
        and body.output_tokens is None
        and body.cache_read_input_tokens is None
    ):
        return None
    cur.execute("SELECT model FROM agents WHERE id=%s", (run["agent_id"],))
    agent = cur.fetchone()
    model = agent["model"] if agent else None
    runtime = run.get("runtime") or resolve_model_runtime(model)
    if runtime != "codex":
        return None
    return estimate_codex_cost_usd(
        model,
        input_tokens=body.input_tokens,
        cache_read_input_tokens=body.cache_read_input_tokens,
        output_tokens=body.output_tokens,
    )


@app.post("/api/runs/{run_id}/finish", status_code=200)
def finish_worker_run(run_id: str, body: WorkerRunFinish, request: Request):
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
            "SELECT run_id, agent_id, task_id, wake_kind, wake_event, conversation_id, runtime "
            "FROM worker_runs WHERE run_id=%s",
            (run_id,),
        )
        existing = cur.fetchone()
        if not existing:
            raise HTTPException(404, f"worker run {run_id} not found")
        _require_run_machine_lane(cur, request, existing["agent_id"])  # PS-07
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
        total_cost_usd = body.total_cost_usd
        if total_cost_usd is None:
            total_cost_usd = _codex_cost_estimate(cur, existing, body)
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
                total_cost_usd,
                run_id,
            ),
        )
        row = cur.fetchone()
        revoke_tokens_for_runs(cur, [run_id])
        # Live chat: a container-wide (never agent-targeted — it must not wake anyone)
        # event so open portals re-read runs/turns now instead of on their next poll.
        cur.execute("SELECT container_id FROM agents WHERE id=%s", (row["agent_id"],))
        owner = cur.fetchone()
        container_key = f"c:{owner['container_id']}" if owner and owner["container_id"] else None
        if container_key:
            publish_event(
                cur,
                str(owner["container_id"]),
                None,
                "worker_run_finished",
                {
                    "run_id": run_id,
                    "agent_id": str(row["agent_id"]),
                    "status": row["status"],
                    "conversation_id": (
                        str(existing["conversation_id"])
                        if existing["conversation_id"]
                        else None
                    ),
                },
            )
        conn.commit()
    # wake the open live streams (terminal {done} now) and the container event streams
    stream_signal.notify(run_id, container_key)
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
        cur.execute(
            "SELECT run_id, agent_id, status, stop_requested_at FROM worker_runs "
            "WHERE run_id=%s",
            (run_id,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, f"worker run {run_id} not found")
        cur.execute(
            "SELECT container_id FROM agents WHERE id=%s", (row["agent_id"],)
        )
        run_container = cur.fetchone()
        if run_container:
            # Per-project identity: a trusted login IS the actor (403 non-member).
            body.actor_agent_id = trusted_actor(
                cur, request, str(run_container["container_id"]), body.actor_agent_id
            )
        require_kind(cur, body.actor_agent_id, ("human",))
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
def append_worker_run_lines(run_id: str, body: WorkerRunLines, request: Request):
    """ISS-39: the daemon streams a running worker's stream-json lines here as they're
    written (it reads its OWN host log — no Docker mount lag). The SSE /stream endpoint tails
    this table instead of the bind-mounted file, so the portal no longer depends on seeing
    host appends through the macOS VirtioFS attribute cache. Idempotent: a re-POSTed batch
    (same start_seq) collides on the PK and is dropped, so a lost-response retry is safe."""
    if not valid_uuid(run_id):
        raise HTTPException(400, "run_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        cur.execute("SELECT run_id, agent_id FROM worker_runs WHERE run_id=%s", (run_id,))
        found = cur.fetchone()
        if not found:
            raise HTTPException(404, f"worker run {run_id} not found")
        _require_run_machine_lane(cur, request, found["agent_id"])  # PS-07
        rows = [(run_id, body.start_seq + i, line) for i, line in enumerate(body.lines)]
        if rows:
            cur.executemany(
                """INSERT INTO worker_run_lines (run_id, seq, line) VALUES (%s, %s, %s)
                   ON CONFLICT (run_id, seq) DO NOTHING""",
                rows,
            )
        conn.commit()
    if rows:
        stream_signal.notify(run_id)  # live chat: push the batch to open streams now
    return {
        "run_id": run_id,
        "accepted": len(rows),
        "max_seq": (body.start_seq + len(rows) - 1) if rows else None,
    }
