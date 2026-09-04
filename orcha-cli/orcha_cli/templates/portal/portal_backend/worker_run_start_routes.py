"""Start worker runs and expose live-run reconciliation views."""

from typing import Optional

from fastapi import HTTPException

from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import (
    require_agent,
    require_container,
    require_task,
    valid_uuid,
)
from portal_backend.schemas.worker_runs import WorkerRunStart
from portal_backend.worker_run_support import (
    infer_agent_active_task,
    is_non_task_work,
    run_row,
)


@app.post("/api/agents/{aid}/runs", status_code=201)
def start_worker_run(aid: str, body: WorkerRunStart):
    """A2: the notifier records a worker it just spawned (status=running). Returns run_id;
    the daemon stores it and calls /finish on reap. Keeps the 'only the API touches the
    DB' invariant — the notifier never writes worker_runs directly."""
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    if body.task_id is not None and not valid_uuid(body.task_id):
        raise HTTPException(400, "task_id is not a valid UUID")
    if body.conversation_id is not None and not valid_uuid(body.conversation_id):
        raise HTTPException(400, "conversation_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        agent = require_agent(cur, aid)
        task_id = body.task_id
        lazy_attributed = False
        if task_id is not None:
            require_task(cur, task_id)
        elif not is_non_task_work(
            body.wake_kind, body.wake_event, body.conversation_id
        ):
            task_id = infer_agent_active_task(cur, aid)
            lazy_attributed = task_id is not None
        if body.conversation_id is not None:
            cur.execute(
                "SELECT agent_id FROM conversations WHERE id=%s",
                (body.conversation_id,),
            )
            conversation = cur.fetchone()
            if not conversation:
                raise HTTPException(
                    404, f"conversation {body.conversation_id} not found"
                )
            if str(conversation["agent_id"]) != aid:
                raise HTTPException(403, "conversation_id belongs to a different agent")
        cur.execute(
            """INSERT INTO worker_runs
                    (agent_id, task_id, wake_kind, wake_event, log_path, pid, runtime,
                     conversation_id, conversation_ack_ts, last_message_path,
                     worktree, branch, base_cwd, lane, sandbox_container_id, status)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'running')
               RETURNING *""",
            (
                aid,
                task_id,
                body.wake_kind,
                body.wake_event,
                body.log_path,
                body.pid,
                body.runtime,
                body.conversation_id,
                body.conversation_ack_ts,
                body.last_message_path,
                body.worktree,
                body.branch,
                body.base_cwd,
                body.lane,
                body.sandbox_container_id,
            ),
        )
        row = cur.fetchone()
        if body.token_id:
            cur.execute(
                """UPDATE embodiment_tokens SET run_id=%s, pid=%s
                   WHERE run_token=%s AND revoked_at IS NULL""",
                (row["run_id"], body.pid, body.token_id),
            )
        log_event(
            cur,
            str(agent["container_id"]),
            "system",
            None,
            "agent",
            aid,
            "worker_run_started",
            {
                "run_id": str(row["run_id"]),
                "wake_kind": body.wake_kind,
                "task_id": task_id,
                "lazy_attributed": lazy_attributed,
            },
        )
        conn.commit()
    return run_row(row)


@app.get("/api/agents/{aid}/resident-runs")
def list_resident_runs(aid: str, status: Optional[str] = None):
    """919050a5: the notifier's cross-daemon single-flight read — this agent's RESIDENT worker_runs
    with their host `pid`, so the host (the only side that can evaluate os.kill(pid,0); the API runs
    in Docker and can't see host PIDs) can detect a run whose row says 'running' but whose backing
    process is dead, then reap it + release the held resident wake-lease. ?status=running narrows to
    the live-claimed rows the single-flight reaper cares about. Newest first."""
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (_, cur):
        require_agent(cur, aid)
        # Resident-lane sandbox (remote-runner un-deferral): sandbox_container_id
        # rides along so the host reaper can tell a container-backed resident row
        # (whose liveness is docker's, not the host pid's) from a host-pid one.
        query = (
            "SELECT run_id, pid, status, started_at, sandbox_container_id "
            "FROM worker_runs "
            "WHERE agent_id=%s AND wake_kind='resident'"
        )
        params: list = [aid]
        if status is not None:
            query += " AND status=%s"
            params.append(status)
        query += " ORDER BY started_at DESC"
        cur.execute(query, tuple(params))
        rows = cur.fetchall()
    return {
        "agent_id": aid,
        "runs": [
            {
                "run_id": str(row["run_id"]),
                "pid": row["pid"],
                "status": row["status"],
                "sandbox_container_id": row["sandbox_container_id"],
                "started_at": (
                    row["started_at"].isoformat() if row["started_at"] else None
                ),
            }
            for row in rows
        ],
    }


@app.get("/api/containers/{cid}/running-runs")
def list_container_running_runs(cid: str):
    """#342: every worker_run still status='running' across this container's (live) agents, with its
    host `pid` — so the notifier (the only side that can os.kill(pid,0); the API runs in Docker and
    can't see host PIDs) can detect a run whose row says 'running' but whose process is DEAD and
    reconcile it. Unlike the per-agent /resident-runs read this is CONTAINER-WIDE and spans ALL
    wake_kinds: it's what reaps an orphaned EPHEMERAL wake-run (request_answered / checkpoint_respawn
    / conversation_turn) whose daemon RESTARTED and lost the Popen handle that would have poll()/
    finished it — the #342 'busy forever' leak the per-agent resident reaper (active-conversation +
    resident-scoped) and the heartbeat reap-orphan-leases (live-lease-scoped) both miss. Newest first.

    GH #91/#90 (PR R3): each row carries `lane` — the sweep's wake-ack release + running->orphaned
    reconcile are lane-scoped server-side, so the reaper must ack the DEAD run's OWN lane. Without
    it every sweep ack defaulted to 'work' and a dead CONVERSATION-lane run kept its conv lease +
    'running' row forever, blocking all future conversation claims for that agent."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        # Remote-runner Task 5: `sandbox_container_id` marks a row whose liveness is the
        # CONTAINER's (docker inspect), not the host pid's — the docker-run client pid dies
        # with a daemon restart while the detached container keeps working (adoption, §3.3c).
        # `worktree`/`base_cwd` let the sweep load that run's SandboxConfig for its
        # max-runtime deadline and reap its per-run api-config file. `log_path` lets the
        # sweep's finish CAPTURE the adopted run's stream-json output (the run wrote it to
        # the workspace all along) — without it a re-adopted run finishes output=NULL.
        cur.execute(
            """SELECT wr.run_id, wr.agent_id, wr.pid, wr.wake_kind, wr.wake_event, wr.lane,
                      wr.started_at, wr.sandbox_container_id, wr.worktree, wr.base_cwd,
                      wr.log_path
                 FROM worker_runs wr JOIN agents a ON a.id = wr.agent_id
                WHERE a.container_id = %s AND wr.status = 'running'
                  AND a.terminated_at IS NULL
                ORDER BY wr.started_at DESC""",
            (cid,),
        )
        rows = cur.fetchall()
    return {
        "container_id": cid,
        "runs": [
            {
                "run_id": str(row["run_id"]),
                "agent_id": str(row["agent_id"]),
                "pid": row["pid"],
                "wake_kind": row["wake_kind"],
                "wake_event": row["wake_event"],
                "lane": row["lane"],
                "sandbox_container_id": row["sandbox_container_id"],
                "worktree": row["worktree"],
                "base_cwd": row["base_cwd"],
                "log_path": row["log_path"],
                "started_at": (
                    row["started_at"].isoformat() if row["started_at"] else None
                ),
            }
            for row in rows
        ],
    }
