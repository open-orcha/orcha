"""Real HTTP/SQL races at the terminal lock, beyond the original review probes."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import threading
import time

import pytest

from portal_backend import database, sql
from portal_backend import orphan_lease_routes, stranded_runs, wake_acknowledgement_routes
from portal_backend import worker_run_finish_routes as finish_routes
from portal_backend.database import db_cursor
from test_evidence_review_races import new_run, post

POSTGRES = pytest.mark.skipif(
    database.BACKEND != "postgres", reason="Requires independent PostgreSQL transactions",
)


def payload(row):
    value = row["payload"]
    return json.loads(value) if isinstance(value, str) else value


@POSTGRES
@pytest.mark.parametrize("initial_status", ["running", "orphaned", "taskless"])
async def test_duplicate_restart_finish_emits_one_recovery(
    make_agent, make_task, db, monkeypatch, initial_status,
):
    rid, aid = await new_run(make_agent, make_task, db)
    if initial_status == "taskless":
        tid = db.execute("SELECT task_id FROM worker_runs WHERE run_id=%s", (rid,))[0]["task_id"]
        db.execute("UPDATE tasks SET status='in_progress' WHERE id=%s", (tid,))
        db.execute("UPDATE worker_runs SET task_id=NULL WHERE run_id=%s", (rid,))
    else:
        db.execute("UPDATE worker_runs SET status=%s WHERE run_id=%s", (initial_status, rid))
    observed = 0
    mutex = threading.Lock()
    original = finish_routes._require_run_machine_lane

    def observing(*args):
        nonlocal observed
        original(*args)
        with mutex:
            observed += 1

    monkeypatch.setattr(finish_routes, "_require_run_machine_lane", observing)
    body = {"status": "killed", "exit_code": -1, "kill_reason": json.dumps({
        "cause": "host_process_missing_after_notifier_restart",
    })}

    def race():
        with ThreadPoolExecutor(max_workers=3) as pool:
            with db_cursor() as (_, cur):
                cur.execute("SELECT run_id FROM worker_runs WHERE run_id=%s FOR UPDATE", (rid,))
                jobs = [pool.submit(post, f"/api/runs/{rid}/finish", body) for _ in range(3)]
                deadline = time.monotonic() + 3
                while observed < 3 and time.monotonic() < deadline:
                    time.sleep(.01)
                assert observed == 3
            return [job.result(timeout=15) for job in jobs]

    replies = await asyncio.to_thread(race)
    assert [r.status_code for r in replies] == [200, 200, 200], [r.text for r in replies]
    events = db.execute(
        "SELECT payload FROM agent_events WHERE event_key=%s "
        "AND payload->>'interrupted_run_id'=%s", (aid, rid),
    )
    assert len(events) == 1
    assert post(f"/api/runs/{rid}/finish", body).status_code == 200
    assert len(db.execute("SELECT payload FROM agent_events WHERE event_key=%s "
                          "AND payload->>'interrupted_run_id'=%s", (aid, rid))) == 1


@POSTGRES
@pytest.mark.parametrize("lane", ["work", "conversation"])
@pytest.mark.parametrize("path", ["lease_release", "orphan_lease", "stranded_run"])
async def test_cleanup_losing_to_finish_has_no_run_transition_or_audit(
    make_agent, make_task, container, db, monkeypatch, lane, path,
):
    rid, aid = await new_run(make_agent, make_task, db)
    old = sql.ago(3600)
    db.execute("UPDATE worker_runs SET lane=%s,started_at=%s WHERE run_id=%s", (lane, old, rid))
    db.execute("UPDATE agents SET last_heartbeat_at=%s WHERE id=%s", (old, aid))
    lease = sql.ago(300) if path == "stranded_run" else sql.from_now(300)
    db.execute("""INSERT INTO agent_wake_state
               (agent_id,wake_lease_until,lease_kind,work_last_heartbeat_at,last_woken_at,
                conv_lease_until,conv_lease_kind,conv_last_heartbeat_at,conv_last_woken_at)
               VALUES (%s,%s,'ephemeral',%s,%s,%s,'resident',%s,%s)""",
               (aid, lease if lane == "work" else None, old, old,
                lease if lane == "conversation" else None, old, old))
    module = {"lease_release": wake_acknowledgement_routes, "orphan_lease": orphan_lease_routes,
              "stranded_run": stranded_runs}[path]
    selected, proceed = threading.Event(), threading.Event()
    original = module.terminalize_worker_run

    def scheduled(cur, run_id, *args, **kwargs):
        # Only timing changes; the real shared lock, terminalizer and routes run.
        if str(run_id) == rid:
            selected.set()
            assert proceed.wait(10)
        return original(cur, run_id, *args, **kwargs)

    monkeypatch.setattr(module, "terminalize_worker_run", scheduled)

    def cleanup():
        if path == "lease_release":
            return post(f"/api/agents/{aid}/wake-ack", {
                "release_lease": True, "lane": lane, "kind": "ephemeral",
            })
        return post(f"/api/containers/{container['id']}/reap-orphan-leases", {})

    def race():
        with ThreadPoolExecutor(max_workers=1) as pool:
            job = pool.submit(cleanup)
            try:
                assert selected.wait(10)
                reply = post(f"/api/runs/{rid}/finish", {
                    "status": "exited", "exit_code": 0, "output": "successful finish",
                })
                assert reply.status_code == 200, reply.text
            finally:
                proceed.set()
            return job.result(timeout=15)

    reply = await asyncio.to_thread(race)
    assert reply.status_code == 200, reply.text
    row = db.execute("SELECT status,exit_code,output FROM worker_runs WHERE run_id=%s", (rid,))[0]
    assert row == {"status": "exited", "exit_code": 0, "output": "successful finish"}
    audits = db.execute("SELECT event_type,detail AS payload FROM events WHERE entity_id=%s", (aid,))
    assert not any(r["event_type"] in {"worker_runs_reconciled", "stranded_run_reaped"} for r in audits)
    for audit in audits:
        if audit["event_type"] == "orphan_lease_reaped":
            assert payload(audit)["reconciled_runs"] == []
    if path != "lease_release":
        assert reply.json()["stranded"] == []


async def test_late_ordinary_finish_updates_diagnostics_without_another_failure(
    make_agent, make_task, db, client,
):
    rid, aid = await new_run(make_agent, make_task, db)
    url = f"/api/runs/{rid}/finish"
    assert (await client.post(url, json={"status": "failed", "exit_code": 1})).status_code == 200
    assert (await client.post(url, json={
        "status": "exited", "exit_code": 0, "output": "late diagnostics", "diff": "+saved",
    })).status_code == 200
    row = db.execute("SELECT status,exit_code,output,diff FROM worker_runs WHERE run_id=%s", (rid,))[0]
    assert row == {"status": "exited", "exit_code": 0, "output": "late diagnostics", "diff": "+saved"}
    assert db.execute("SELECT strikes FROM wake_backoff WHERE agent_id=%s", (aid,))[0]["strikes"] == 1


async def test_late_task_inference_preserves_ordinary_task_attribution(make_agent, make_task, db, client):
    rid, _ = await new_run(make_agent, make_task, db)
    tid = db.execute("SELECT task_id FROM worker_runs WHERE run_id=%s", (rid,))[0]["task_id"]
    db.execute("UPDATE tasks SET status='in_progress' WHERE id=%s", (tid,))
    db.execute("UPDATE worker_runs SET task_id=NULL WHERE run_id=%s", (rid,))
    reply = await client.post(f"/api/runs/{rid}/finish", json={"status": "exited", "exit_code": 0})
    assert reply.status_code == 200, reply.text
    assert str(db.execute("SELECT task_id FROM worker_runs WHERE run_id=%s", (rid,))[0]["task_id"]) == str(tid)
