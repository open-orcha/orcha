"""Reviewer regression probes. Run on a disposable PostgreSQL server only."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import threading
import time
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
import main
from portal_backend import database, sql
from portal_backend import worker_run_finish_routes as finish_routes
from portal_backend import stranded_runs
from portal_backend.database import db_cursor

pytestmark = pytest.mark.skipif(database.BACKEND != "postgres", reason="Requires real PostgreSQL row-lock interleavings")


def post(path, body):
    http = TestClient(main.app, raise_server_exceptions=False)
    try:
        return http.post(path, json=body)
    finally:
        http.close()


async def new_run(make_agent, make_task, db):
    await make_agent("Review owner", kind="human")
    worker = await make_agent("Review worker")
    task = await make_task("Ordinary work", "Checked result", assignee_alias="Review worker")
    rid = str(uuid4())
    db.execute("INSERT INTO worker_runs(run_id,agent_id,task_id,wake_kind,status) VALUES (%s,%s,%s,'ephemeral','running')", (rid, worker["agent_id"], task["id"]))
    return rid, worker["agent_id"]


@pytest.mark.asyncio
async def test_duplicate_finish_counts_one_failed_run_once(make_agent, make_task, db, monkeypatch):
    rid, aid = await new_run(make_agent, make_task, db)
    observed = 0
    lock = threading.Lock()
    original = finish_routes._require_run_machine_lane
    def observing(cur, request, agent_id):
        nonlocal observed
        original(cur, request, agent_id)
        with lock:
            observed += 1
    monkeypatch.setattr(finish_routes, "_require_run_machine_lane", observing)
    body = {"status": "failed", "exit_code": 1, "output": "Provider quota exhausted"}
    def concurrent_finishes():
        with ThreadPoolExecutor(max_workers=3) as pool:
            with db_cursor() as (_, cur):
                # Hold a real row lock until all unlocked pre-reads can run. On the
                # parent, the locked initial read blocks here, so just release it.
                cur.execute("SELECT run_id FROM worker_runs WHERE run_id=%s FOR UPDATE", (rid,))
                jobs = [pool.submit(post, f"/api/runs/{rid}/finish", body) for _ in range(3)]
                deadline = time.monotonic() + 1.5
                while observed < 3 and time.monotonic() < deadline:
                    time.sleep(.01)
            return [job.result(timeout=15) for job in jobs]
    replies = await asyncio.to_thread(concurrent_finishes)
    assert [r.status_code for r in replies] == [200,200,200], [r.text for r in replies]
    actual = db.execute("SELECT strikes FROM wake_backoff WHERE agent_id=%s AND wake_key='run_failure'", (aid,))[0]["strikes"]
    notices = db.execute("SELECT count(*) AS n FROM requests WHERE requester_id=%s", (aid,))[0]["n"]
    print(f"simultaneous duplicate finishes: pre-lock reads={observed}, strikes={actual}, human notices={notices}")
    assert actual == 1, "One failed run must not count as three failures and pause automatic work"
    assert notices == 0


@pytest.mark.asyncio
async def test_stranded_cleanup_does_not_overwrite_a_successful_finish(make_agent, make_task, container, db, monkeypatch):
    rid, aid = await new_run(make_agent, make_task, db)
    db.execute("UPDATE worker_runs SET started_at=%s WHERE run_id=%s", (sql.ago(3600),rid))
    db.execute("UPDATE agents SET last_heartbeat_at=%s WHERE id=%s", (sql.ago(3600),aid))
    selected, proceed = threading.Event(), threading.Event()
    class SchedulingCursor:
        """Pause immediately before the terminal write's lock; SQL is unchanged."""
        def __init__(self, cur):
            self.cur = cur
            self.paused = False
        def __getattr__(self, name):
            return getattr(self.cur, name)
        def execute(self, query, params=None):
            text = " ".join(query.split())
            boundary = ((text.startswith("UPDATE worker_runs SET status") and "status = 'running'" in text)
                        or (text.startswith("SELECT * FROM worker_runs WHERE run_id=") and "FOR UPDATE" in text))
            if boundary and not self.paused:
                self.paused = True
                selected.set()
                if not proceed.wait(10):
                    raise RuntimeError("review test schedule timed out")
            return self.cur.execute(query, params)
    def reconcile():
        with db_cursor() as (_, cur):
            return stranded_runs.reconcile_stranded_runs(SchedulingCursor(cur), container["id"],1260,"work")
    def race():
        with ThreadPoolExecutor(max_workers=1) as pool:
            cleanup=pool.submit(reconcile)
            try:
                assert selected.wait(10)
                reply=post(f"/api/runs/{rid}/finish", {"status":"exited","exit_code":0,"output":"successful finish"})
                assert reply.status_code==200,reply.text
            finally:
                proceed.set()
            return cleanup.result(timeout=15)
    rows=await asyncio.to_thread(race)
    row=db.execute("SELECT status,exit_code,output FROM worker_runs WHERE run_id=%s",(rid,))[0]
    print(f"cleanup after successful finish: row={row}, cleanup_reports={len(rows)}")
    assert row["status"]=="exited", "Cleanup must recheck status under the terminalizer lock"
    assert rows==[]
