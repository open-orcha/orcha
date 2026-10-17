"""List worker-run history and stream a live run's output."""

import asyncio
import json
import time
from typing import Optional

from fastapi import HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from portal_backend.application import app
from portal_backend import stream_signal
from portal_backend.database import db_cursor
from portal_backend.events import shutting_down
from portal_backend.guards import require_agent, require_task, valid_uuid
from portal_backend.identity_routes import require_member_read
from portal_backend.worker_run_support import run_row


def fetch_run_lines(run_id, after_seq, limit=500):
    """Fetch one ordered batch of persisted worker output."""
    with db_cursor(readonly=True) as (_, cur):
        cur.execute(
            """SELECT seq, line FROM worker_run_lines
               WHERE run_id=%s AND seq>%s ORDER BY seq LIMIT %s""",
            (run_id, after_seq, limit),
        )
        return cur.fetchall()


@app.get("/api/agents/{aid}/runs")
def list_agent_runs(
    aid: str,
    request: Request,
    limit: int = Query(default=20, ge=1, le=200),
    task_id: Optional[str] = Query(default=None),
):
    """A2: this agent's worker runs, newest first (what B1 renders). Optional ?task_id= filter.

    GH #144: the ?task_id= filter is a per-task FEED, so it joins worker_run_tasks (every task a run
    touched) instead of the single worker_runs.task_id pin — a session that spanned this task shows
    up here even if its pin settled on another task."""
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor(readonly=True) as (_, cur):
        agent = require_agent(cur, aid)
        # project isolation (V2 A.md): trusted non-members of the agent's project get 403;
        # trust off / no proxy header is unchanged (self-host, in-stack callers).
        require_member_read(cur, request, str(agent["container_id"]))
        if task_id is not None:
            if not valid_uuid(task_id):
                raise HTTPException(400, "task_id is not a valid UUID")
            cur.execute(
                """SELECT wr.* FROM worker_runs wr
                           JOIN worker_run_tasks wrt ON wrt.run_id = wr.run_id
                           WHERE wr.agent_id=%s AND wrt.task_id=%s
                           ORDER BY wr.started_at DESC LIMIT %s""",
                (aid, task_id, limit),
            )
        else:
            cur.execute(
                """SELECT * FROM worker_runs WHERE agent_id=%s
                           ORDER BY started_at DESC LIMIT %s""",
                (aid, limit),
            )
        runs = [run_row(row) for row in cur.fetchall()]
    return {"agent_id": aid, "runs": runs}


@app.get("/api/tasks/{tid}/runs")
def list_task_runs(tid: str, request: Request, limit: int = Query(default=20, ge=1, le=200)):
    """A2: worker runs for a task, newest first (per-task progress view for B1).

    GH #144: joins worker_run_tasks (every task a run touched) rather than the single
    worker_runs.task_id pin, so a run from a session that spanned this AND another task narrates
    here too — not only under whichever task ended up as its pin."""
    if not valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    with db_cursor(readonly=True) as (_, cur):
        task = require_task(cur, tid)
        require_member_read(cur, request, str(task["container_id"]))
        cur.execute(
            """SELECT wr.* FROM worker_runs wr
                       JOIN worker_run_tasks wrt ON wrt.run_id = wr.run_id
                       WHERE wrt.task_id=%s
                       ORDER BY wr.started_at DESC LIMIT %s""",
            (tid, limit),
        )
        runs = [run_row(row) for row in cur.fetchall()]
    return {"task_id": tid, "runs": runs}


def worker_run_status(run_id):
    """Return a run's current status, or None when it no longer exists."""
    with db_cursor(readonly=True) as (_, cur):
        cur.execute("SELECT status FROM worker_runs WHERE run_id=%s", (run_id,))
        row = cur.fetchone()
        return row["status"] if row else None


# How long an idle stream waits for a POST /lines wake-up before re-reading the table
# anyway (the fallback when a notify is missed). Lines normally arrive via the signal.
STREAM_IDLE_WAIT_S = 1.0
# Tell any buffering reverse proxy (nginx) to pass each event through immediately instead
# of batching the stream (the API's cache middleware already marks /api no-store).
SSE_HEADERS = {"X-Accel-Buffering": "no"}


def _resume_seq(request: Request, after_seq: Optional[int]) -> int:
    """Where a (re)connecting client resumes: ?after_seq=, else the SSE Last-Event-ID the
    browser sends on an automatic reconnect, else the start."""
    if after_seq is not None:
        return max(0, int(after_seq))
    raw = request.headers.get("last-event-id") or ""
    try:
        return max(0, int(raw.strip()))
    except ValueError:
        return 0


def _line_event(item) -> str:
    return f"id: {item['seq']}\ndata: {json.dumps({'seq': item['seq'], 'line': item['line']})}\n\n"


@app.get("/api/agents/{aid}/runs/{run_id}/stream")
async def stream_worker_run(
    aid: str,
    run_id: str,
    request: Request,
    after_seq: Optional[int] = Query(default=None, ge=0),
):
    """SSE: live-tail a worker's stream-json lines so the portal sees its progress the instant
    it acts (kills the 'invisible until reap' gap). Each new NDJSON line is one SSE event
    `{seq, line}`; on run finish a terminal `{seq, done:true, status}` is sent and the stream
    closes. Reap-time output+diff capture (history) is unchanged.

    ISS-39: lines are tailed from the `worker_run_lines` TABLE (the daemon POSTs them as it
    reads its own host log), NOT from the bind-mounted per-wake file. The portal reading the
    mounted log saw host appends through the macOS Docker VirtioFS attribute cache, which lags
    1-5s and dropped lines inside a client window ('seq 1 then stall'). DB reads have no such
    lag. `seq` is the daemon-assigned line number (monotonic per run), which the client dedups.

    Live chat: an idle stream is woken by the POST /lines that stored a batch
    (stream_signal) instead of sleeping a fixed second, so a batch reaches the viewer as
    soon as it commits. Each line event carries `id: <seq>`, so a browser's automatic
    reconnect (Last-Event-ID) — or an explicit `?after_seq=` — resumes after the last line
    it saw instead of replaying the run from the start.

    Event shape (for the EventSource client):
      id: <seq>
      data: {"seq": <int>, "line": "<raw stream-json line>"}     ... one per worker line
      data: {"seq": <int>, "done": true, "status": "exited|killed"}   ... final, then close
    """
    if not valid_uuid(aid) or not valid_uuid(run_id):
        raise HTTPException(400, "agent_id / run_id must be valid UUIDs")
    with db_cursor(readonly=True) as (_, cur):
        agent = require_agent(cur, aid)
        require_member_read(cur, request, str(agent["container_id"]))
        cur.execute(
            "SELECT status FROM worker_runs WHERE run_id=%s AND agent_id=%s",
            (run_id, aid),
        )
        row = cur.fetchone()
    if not row:
        raise HTTPException(404, f"worker run {run_id} not found for this agent")
    start_seq = _resume_seq(request, after_seq)

    async def gen():
        last_seq = start_seq
        deadline = time.time() + 1800.0
        waiter = stream_signal.register(run_id)
        try:
            yield ": stream open\n\n"
            while not shutting_down():  # parity r2: end on SIGTERM (events.py)
                # clear BEFORE reading: a notify that lands after this read sets the
                # event again, so the wait below returns at once (no lost wake-up)
                waiter[1].clear()
                rows = await asyncio.to_thread(fetch_run_lines, run_id, last_seq)
                for item in rows:
                    last_seq = item["seq"]
                    yield _line_event(item)
                if rows:
                    continue
                status = await asyncio.to_thread(worker_run_status, run_id)
                if status is None or status != "running":
                    for item in await asyncio.to_thread(fetch_run_lines, run_id, last_seq):
                        last_seq = item["seq"]
                        yield _line_event(item)
                    yield (
                        f"data: {json.dumps({'seq': last_seq + 1, 'done': True, 'status': status})}\n\n"
                    )
                    return
                if time.time() > deadline:
                    yield (
                        f"data: {json.dumps({'seq': last_seq + 1, 'done': True, 'status': 'stream_timeout'})}\n\n"
                    )
                    return
                yield ": heartbeat\n\n"
                await stream_signal.wait(waiter, STREAM_IDLE_WAIT_S)
        finally:
            stream_signal.unregister(run_id, waiter)

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)
