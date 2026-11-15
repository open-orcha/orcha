"""GH #343 review round 1: the last gates before a worker or command acts on a paused task.

A worker spawned just before the pause, a reserved or continuing workflow step, and a
managed command that outlived its worker must all stop; and a person's own pause on a
step the workflow already paused must survive the workflow's resume.
"""

import hashlib
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from fastapi import HTTPException

from portal_backend.database import db_cursor
from portal_backend.task_pause import pause_task
from portal_backend.workflow_worker_auth import lock_run
from portal_backend.workflow_worker_launch import continue_turn
from portal_backend.workflow_worker_stops import confirm_stopped
from test_gh312_job_supervisor import service  # noqa: F401 (fixture)
from test_gh312_managed_jobs import publish, reserve
from test_gh312_managed_messages import managed  # noqa: F401 (fixture)
from test_gh388_job_monitors import finish_worker, monitor_url
from test_workflow_workers import NOW, activate_turn, terminalize, turn  # noqa: F401 (fixture)
from test_workflows import create, prepare_and_start, setup_workflow  # noqa: F401 (fixture)


def pause(client, tid, actor, reason="Waiting on legal"):
    return client.post(f"/api/tasks/{tid}/pause", json={"actor_agent_id": actor, "reason": reason})


async def test_a_worker_registered_after_the_pause_is_told_to_stop(
    client, container, make_agent, make_task, db,
):
    human = (await make_agent("Owner", kind="human"))["agent_id"]
    aid = (await make_agent("Builder"))["agent_id"]
    tid = (await make_task("Paused work", "Done", assignee_alias="Builder"))["id"]
    other = (await make_task("Other work", "Done", assignee_alias="Builder"))["id"]
    # The wake scan picked the task; a person pauses it before the spawned worker registers.
    assert (await pause(client, tid, human)).status_code == 200
    late = await client.post(f"/api/agents/{aid}/runs", json={"wake_kind": "ephemeral", "task_id": tid})
    assert late.status_code == 201, late.text
    fine = await client.post(f"/api/agents/{aid}/runs", json={"wake_kind": "ephemeral", "task_id": other})
    assert fine.status_code == 201, fine.text
    rows = {str(r["run_id"]): r for r in db.execute(
        "SELECT run_id, stop_requested_at, stop_requested_by FROM worker_runs WHERE agent_id=%s", (aid,))}
    assert rows[late.json()["run_id"]]["stop_requested_at"] is not None
    assert str(rows[late.json()["run_id"]]["stop_requested_by"]) == human
    assert rows[fine.json()["run_id"]]["stop_requested_at"] is None


@pytest.mark.parametrize("which", ["task", "workflow"])
async def test_a_reserved_workflow_step_does_not_activate_while_paused(turn, db, which):
    if which == "task":
        db.execute("UPDATE tasks SET paused_at=now(), paused_by=%s WHERE id=%s", (turn["human"], turn["tid"]))
    else:
        db.execute("UPDATE workflows SET status='paused' WHERE id=%s", (turn["wid"],))
    with pytest.raises(HTTPException) as refused:
        activate_turn(turn)
    assert refused.value.status_code == 409
    assert not db.execute("SELECT 1 FROM embodiment_tokens WHERE run_id=%s", (turn["launch"]["run_id"],))
    db.execute("UPDATE tasks SET paused_at=NULL, paused_by=NULL WHERE id=%s", (turn["tid"],))
    db.execute("UPDATE workflows SET status='active' WHERE id=%s", (turn["wid"],))
    assert activate_turn(turn)["run_token"]


async def test_a_stopped_workflow_step_gets_no_replacement_worker_while_paused(turn, db):
    activate_turn(turn)
    with db_cursor() as (_, cur):
        _, _, e = lock_run(cur, turn["launch"]["run_id"])
        confirm_stopped(cur, e, run_id=e["run_id"], generation=1, terminalize=terminalize, now=NOW)
    db.execute("UPDATE tasks SET paused_at=now(), paused_by=%s WHERE id=%s", (turn["human"], turn["tid"]))
    with db_cursor() as (_, cur):
        _, _, e = lock_run(cur, turn["launch"]["run_id"])
        with pytest.raises(HTTPException) as refused:
            continue_turn(cur, e, turn["runner"], operation_key="next", payload={}, now=NOW)
    assert "paused" in str(refused.value.detail)
    assert db.execute("SELECT generation FROM workflow_executions WHERE id=%s", (turn["eid"],))[0]["generation"] == 1


async def test_pausing_stops_a_command_that_outlived_its_worker(client, managed, db, make_agent):
    await publish(client, managed)
    secret = "a" * 43
    job = await reserve(client, managed, job_key=str(uuid4()), continuation_contract="readonly_single_process_v1",
                        continue_after_exit=True,
                        continuation_capability_digest=hashlib.sha256(secret.encode()).hexdigest())
    path = monitor_url(managed, job, "continuation-heartbeat")
    args = {"capability": secret, "launch_nonce": job["launch_nonce"]}
    await finish_worker(client, managed)
    assert (await client.post(path, json=args)).status_code == 200  # still allowed to continue
    human = (await make_agent("Owner", kind="human"))["agent_id"]
    paused = await pause(client, managed["tid"], human)
    assert paused.status_code == 200, paused.text
    monitor = db.execute("SELECT revoked_at, stop_reason FROM managed_job_monitors")[0]
    assert monitor["revoked_at"] and monitor["stop_reason"] == "task_paused"
    assert (await client.post(path, json=args)).status_code == 409


async def test_a_paused_task_refuses_continuation_even_without_a_revoked_monitor(client, managed, db):
    await publish(client, managed)
    secret = "a" * 43
    job = await reserve(client, managed, job_key=str(uuid4()), continuation_contract="readonly_single_process_v1",
                        continue_after_exit=True,
                        continuation_capability_digest=hashlib.sha256(secret.encode()).hexdigest())
    await finish_worker(client, managed)
    db.execute("UPDATE tasks SET paused_at=now() WHERE id=%s", (managed["tid"],))
    heartbeat = await client.post(monitor_url(managed, job, "continuation-heartbeat"),
                                  json={"capability": secret, "launch_nonce": job["launch_nonce"]})
    assert heartbeat.status_code == 409
    assert db.execute("SELECT stop_reason FROM managed_job_monitors")[0]["stop_reason"] == "task_paused"


def test_a_persons_pause_after_the_workflows_survives_workflow_resume(setup_workflow):
    cid, actor, worker, other_human, hooks, execute = setup_workflow
    w = prepare_and_start(setup_workflow, create(setup_workflow, mode="parallel", count=1))
    tid = w["tasks"][0]["id"]
    execute("pause", {}, w["id"])
    with db_cursor() as (_, cur):
        cur.execute("SELECT * FROM tasks WHERE id=%s", (tid,))
        row = cur.fetchone()
        assert row["paused_via_workflow"]
        result = pause_task(cur, row, other_human, "Mine")
    assert result["already_paused"] and result["took_over"]
    execute("resume", {}, w["id"])
    with db_cursor() as (_, cur):
        cur.execute("SELECT paused_at, paused_by, paused_reason, paused_via_workflow FROM tasks WHERE id=%s", (tid,))
        row = cur.fetchone()
    assert row["paused_at"] is not None and not row["paused_via_workflow"]
    assert str(row["paused_by"]) == other_human and row["paused_reason"] == "Mine"


# Review round 2: a general notification (no task on the wake) must not hand a paused
# task to the worker it starts, yet must still let the agent do its inbox work.

def _backdate_pause(db, tid):
    db.execute("UPDATE tasks SET paused_at=%s WHERE id=%s",
               (datetime.now(timezone.utc) - timedelta(minutes=10), tid))


async def _notification_worker(client, aid):
    claim = await client.post(f"/api/agents/{aid}/wake-claim", json={"lease_ttl": 300})
    assert claim.status_code == 200, claim.text
    protocol = (await client.get(f"/api/agents/{aid}/protocol")).json()
    run = await client.post(f"/api/agents/{aid}/runs", json={"wake_kind": "ephemeral"})
    assert run.status_code == 201, run.text
    return protocol, run.json()


def _stop(db, run_id):
    return db.execute("SELECT stop_requested_at, stop_requested_by FROM worker_runs WHERE run_id=%s",
                      (run_id,))[0]


async def test_a_notification_worker_never_takes_on_a_paused_task(client, container, make_agent, make_task, db):
    human = (await make_agent("Owner", kind="human"))["agent_id"]
    aid = (await make_agent("Builder"))["agent_id"]
    tid = (await make_task("Paused work", "Done", assignee_alias="Builder"))["id"]
    assert (await pause(client, tid, human)).status_code == 200
    _backdate_pause(db, tid)
    protocol, run = await _notification_worker(client, aid)
    assert protocol["task_id"] is None  # the paused task's instructions are not served
    assert run["task_id"] is None  # and it is not attached to the worker
    assert _stop(db, run["run_id"])["stop_requested_at"] is None  # inbox work goes on
    other = (await make_task("Other work", "Done", assignee_alias="Builder"))["id"]
    db.execute("UPDATE worker_runs SET status='exited' WHERE run_id=%s", (run["run_id"],))
    db.execute("UPDATE agent_wake_state SET wake_lease_until=NULL, work_run_id=NULL WHERE agent_id=%s", (aid,))
    protocol, run = await _notification_worker(client, aid)
    assert protocol["task_id"] == other and run["task_id"] == other  # the unpaused task still is
    assert _stop(db, run["run_id"])["stop_requested_at"] is None


async def test_a_notification_worker_is_stopped_when_the_pause_lands_after_its_claim(
    client, container, make_agent, make_task, db,
):
    human = (await make_agent("Owner", kind="human"))["agent_id"]
    aid = (await make_agent("Builder"))["agent_id"]
    tid = (await make_task("Work", "Done", assignee_alias="Builder"))["id"]
    claim = await client.post(f"/api/agents/{aid}/wake-claim", json={"lease_ttl": 300})
    assert claim.status_code == 200, claim.text
    # The protocol read right after the claim served this task; then a person pauses it.
    assert (await client.get(f"/api/agents/{aid}/protocol")).json()["task_id"] == tid
    assert (await pause(client, tid, human)).status_code == 200
    run = await client.post(f"/api/agents/{aid}/runs", json={"wake_kind": "ephemeral"})
    assert run.status_code == 201, run.text
    assert run.json()["task_id"] is None
    stop = _stop(db, run.json()["run_id"])
    assert stop["stop_requested_at"] is not None and str(stop["stop_requested_by"]) == human


async def test_a_notification_worker_attached_to_another_task_still_stops_for_a_fresh_pause(
    client, container, make_agent, make_task, db,
):
    human = (await make_agent("Owner", kind="human"))["agent_id"]
    aid = (await make_agent("Builder"))["agent_id"]
    other = (await make_task("Other work", "Done", assignee_alias="Builder"))["id"]
    newest = (await make_task("Newest work", "Done", assignee_alias="Builder"))["id"]
    db.execute("UPDATE tasks SET started_at=%s WHERE id=%s",
               (datetime.now(timezone.utc) - timedelta(hours=1), other))
    assert (await client.post(f"/api/agents/{aid}/wake-claim", json={"lease_ttl": 300})).status_code == 200
    # The protocol read served the newest task; it is paused before the worker registers,
    # so inference now attaches the other task, but the prompt holds the paused one.
    assert (await client.get(f"/api/agents/{aid}/protocol")).json()["task_id"] == newest
    assert (await pause(client, newest, human)).status_code == 200
    run = await client.post(f"/api/agents/{aid}/runs", json={"wake_kind": "ephemeral"})
    assert run.status_code == 201, run.text
    assert run.json()["task_id"] == other
    assert _stop(db, run.json()["run_id"])["stop_requested_at"] is not None
