"""Workflow launch/stop safety on the real isolated database and bootstrap boundary."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from fastapi import HTTPException

from portal_backend.database import db_cursor
from portal_backend.workflow_worker_auth import bound_next, lock_run, record_runner_contact
from portal_backend.workflow_worker_launch import (
    abort_launch, activate, continue_turn, launch_receipt, preallocate_run, require_runner,
)
from portal_backend.workflow_worker_stops import confirm_stopped, release_lost, stop_execution
from portal_backend.workflow_scheduling import release_deadline, task_display
from orcha_cli.workflow_bootstrap import activate_and_exec
from orcha_cli.notifier_workflow import reserve_then_spawn


NOW = datetime(2026, 10, 25, 12, tzinfo=timezone.utc)


@pytest.fixture
async def turn(container, make_agent, make_task, db):
    human = (await make_agent("Owner", kind="human"))["agent_id"]
    aid = (await make_agent("Worker"))["agent_id"]
    tid = (await make_task("Build", "Working result", assignee_alias="Worker"))["id"]
    wid, eid = [str(uuid4()) for _ in range(2)]
    db.execute("INSERT INTO workflows(id,container_id,owner_human_id,created_by_human_id,title,goal,launch_enabled) VALUES (%s,%s,%s,%s,'Ship','Ship safely',true)", (wid, container["id"], human, human))
    db.execute("UPDATE tasks SET workflow_id=%s,status='in_progress',preparation_state='prepared' WHERE id=%s", (wid, tid))
    db.execute("INSERT INTO workflow_executions(id,workflow_id,task_id,generation,work_revision,claimant_id,source_kind,exclusive,state) VALUES (%s,%s,%s,1,1,%s,'worker',true,'reserved')", (eid, wid, tid, aid))
    with db_cursor() as (_, cur):
        runner = require_runner(cur, aid)
        cur.execute("SELECT * FROM workflow_executions WHERE id=%s", (eid,))
        launch = preallocate_run(cur, cur.fetchone(), runner, operation_key="first", payload={"task_id": tid}, now=NOW)
    return dict(aid=aid, human=human, tid=tid, wid=wid, eid=eid, runner=runner, launch=launch)


def activate_turn(turn, process="a" * 32, pid=123):
    with db_cursor() as (_, cur):
        _, _, e = lock_run(cur, turn["launch"]["run_id"])
        return activate(cur, e, aid=turn["aid"], run_id=turn["launch"]["run_id"], permit=turn["launch"]["permit"], process_key=process, pid=pid, now=NOW)


def terminalize(cur, run_id, status, *, cause):
    # This is the sole external collaborator: production uses the durable evidence
    # service. Assertions below verify ordering, rollback, and exact run identity.
    cur.execute("UPDATE worker_runs SET status=%s,ended_at=%s WHERE run_id=%s", (status, NOW, run_id))
    cur.execute("UPDATE workflow_executions SET generation_revoked_at=%s WHERE run_id=%s", (NOW, run_id))


def request_stop(turn, origin="task_stop", now=NOW, key="stop"):
    with db_cursor() as (_, cur):
        _, _, e = lock_run(cur, turn["launch"]["run_id"])
        return stop_execution(cur, e, origin=origin, actor_id=turn["human"], reason="Stop safely", operation_key=key, now=now)


async def test_reserved_is_inert_and_receipt_reuses_run(turn, db):
    assert db.execute("SELECT status,pid FROM worker_runs")[0] == {"status": "reserved", "pid": None}
    assert db.execute("SELECT run_token FROM embodiment_tokens WHERE run_id=%s", (turn["launch"]["run_id"],)) == []
    with db_cursor() as (_, cur):
        assert launch_receipt(cur, turn["runner"], "first", {"task_id": turn["tid"]}) == turn["launch"]
        with pytest.raises(HTTPException):
            launch_receipt(cur, turn["runner"], "first", {"task_id": "another"})


async def test_only_one_process_consumes_and_same_process_retry_is_idempotent(turn, db):
    def contender(i):
        try:
            return activate_turn(turn, str(i) * 32, 123 + i)
        except HTTPException as exc:
            return exc.detail["code"]
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(contender, (1, 2)))
    assert sum(isinstance(r, dict) for r in results) == 1
    assert "permit_consumed" in results
    winner = next(i for i, r in zip((1, 2), results) if isinstance(r, dict))
    assert activate_turn(turn, str(winner) * 32, 123 + winner) == results[winner - 1]
    assert len(db.execute("SELECT run_token FROM embodiment_tokens WHERE run_id=%s", (turn["launch"]["run_id"],))) == 1


async def test_bound_next_returns_same_reserved_task_and_fences_late_next(turn):
    token = activate_turn(turn)["run_token"]
    with db_cursor() as (_, cur):
        assert bound_next(cur, turn["aid"], token)["task"]["id"] == turn["tid"]
        assert bound_next(cur, turn["aid"], token)["task"]["id"] == turn["tid"]
    request_stop(turn)
    with db_cursor() as (_, cur), pytest.raises(HTTPException) as rejected:
        bound_next(cur, turn["aid"], token)
    assert rejected.value.detail["code"] == "stale_generation"


@pytest.mark.parametrize("activated", [False, True])
async def test_cancel_at_launch_boundaries_never_authorizes_new_work(turn, db, activated):
    if activated:
        activate_turn(turn)
    db.execute("UPDATE tasks SET status='cancelled' WHERE id=%s", (turn["tid"],))
    request_stop(turn, "workflow_cancel")
    with pytest.raises(HTTPException):
        activate_turn(turn)
    with db_cursor() as (_, cur):
        _, _, e = lock_run(cur, turn["launch"]["run_id"])
        if activated:
            with pytest.raises(HTTPException) as rejected:
                abort_launch(cur, e, run_id=e["run_id"], terminalize=terminalize)
            assert rejected.value.detail["code"] == "launch_uncertain"
        else:
            assert abort_launch(cur, e, run_id=e["run_id"], terminalize=terminalize)["state"] == "aborted"
    assert db.execute("SELECT status FROM tasks WHERE id=%s", (turn["tid"],))[0]["status"] == "cancelled"


async def test_expired_permit_no_activation_and_abort_keeps_hold(turn, db):
    with db_cursor() as (_, cur):
        _, _, e = lock_run(cur, turn["launch"]["run_id"])
        with pytest.raises(HTTPException):
            activate(cur, e, aid=turn["aid"], run_id=e["run_id"], permit=turn["launch"]["permit"], process_key="a" * 32, pid=123, now=NOW + timedelta(minutes=2))
    request_stop(turn)
    with db_cursor() as (_, cur):
        _, _, e = lock_run(cur, turn["launch"]["run_id"])
        abort_launch(cur, e, run_id=e["run_id"], terminalize=terminalize)
    assert db.execute("SELECT status,awaiting_owner_decision FROM tasks WHERE id=%s", (turn["tid"],))[0] == {"status": "not_ready", "awaiting_owner_decision": "stopped_by_owner"}


async def test_rejected_contact_persists_and_reissue_does_not_reset_clock(turn, db):
    token = activate_turn(turn)["run_token"]
    request_stop(turn)
    request_stop(turn, "recovery_reissue", NOW + timedelta(minutes=20), "again")
    e = db.execute("SELECT * FROM workflow_executions WHERE id=%s", (turn["eid"],))[0]
    assert release_deadline(e) == NOW + timedelta(minutes=30)
    with db_cursor() as (_, cur):
        record_runner_contact(cur, token, now=NOW + timedelta(minutes=10))
    # Route rejection rolls back its own transaction, not the contact observation.
    with pytest.raises(HTTPException), db_cursor() as (_, cur):
        bound_next(cur, turn["aid"], token)
    e = db.execute("SELECT * FROM workflow_executions WHERE id=%s", (turn["eid"],))[0]
    assert release_deadline(e) == NOW + timedelta(minutes=40)
    with db_cursor() as (_, cur), pytest.raises(HTTPException) as rejected:
        release_lost(cur, e, actor_id=turn["human"], reason="Unreachable", terminalize=terminalize, now=NOW + timedelta(minutes=30))
    assert rejected.value.detail["code"] == "release_not_yet_available"
    assert not task_display({"status": "not_ready", "awaiting_owner_decision": "stopped_by_owner"}, e, now=NOW + timedelta(minutes=30))["release_available"]


@pytest.mark.parametrize("outcome,gate", [("cancelled", None), ("completed", None), ("not_ready", "changes_requested"), ("not_ready", "stopped_by_owner")])
async def test_lost_release_exact_deadline_preserves_outcome_and_never_claims_death(turn, db, outcome, gate):
    token = activate_turn(turn)["run_token"]
    db.execute("UPDATE tasks SET status=%s,awaiting_owner_decision=%s WHERE id=%s", (outcome, gate, turn["tid"]))
    request_stop(turn, "workflow_cancel")
    with db_cursor() as (_, cur):
        _, _, e = lock_run(cur, turn["launch"]["run_id"])
        with pytest.raises(HTTPException):
            release_lost(cur, e, actor_id=turn["human"], reason="Unreachable", terminalize=terminalize, now=NOW + timedelta(minutes=30, microseconds=-1))
        release_lost(cur, e, actor_id=turn["human"], reason="Unreachable", terminalize=terminalize, now=NOW + timedelta(minutes=30))
    task = db.execute("SELECT * FROM tasks WHERE id=%s", (turn["tid"],))[0]
    assert (task["status"], task["awaiting_owner_decision"]) == (outcome, gate)
    e = db.execute("SELECT * FROM workflow_executions WHERE id=%s", (turn["eid"],))[0]
    assert e["worker_stopped_at"] is None
    assert task_display(task, e)["warning"]
    with db_cursor() as (_, cur), pytest.raises(HTTPException) as rejected:
        release_lost(cur, e, actor_id=turn["human"], reason="Again", terminalize=terminalize, now=NOW + timedelta(hours=1))
    assert rejected.value.detail["code"] == "already_released"
    with db_cursor() as (_, cur), pytest.raises(HTTPException):
        bound_next(cur, turn["aid"], token)


async def test_terminal_evidence_failure_rolls_back_release(turn, db):
    activate_turn(turn)
    request_stop(turn)
    def unavailable(*args, **kwargs):
        raise RuntimeError("evidence unavailable")
    with pytest.raises(RuntimeError), db_cursor() as (_, cur):
        _, _, e = lock_run(cur, turn["launch"]["run_id"])
        release_lost(cur, e, actor_id=turn["human"], reason="Unreachable", terminalize=unavailable, now=NOW + timedelta(hours=1))
    assert db.execute("SELECT state FROM workflow_executions WHERE id=%s", (turn["eid"],))[0]["state"] == "stopping"
    assert db.execute("SELECT ended_at FROM worker_runs WHERE run_id=%s", (turn["launch"]["run_id"],))[0]["ended_at"] is None


async def test_continuation_requires_positive_exit_preserves_turn_and_fences_old_observation(turn, db):
    old_token = activate_turn(turn)["run_token"]
    with db_cursor() as (_, cur):
        _, _, e = lock_run(cur, turn["launch"]["run_id"])
        with pytest.raises(HTTPException):
            continue_turn(cur, e, turn["runner"], operation_key="next", payload={})
        confirm_stopped(cur, e, run_id=e["run_id"], generation=1, terminalize=terminalize, now=NOW)
    db.execute("UPDATE workflows SET status='paused' WHERE id=%s", (turn["wid"],))
    with db_cursor() as (_, cur):
        _, _, e = lock_run(cur, turn["launch"]["run_id"])
        new = continue_turn(cur, e, turn["runner"], operation_key="next", payload={}, now=NOW)
    assert new["execution_id"] == turn["eid"] and new["generation"] == 2
    assert db.execute("SELECT work_revision FROM tasks WHERE id=%s", (turn["tid"],))[0]["work_revision"] == 1
    with db_cursor() as (_, cur):
        _, _, e = lock_run(cur, new["run_id"])
        with pytest.raises(HTTPException):
            confirm_stopped(cur, e, run_id=turn["launch"]["run_id"], generation=1, terminalize=terminalize)
        record_runner_contact(cur, old_token, now=NOW + timedelta(hours=1))
    assert db.execute("SELECT last_runner_contact_at FROM workflow_executions WHERE id=%s", (turn["eid"],))[0]["last_runner_contact_at"] is None


@pytest.mark.parametrize("response", [None, {}, {"run_token": "secret", "run_id": "wrong"}])
def test_bootstrap_never_executes_on_unknown_activation(response):
    calls = []
    cfg = dict(run_id="run", agent_id="agent", task_id="task", permit="permit", generation=1, api_base="http://test", command=["agent-cli"])
    assert activate_and_exec(cfg, post=lambda *a: response, exec_process=lambda *a: calls.append(a)) == 75
    assert calls == []


def test_bootstrap_success_executes_only_after_activation_and_strips_runner_secret(monkeypatch):
    monkeypatch.setenv("ORCHA_WORKFLOW_RUNNER_TOKEN", "runner-only")
    sequence = []
    cfg = dict(run_id="run", agent_id="agent", task_id="task", permit="permit", generation=1, api_base="http://test", command=["agent-cli"])
    def post(*args):
        sequence.append("activate")
        return {"run_token": "work-only", "run_id": "run", "task_id": "task", "generation": 1}
    def execute(file, command, env):
        sequence.append("execute")
        assert env["ORCHA_RUN_TOKEN"] == "work-only" and "ORCHA_WORKFLOW_RUNNER_TOKEN" not in env
    assert activate_and_exec(cfg, post=post, exec_process=execute) == 0
    assert sequence == ["activate", "execute"]


def test_notifier_never_prepares_or_spawns_before_reservation():
    calls = []
    result = reserve_then_spawn(api_base="http://test", agent_id="agent", task_id="task", workflow_revision=1, work_revision=1,
                                operation_key="stable", command=["agent-cli"],
                                post=lambda *a: None, prepare=lambda: calls.append("prepare"), spawn=lambda *a, **k: calls.append("spawn"))
    assert result is None and not calls


async def test_api_reserve_needs_no_credential_but_an_active_ai_agent_that_nobody_revoked(turn, client, db):
    body = {"task_id": turn["tid"], "expected_workflow_revision": 1, "expected_work_revision": 1, "operation_key": "api"}
    # A person is not a launchable teammate, and an unknown id is not an agent at all.
    for aid in (turn["human"], str(uuid4())):
        response = await client.post(f"/api/agents/{aid}/runs/reserve", json=body)
        assert response.status_code == 403 and response.json()["detail"]["code"] == "runner_agent_invalid"
    # A terminated teammate cannot start work either.
    db.execute("UPDATE agents SET terminated_at=now() WHERE id=%s", (turn["aid"],))
    response = await client.post(f"/api/agents/{turn['aid']}/runs/reserve", json=body)
    assert response.status_code == 403 and response.json()["detail"]["code"] == "runner_agent_invalid"
    db.execute("UPDATE agents SET terminated_at=NULL WHERE id=%s", (turn["aid"],))
    # An explicit person-set revoke is a hold: launching stays off until it is cleared.
    db.execute("UPDATE workflow_runner_credentials SET revoked_at=now() WHERE agent_id=%s", (turn["aid"],))
    response = await client.post(f"/api/agents/{turn['aid']}/runs/reserve", json=body)
    assert response.status_code == 403 and response.json()["detail"]["code"] == "runner_revoked"


async def test_api_reserve_real_scheduler_replay_activate_and_serial_capacity(turn, client, db, monkeypatch, make_task):
    from portal_backend import workflow_service, workflow_worker_routes
    class Available(workflow_worker_routes.WorkflowWorkerHooks):
        def availability(self, cur, task):
            return {"available": True}
    monkeypatch.setattr(workflow_service, "WORKFLOWS_INTEGRATED", True)
    monkeypatch.setattr(workflow_worker_routes, "runtime_hooks_factory", Available)
    # Begin with no execution: the real scheduler, not this test, must reserve it.
    db.execute("DELETE FROM workflow_launch_permits WHERE execution_id=%s", (turn["eid"],))
    db.execute("DELETE FROM workflow_executions WHERE id=%s", (turn["eid"],))
    db.execute("DELETE FROM worker_runs WHERE run_id=%s", (turn["launch"]["run_id"],))
    db.execute("UPDATE tasks SET status='ready' WHERE id=%s", (turn["tid"],))
    body = {"task_id": turn["tid"], "expected_workflow_revision": 1, "expected_work_revision": 1, "operation_key": "api"}
    url = f"/api/agents/{turn['aid']}/runs/reserve"
    response = await client.post(url, json=body)
    assert response.status_code == 201, response.text
    launch = response.json()
    assert (await client.post(url, json=body)).json() == launch
    assert db.execute("SELECT status,pid FROM worker_runs WHERE run_id=%s", (launch["run_id"],))[0] == {"status": "reserved", "pid": None}
    second = (await make_task("Other", "Other result", assignee_alias="Worker"))["id"]
    db.execute("UPDATE tasks SET workflow_id=%s,status='ready',preparation_state='prepared' WHERE id=%s", (turn["wid"], second))
    revision = db.execute("SELECT revision FROM workflows WHERE id=%s", (turn["wid"],))[0]["revision"]
    refused = await client.post(url, json={**body, "task_id": second, "expected_workflow_revision": revision, "operation_key": "other"})
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "not_eligible"
    activated = await client.post(f"/api/agents/{turn['aid']}/runs/{launch['run_id']}/activate", json={"permit": launch["permit"], "process_key": "a" * 32, "pid": 123})
    assert activated.status_code == 200, activated.text
    assert activated.json()["task_id"] == turn["tid"]


async def test_api_revoked_worker_contact_is_saved_even_when_message_is_refused(turn, client, db):
    token = activate_turn(turn)["run_token"]
    request_stop(turn)
    before = db.execute("SELECT last_runner_contact_at FROM workflow_executions WHERE id=%s", (turn["eid"],))[0]["last_runner_contact_at"]
    response = await client.post(f"/api/tasks/{turn['tid']}/messages", json={"author_agent_id": turn["aid"], "body": "Late result"}, headers={"X-Orcha-Run-Token": token})
    assert response.status_code == 409 and response.json()["detail"]["code"] == "stale_generation"
    after = db.execute("SELECT last_runner_contact_at FROM workflow_executions WHERE id=%s", (turn["eid"],))[0]["last_runner_contact_at"]
    assert after > before
    assert not db.execute("SELECT id FROM task_messages WHERE task_id=%s AND body='Late result'", (turn["tid"],))


async def test_legacy_run_creation_refuses_workflow_and_policy_is_explicit(turn, client):
    response = await client.post(f"/api/agents/{turn['aid']}/runs", json={"task_id": turn["tid"], "wake_kind": "live"})
    assert response.status_code == 409 and response.json()["detail"]["code"] == "workflow_reservation_required"
    policy = (await client.get(f"/api/tasks/{turn['tid']}/worker-launch-policy")).json()
    assert policy["requires_reservation"] and policy["workflow_id"] == turn["wid"]


@pytest.mark.parametrize("revocation", ["stop", "cancel", "review", "assignment", "orphan_only"])
async def test_continuation_cannot_bypass_stop_or_current_ownership(turn, db, revocation):
    activate_turn(turn)
    if revocation == "orphan_only":
        with db_cursor() as (_, cur):
            terminalize(cur, turn["launch"]["run_id"], "orphaned", cause="expired_lease")
    else:
        with db_cursor() as (_, cur):
            _, _, e = lock_run(cur, turn["launch"]["run_id"])
            confirm_stopped(cur, e, run_id=e["run_id"], generation=1, terminalize=terminalize, now=NOW)
    if revocation == "stop":
        request_stop(turn)
    elif revocation == "cancel":
        db.execute("UPDATE workflows SET status='cancelled' WHERE id=%s", (turn["wid"],))
    elif revocation == "review":
        db.execute("UPDATE tasks SET status='needs_verification' WHERE id=%s", (turn["tid"],))
    elif revocation == "assignment":
        db.execute("UPDATE agent_tasks SET assignment_status='done' WHERE task_id=%s", (turn["tid"],))
    with db_cursor() as (_, cur), pytest.raises(HTTPException) as rejected:
        _, _, e = lock_run(cur, turn["launch"]["run_id"])
        continue_turn(cur, e, turn["runner"], operation_key="new", payload={})
    assert rejected.value.detail["code"] == "continuation_not_allowed"


async def test_wrong_agent_or_runner_cannot_consume_or_release(turn, make_agent, client, monkeypatch):
    from portal_backend import workflow_service
    monkeypatch.setattr(workflow_service, "WORKFLOWS_INTEGRATED", True)
    other = (await make_agent("Another"))["agent_id"]
    endpoint = f"/api/agents/{other}/runs/{turn['launch']['run_id']}"
    response = await client.post(endpoint + "/activate", json={"permit": turn["launch"]["permit"], "process_key": "a" * 32, "pid": 123})
    assert response.status_code == 403
    response = await client.post(endpoint + "/abort-launch")
    assert response.status_code == 403
    response = await client.post(endpoint + "/confirm-stopped", json={"generation": 1})
    assert response.status_code == 403


def test_existing_notifier_reserves_before_checkout_and_uses_preallocated_run(monkeypatch, tmp_path):
    from types import SimpleNamespace
    from orcha_cli import notifier, notifier_wake_worker, notifier_workflow
    sequence, posts, live = [], [], {}
    launch = dict(run_id="run", execution_id="execution", generation=1, permit="permit", task_id="task", agent_id="agent", api_base="http://test")
    candidate = dict(agent_id="agent", alias="Worker", context_task_id="task", workflow_id="workflow", headless_cwd=str(tmp_path))
    monkeypatch.setattr(notifier, "_post_json", lambda url, body: posts.append(url) or {"claimed": True})
    monkeypatch.setattr(notifier, "_build_persona", lambda *a, **k: ("persona", False))
    monkeypatch.setattr(notifier_workflow, "reserve_candidate", lambda *a: sequence.append("reserve") or launch)
    monkeypatch.setattr(notifier_wake_worker, "_worktree_for", lambda *a: sequence.append("checkout") or (str(tmp_path), "branch", True))
    monkeypatch.setattr(notifier_wake_worker, "carry_previous_checkout", lambda *a, **k: True)
    def forbidden(*a, **k):
        pytest.fail("legacy token minted before activation")
    monkeypatch.setattr(notifier, "_mint_embodiment_token", forbidden)
    def spawn(*a, **kw):
        sequence.append("spawn")
        assert kw["workflow_launch"] == launch and kw["run_token"] is None
        return True, "inert bootstrap", SimpleNamespace(pid=123)
    monkeypatch.setattr(notifier, "spawn_headless", spawn)
    result = notifier_wake_worker.spawn("http://test", candidate, prompt="work", event="ready", dry_run=False,
                                        quiet=True, lease_ttl=60, live_workers=live, services=notifier)
    assert result["sent"] and sequence == ["reserve", "checkout", "spawn"]
    assert live["agent"]["run_id"] == "run" and live["agent"]["workflow_generation"] == 1
    assert not any(url.endswith("/runs") for url in posts)


def test_checkpoint_and_uncertain_exit_never_start_another_worker(monkeypatch):
    from types import SimpleNamespace
    from orcha_cli import notifier_checkpoint, notifier_workflow
    worker = {"workflow": True, "proc": SimpleNamespace(poll=lambda: None)}
    notifier_checkpoint.checkpoint_and_respawn("http://test", "agent", worker, {}, True, SimpleNamespace(HARD_CAP_RESPAWN_MAX=3))
    assert worker["workflow_checkpoint_unsupported"]
    assert not notifier_workflow.confirm_exit("http://test", "agent", worker)


def test_headless_leaf_runs_only_inert_bootstrap_and_withholds_runner_secret(monkeypatch, tmp_path):
    import io
    import json
    import sys
    from types import SimpleNamespace
    from orcha_cli import notifier, notifier_headless
    captured = {}
    monkeypatch.setenv("ORCHA_WORKFLOW_RUNNER_CREDENTIALS", '{"agent":"runner-secret"}')
    monkeypatch.setattr(notifier, "_resolve_runtime_executable", lambda *a: sys.executable)
    monkeypatch.setattr(notifier, "_inject_agent_key", lambda *a: None)
    def forbidden(*a, **k):
        pytest.fail("model CLI probed before activation")
    monkeypatch.setattr(notifier_headless, "codex_supports_hook_trust_bypass", forbidden)
    class Pipe(io.BytesIO):
        def close(self):
            captured["config"] = json.loads(self.getvalue())
            super().close()
    def popen(argv, **kwargs):
        captured.update(argv=argv, kwargs=kwargs)
        return SimpleNamespace(pid=123, stdin=Pipe())
    monkeypatch.setattr(notifier.subprocess, "Popen", popen)
    launch = dict(run_id="run", task_id="task", agent_id="agent", permit="permit", generation=1, api_base="http://test")
    sent, _, _ = notifier_headless.spawn_headless(str(tmp_path), "task work", None, False, runtime="codex", workflow_launch=launch, services=notifier)
    assert sent and captured["argv"][1].endswith("workflow_bootstrap.py")
    assert "exec" in captured["config"]["command"]
    assert "ORCHA_WORKFLOW_RUNNER_CREDENTIALS" not in captured["kwargs"]["env"]


@pytest.mark.parametrize("state,task_status,expected", [("stopping", "cancelled", "released"), ("awaiting_review", "needs_verification", "awaiting_review")])
async def test_positive_exit_releases_stopped_work_but_keeps_review_turn(turn, db, state, task_status, expected):
    activate_turn(turn)
    db.execute("UPDATE workflow_executions SET state=%s WHERE id=%s", (state, turn["eid"]))
    db.execute("UPDATE tasks SET status=%s WHERE id=%s", (task_status, turn["tid"]))
    with db_cursor() as (_, cur):
        _, _, e = lock_run(cur, turn["launch"]["run_id"])
        assert confirm_stopped(cur, e, run_id=e["run_id"], generation=1, terminalize=terminalize)["state"] == expected
    assert db.execute("SELECT worker_stopped_at FROM workflow_executions WHERE id=%s", (turn["eid"],))[0]["worker_stopped_at"]


@pytest.mark.parametrize("autonomy,accepted_by", [("off", "human"), ("on", "ai")])
async def test_workflow_done_preserves_evidence_and_uses_task_only_acceptance(
    turn, client, db, autonomy, accepted_by
):
    token = activate_turn(turn)["run_token"]
    db.execute(
        "UPDATE tasks SET autonomy=%s,autonomy_revision=2 WHERE id=%s",
        (autonomy, turn["tid"]),
    )
    submitted = await client.post(
        f"/api/tasks/{turn['tid']}/done",
        json={"agent_id": turn["aid"], "result": "Saved workflow result"},
        headers={"X-Orcha-Run-Token": token},
    )
    assert submitted.status_code == 200, submitted.text
    assert submitted.json()["status"] == "needs_verification"
    evidence = submitted.json()["evidence"]
    assert evidence["state"] == "pending"

    finished = await client.post(
        f"/api/runs/{turn['launch']['run_id']}/finish",
        json={"status": "exited", "exit_code": 0, "output": "tests passed", "diff": ""},
    )
    assert finished.status_code == 200, finished.text
    stopped = await client.post(
        f"/api/agents/{turn['aid']}/runs/{turn['launch']['run_id']}/confirm-stopped",
        json={"generation": 1},
    )
    assert stopped.status_code == 200, stopped.text

    if autonomy == "off":
        assert db.execute("SELECT status FROM tasks WHERE id=%s", (turn["tid"],))[0]["status"] == "needs_verification"
        approved = await client.post(
            f"/api/tasks/{turn['tid']}/verify",
            json={"approve": True, "actor_agent_id": turn["human"]},
        )
        assert approved.status_code == 200, approved.text
    else:
        assert stopped.json()["task_status"] == "completed"

    task = db.execute("SELECT status FROM tasks WHERE id=%s", (turn["tid"],))[0]
    assert task["status"] == "completed"
    acceptance = db.execute(
        "SELECT actor_kind,autonomy_at_acceptance,autonomy_revision,evidence_set_id "
        "FROM workflow_task_acceptances WHERE task_id=%s",
        (turn["tid"],),
    )[0]
    assert acceptance["actor_kind"] == accepted_by
    assert acceptance["autonomy_at_acceptance"] == autonomy
    assert acceptance["autonomy_revision"] == 2
    assert str(acceptance["evidence_set_id"]) == evidence["evidence_set_id"]
    saved = db.execute(
        "SELECT state FROM workflow_evidence_sets WHERE id=%s", (evidence["evidence_set_id"],)
    )[0]
    assert saved["state"] == "saved"


async def test_ordinary_run_token_contact_check_never_opens_a_write_transaction(db, monkeypatch):
    from portal_backend import workflow_worker_routes
    opened = []
    real = workflow_worker_routes.db_cursor
    def recording(*a, **k):
        opened.append(k.get("readonly", False))
        return real(*a, **k)
    monkeypatch.setattr(workflow_worker_routes, "db_cursor", recording)
    assert workflow_worker_routes._contact("ordinary-non-workflow-token") is None
    assert opened == [True]
