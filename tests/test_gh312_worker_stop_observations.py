"""Positive worker-exit evidence cannot be inferred from administrative finish."""

from datetime import timedelta
from types import SimpleNamespace

import pytest

from portal_backend.database import db_cursor
from portal_backend.workflow_evidence_service import terminalize_workflow_run_with_evidence
from portal_backend.workflow_worker_auth import lock_run
from portal_backend.workflow_worker_launch import continue_turn
from portal_backend.workflow_worker_stops import confirm_stopped, release_lost
from test_workflow_workers import turn, activate_turn, NOW, request_stop
from test_gh312_managed_messages import managed
from test_gh312_job_supervisor import service


async def test_finish_before_workflow_confirmation_and_generation_reuse_keep_exact_proof(turn, db):
    activate_turn(turn)
    rid = turn['launch']['run_id']
    with db_cursor() as (_, cur):
        terminalize_workflow_run_with_evidence(cur, rid, 'exited', cause='finish')
    first_terminal = db.execute('SELECT * FROM workflow_terminal_receipts WHERE run_id=%s', (rid,))[0]
    assert first_terminal['cause'] == 'finish'
    assert db.execute('SELECT * FROM worker_stop_observations') == []
    with db_cursor() as (_, cur):
        _, _, execution = lock_run(cur, rid)
        confirm_stopped(cur, execution, run_id=rid, generation=1,
                        terminalize=terminalize_workflow_run_with_evidence, now=NOW)
    proof = db.execute('SELECT * FROM worker_stop_observations')[0]
    assert str(proof['run_id']) == rid and proof['generation'] == 1
    assert str(proof['execution_id']) == turn['eid']
    assert proof['source'] == 'workflow_runner'
    assert db.execute('SELECT * FROM workflow_terminal_receipts WHERE run_id=%s', (rid,))[0] == first_terminal
    with db_cursor() as (_, cur):
        _, _, execution = lock_run(cur, rid)
        confirm_stopped(cur, execution, run_id=rid, generation=1,
                        terminalize=terminalize_workflow_run_with_evidence, now=NOW+timedelta(seconds=3))
    assert db.execute('SELECT * FROM worker_stop_observations') == [proof]
    with db_cursor() as (_, cur):
        _, _, execution = lock_run(cur, rid)
        new = continue_turn(cur, execution, turn['runner'], operation_key='replacement', payload={}, now=NOW)
    execution = db.execute('SELECT * FROM workflow_executions')[0]
    assert execution['worker_stopped_at'] is None and execution['generation'] == 2
    assert str(execution['run_id']) == new['run_id']
    assert db.execute('SELECT * FROM worker_stop_observations') == [proof]
    from fastapi import HTTPException
    with pytest.raises(HTTPException), db_cursor() as (_, cur):
        _, _, execution = lock_run(cur, new['run_id'])
        confirm_stopped(cur, execution, run_id=rid, generation=1,
                        terminalize=terminalize_workflow_run_with_evidence)
    assert db.execute('SELECT * FROM worker_stop_observations') == [proof]


async def test_lost_release_is_not_proof_but_later_positive_observation_is(turn, db):
    activate_turn(turn)
    request_stop(turn)
    rid = turn['launch']['run_id']
    with db_cursor() as (_, cur):
        _, _, execution = lock_run(cur, rid)
        release_lost(cur, execution, actor_id=turn['human'], reason='Unreachable',
                     terminalize=terminalize_workflow_run_with_evidence, now=NOW+timedelta(hours=1))
    assert db.execute('SELECT * FROM worker_stop_observations') == []
    with db_cursor() as (_, cur):
        _, _, execution = lock_run(cur, rid)
        response = confirm_stopped(cur, execution, run_id=rid, generation=1,
                                   terminalize=terminalize_workflow_run_with_evidence)
    assert response['state'] == 'released_lost'
    assert db.execute('SELECT generation FROM worker_stop_observations') == [{'generation': 1}]


async def test_stop_observation_rolls_back_with_transaction(turn, db):
    activate_turn(turn)
    rid = turn['launch']['run_id']
    with pytest.raises(RuntimeError), db_cursor() as (_, cur):
        _, _, execution = lock_run(cur, rid)
        confirm_stopped(cur, execution, run_id=rid, generation=1,
                        terminalize=terminalize_workflow_run_with_evidence)
        raise RuntimeError('simulated failure before commit')
    assert db.execute('SELECT * FROM worker_stop_observations') == []
    assert db.execute('SELECT * FROM workflow_terminal_receipts') == []
    assert db.execute('SELECT status FROM worker_runs')[0]['status'] == 'running'


async def test_bootstrap_exit_before_activation_still_records_exact_observation(turn, db):
    rid = turn['launch']['run_id']
    with db_cursor() as (_, cur):
        terminalize_workflow_run_with_evidence(cur, rid, 'failed', cause='finish')
        _, _, execution = lock_run(cur, rid)
        confirm_stopped(cur, execution, run_id=rid, generation=1,
                        terminalize=terminalize_workflow_run_with_evidence)
    assert db.execute('SELECT generation FROM worker_stop_observations') == [{'generation': 1}]
    # Preserve the existing launch/continuation rules: a stop observation does
    # not turn an unactivated reservation into an authorized running worker.
    assert db.execute('SELECT state FROM workflow_executions')[0]['state'] == 'reserved'
    assert db.execute('SELECT * FROM embodiment_tokens WHERE run_id=%s', (rid,)) == []


async def test_real_host_exit_reaches_observation_api(client, managed, db, service):
    import asyncio
    import subprocess
    import sys
    from orcha_cli.notifier_workflow import confirm_exit
    process = subprocess.Popen([sys.executable, '-c', 'raise SystemExit(7)'])
    try:
        db.execute('UPDATE worker_runs SET pid=%s WHERE run_id=%s', (process.pid, managed['rid']))
        assert process.wait(timeout=5) == 7
        assert (await client.post(f"/api/runs/{managed['rid']}/finish",
                                   json={'status': 'failed', 'exit_code': 7})).status_code == 200
        worker = {'run_id': managed['rid'], 'proc': process}
        assert await asyncio.to_thread(confirm_exit, service[0], managed['aid'], worker)
        proof = db.execute('SELECT * FROM worker_stop_observations')[0]
        assert proof['process_id'] == process.pid and proof['exit_code'] == 7
        assert await asyncio.to_thread(confirm_exit, service[0], managed['aid'], worker)
        assert db.execute('SELECT * FROM worker_stop_observations') == [proof]
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)


async def test_host_stop_requires_explicit_exact_observation_after_finish(client, managed, db):
    db.execute('UPDATE worker_runs SET pid=12345 WHERE run_id=%s', (managed['rid'],))
    path = f"/api/runs/{managed['rid']}/managed-stop-observation"
    body = {'process_id': 12345, 'exit_code': -15}
    assert (await client.post(path, json=body)).status_code == 409
    assert (await client.post(f"/api/runs/{managed['rid']}/finish", json={'status': 'killed'})).status_code == 200
    assert db.execute('SELECT * FROM worker_stop_observations') == []
    assert (await client.post(path, json={**body, 'process_id': 23456})).status_code == 409
    response = await client.post(path, json=body)
    assert response.status_code == 200, response.text
    receipt = response.json()
    assert receipt['source'] == 'host_process' and receipt['exit_code'] == -15
    assert (await client.post(path, json=body)).json() == receipt
    assert (await client.post(path, json={**body, 'exit_code': 0})).status_code == 409
    db.execute("UPDATE worker_runs SET sandbox_container_id='temporary-container' WHERE run_id=%s", (managed['rid'],))
    assert (await client.post(path, json=body)).status_code == 409


def test_notifier_requires_positive_host_process_observation(monkeypatch):
    from orcha_cli import notifier_workflow
    calls = []
    monkeypatch.setattr(notifier_workflow, 'runner_post', lambda *a: calls.append(a) or {})
    process = SimpleNamespace(pid=12345, returncode=None, poll=lambda: None)
    worker = {'run_id': 'run', 'proc': process}
    assert not notifier_workflow.confirm_exit('http://test', 'agent', worker)
    assert calls == []
    process.poll = lambda: -15
    process.returncode = -15
    assert notifier_workflow.confirm_exit('http://test', 'agent', worker)
    assert calls[0][0].endswith('/managed-stop-observation')
    assert calls[0][1] == {'process_id': 12345, 'exit_code': -15}
    assert not notifier_workflow.confirm_exit('http://test', 'agent', {**worker, 'sandbox_container_id': 'sandbox'})


async def test_stop_observation_openapi_is_generated(client):
    schema = (await client.get('/openapi.json')).json()
    operation = schema['paths']['/api/runs/{rid}/managed-stop-observation']['post']
    assert operation['responses']['200']['content']['application/json']['schema']['$ref'].endswith('/WorkerStopObservationView')
    assert operation['requestBody']['content']['application/json']['schema']['$ref'].endswith('/HostWorkerStopObserved')
