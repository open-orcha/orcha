"""Planned transfer gates plus the retained real isolated command/guard seam."""

import hashlib
import secrets
import sys
from uuid import uuid4

import pytest

from orcha_cli.cli_job import start_job, request_control
from orcha_cli.job_api import JobAPI, JobAPIError
from orcha_cli.job_store import JobStore, JobStorageError
from orcha_cli.job_transfer import transfer_command
from test_gh312_job_supervisor import service, eventually, result, running
from test_gh312_job_recovery import successor
from test_gh312_managed_messages import managed
from test_gh312_managed_jobs import publish, reserve, url, checkpoint_body


async def prepared(client, managed, **options):
    await publish(client, managed)
    job = await reserve(client, managed, continuation_contract='readonly_single_process_v1', **options)
    job = (await client.post(url(managed, job, 'checkpoint'), headers=managed['headers'],
                              json=checkpoint_body())).json()
    secret = secrets.token_urlsafe(32)
    body = {'transfer_id': str(uuid4()), 'expected_version': job['version'],
            'launch_nonce': job['launch_nonce'], 'proof_digest': 'a'*64,
            'capability_digest': hashlib.sha256(secret.encode()).hexdigest()}
    response = await client.post(url(managed, job, 'transfer/prepare'), headers=managed['headers'], json=body)
    assert response.status_code == 200, response.text
    return job, secret, body, response.json()


async def observed(client, old, db):
    db.execute('UPDATE worker_runs SET pid=23456 WHERE run_id=%s', (old['rid'],))
    response = await client.post(f"/api/runs/{old['rid']}/managed-stop-observation",
                                 json={'process_id': 23456, 'exit_code': 0})
    assert response.status_code == 200, response.text


def adoption(job, secret, transfer):
    return {'transfer_id': transfer['transfer_id'], 'operation_id': str(uuid4()),
            'expected_version': job['version'], 'launch_nonce': job['launch_nonce'],
            'proof_digest': transfer['proof_digest'], 'capability': secret}


async def test_prepare_freezes_old_effects_but_retains_original_bound(client, managed, db):
    job, secret, body, transfer = await prepared(client, managed)
    for action, data in [('checkpoint', checkpoint_body(expected_version=1, checkpoint_version=2))]:
        response = await client.post(url(managed, job, action), headers=managed['headers'], json=data)
        assert response.status_code == 409 and response.json()['detail']['code'] == 'managed_worker_controls_frozen'
    assert (await client.post(managed['url']+'/poll', headers=managed['headers'], json={})).status_code == 409
    heartbeat = await client.post(url(managed, job, 'heartbeat'), headers=managed['headers'])
    assert heartbeat.status_code == 200 and not heartbeat.json()['mutations_allowed']
    assert (await client.post(f"/api/tasks/{managed['tid']}/managed-jobs", headers=managed['headers'],
                               json={'job_key': str(uuid4())})).status_code == 409
    assert (await client.post(url(managed, job, 'transfer/prepare'), headers=managed['headers'], json=body)).json() == transfer
    old_bound = transfer['authority_until']
    headers = {'X-Orcha-Run-Token': secret}
    assert (await client.post(url(managed, job, 'transfer/heartbeat'), headers=headers)).json()['authority_until'] == old_bound
    new = await successor(client, managed)
    assert (await client.post(url(managed, job, 'transfer/heartbeat'), headers=headers)).status_code == 200
    body = adoption(job, secret, transfer)
    response = await client.post(url(managed, job, 'transfer/adopt'), headers=new['headers'], json=body)
    assert response.status_code == 409 and response.json()['detail']['code'] == 'managed_positive_worker_exit_required'
    await observed(client, managed, db)
    first = await client.post(url(managed, job, 'transfer/adopt'), headers=new['headers'], json=body)
    assert first.status_code == 200, first.text
    adopted = first.json()
    assert adopted['owner_run_id'] == new['rid'] and adopted['transfers_used'] == 1
    assert adopted['budget_until'] == job['budget_until'] and adopted['launch_nonce'] == job['launch_nonce']
    assert (await client.post(url(managed, job, 'transfer/adopt'), headers=new['headers'], json=body)).json() == adopted
    assert (await client.post(url(managed, job, 'transfer/heartbeat'), headers=headers)).status_code == 409
    assert (await client.post(url(managed, job, 'heartbeat'), headers=managed['headers'])).status_code in {403, 409}


@pytest.mark.parametrize('cause', ['hold','cancel','stop','deadline','budget','count','proof','nonce','secret','version','live_source'])
async def test_adoption_refuses_changed_authority_and_identity(client, managed, db, cause):
    job, secret, _, transfer = await prepared(client, managed)
    new = await successor(client, managed)
    await observed(client, managed, db)
    body = adoption(job, secret, transfer)
    if cause == 'hold':
        db.execute('UPDATE tasks SET start_hold=true WHERE id=%s', (managed['tid'],))
    elif cause == 'cancel':
        db.execute("UPDATE tasks SET status='cancelled' WHERE id=%s", (managed['tid'],))
    elif cause == 'stop':
        db.execute('UPDATE worker_runs SET stop_requested_at=%s WHERE run_id=%s', (db.ago(0), managed['rid']))
    elif cause == 'deadline':
        db.execute('UPDATE managed_job_transfers SET authority_until=%s', (db.ago(1),))
    elif cause == 'budget':
        db.execute('UPDATE managed_jobs SET budget_until=%s', (db.ago(1),))
    elif cause == 'count':
        db.execute('UPDATE managed_jobs SET transfers_used=max_transfers')
    elif cause == 'live_source':
        db.execute("UPDATE worker_runs SET status='running',ended_at=NULL WHERE run_id=%s", (managed['rid'],))
    else:
        body.update({'proof': {'proof_digest':'b'*64}, 'nonce': {'launch_nonce':str(uuid4())},
                     'secret':{'capability':'x'*43}, 'version':{'expected_version':99}}[cause])
    response = await client.post(url(managed, job, 'transfer/adopt'), headers=new['headers'], json=body)
    assert response.status_code == 409, response.text
    assert str(db.execute('SELECT owner_run_id FROM managed_jobs')[0]['owner_run_id']) == managed['rid']


@pytest.mark.skipif(sys.platform != 'darwin', reason='Enforced host continuation is macOS only')
@pytest.mark.parametrize('lost_reply', [False, True])
async def test_real_retained_command_survives_worker_exit_and_atomic_adoption(client, managed, service, tmp_path, db, monkeypatch, lost_reply):
    await publish(client, managed, seconds=120)
    store = JobStore(tmp_path)
    api = JobAPI(service[0], managed['token'], managed['tid'])
    job = start_job(api, store, key='transfer', purpose='Isolated transfer check', cwd=tmp_path,
                    argv=[sys.executable, '-c', "import os,time;from pathlib import Path;p=Path(os.environ['ORCHA_JOB_SCRATCH']);(p/'launches').write_text('once');time.sleep(30)"],
                    max_seconds=90, isolate=True)
    jid = job['job_id']
    try:
        process = eventually(lambda: running(store, jid))
        eventually(lambda: store.read(jid).get('transfer_socket'))
        transfer = transfer_command(store, jid, 'prepare', api.token)
        assert transfer['status'] == 'prepared'
        with pytest.raises(JobAPIError):
            request_control(api, store, jid, 'stop')
        new = await successor(client, managed)
        await observed(client, managed, db)
        replacement = JobAPI(service[0], new['token'], new['tid'])
        if lost_reply:
            from fastapi import HTTPException
            from portal_backend.application import app
            route = next(r for r in app.routes if getattr(r, 'path', '').endswith('/transfer/adopt'))
            original = route.dependant.call
            lost = [False]
            def lose_first_reply(*args, **kwargs):
                value = original(*args, **kwargs)
                if not lost[0]:
                    lost[0] = True
                    raise HTTPException(503, 'Temporary test response loss')
                return value
            monkeypatch.setattr(route.dependant, 'call', lose_first_reply)
            with pytest.raises(JobStorageError):
                transfer_command(store, jid, 'adopt', new['token'])
            eventually(lambda: store.read(jid)['owner_run_id'] == new['rid'])
        transferred = transfer_command(store, jid, 'adopt', new['token'])
        assert transferred['status'] == 'adopted' and transferred['transfers_used'] == 1
        assert transfer_command(store, jid, 'adopt', new['token']) == transferred
        assert running(store, jid) == process
        assert (store.job_directory(jid)/'scratch'/'launches').read_text() == 'once'
        assert store.read(jid)['owner_run_id'] == new['rid']
        for evidence in store.job_directory(jid).glob('*.json'):
            assert api.token not in evidence.read_text() and new['token'] not in evidence.read_text()
        request_control(replacement, store, jid, 'stop')
        saved = eventually(lambda: result(store, jid))
        assert saved['termination_verified']
        eventually(lambda: store.read(jid).get('result_saved'))
    finally:
        for rid in [managed['rid'], store.read(jid)['owner_run_id']]:
            db.execute('UPDATE worker_runs SET stop_requested_at=%s WHERE run_id=%s', (db.ago(0), rid))
        eventually(lambda: result(store, jid), seconds=12)


@pytest.mark.skipif(sys.platform != 'darwin', reason='Enforced host continuation is macOS only')
@pytest.mark.parametrize('forced', [False, True])
async def test_notifier_pre_cap_handoff_stops_generic_job_and_observes_actual_worker_exit(client, managed, service, tmp_path, db, forced):
    import subprocess
    import time
    import pathlib
    from types import SimpleNamespace
    import httpx
    from orcha_cli.notifier_checkpoint import checkpoint_and_respawn
    from orcha_cli.notifier_managed_jobs import transfer_due, prepare, settled
    from test_gh312_notifier_jobs import worker_record
    await publish(client, managed, seconds=120)
    store = JobStore(tmp_path)
    api = JobAPI(service[0], managed['token'], managed['tid'])
    code = "import os,time;from pathlib import Path;(Path(os.environ['ORCHA_JOB_SCRATCH'])/'launches').write_text('once');time.sleep(60)"
    jid = start_job(api, store, key='retained', purpose='Retained test', cwd=tmp_path,
                    argv=[sys.executable,'-c',code], isolate=True, max_transfers=1)['job_id']
    generic = start_job(api, store, key='generic', purpose='Generic test', cwd=tmp_path,
                        argv=[sys.executable,'-c','import time;time.sleep(60)'])['job_id']
    old = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(60)'])
    children = [old]
    db.execute('UPDATE worker_runs SET pid=%s WHERE run_id=%s', (old.pid, managed['rid']))
    worker = worker_record(managed, store, proc=old, hard_deadline=time.time()+60, cap=120,
                           agent_id=managed['aid'], respawns=0)
    live = {managed['aid']:worker}
    with httpx.Client(timeout=3) as http:
        def post(url, body):
            response = http.post(url, json=body)
            assert response.status_code < 300, response.text
            return response.json()
        def spawn(*args, **kwargs):
            proc = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(60)'])
            children.append(proc)
            return True, 'temporary worker', proc
        def kill(proc, **kwargs):
            assert (store.job_directory(jid)/'handoff.json').exists()
            assert result(store, generic)['termination_verified']
            assert not result(store, jid)
            (proc.kill if forced else proc.terminate)()
            proc.wait(timeout=3)
        services = SimpleNamespace(
            _post_json=post, _get_json=lambda url:http.get(url).json(),
            _kill_worker=kill, _capture_diff=lambda cwd:'', _reap_sandbox_artifacts=lambda worker:None,
            _finish_run=lambda base,rid,status,code,*a:post(base+f'/api/runs/{rid}/finish', {'status':status,'exit_code':code}),
            _revoke_or_defer=lambda base,token:post(base+f'/api/embodiment-tokens/{token}/revoke', {}),
            _mint_embodiment_token=lambda base,aid,*a:post(base+f'/api/agents/{aid}/embodiment-tokens', {'lane':'work','kind':'headless'})['run_token'],
            _build_persona=lambda *a,**kw:'', spawn_headless=spawn, time=time, pathlib=pathlib,
            HARD_CAP_MIN_SECS=120, HARD_CAP_RESPAWN_MAX=3, WAKE_LEASE_TTL_SECS=180,
            _pump_one=lambda *a:None)
        services._checkpoint_and_respawn = lambda base,aid,w,live,quiet: checkpoint_and_respawn(base,aid,w,live,quiet,services)
        try:
            process = eventually(lambda: running(store, jid))
            eventually(lambda: running(store, generic))
            eventually(lambda: store.read(jid).get('transfer_socket'))
            assert transfer_due(worker, time.time())
            from orcha_cli.notifier_reaper import reap_workers
            reap_workers(service[0], live, True, 300, {}, {}, services)
            new = live[managed['aid']]
            assert new['run_id'] != managed['rid']
            assert store.read(jid)['owner_run_id'] == new['run_id']
            assert store.read(jid)['transfers_used'] == 1
            assert running(store, jid) == process and not result(store, jid)
            assert db.execute('SELECT process_id FROM worker_stop_observations')[0]['process_id'] == old.pid
            assert result(store, generic)['status'] == 'interrupted'
            # A fresh daemon record cannot reset the durable count. Its next
            # planned handoff stops this job as exhausted, without a second adopt.
            assert prepare(service[0], dict(new), services, reason='checkpoint_transfer', stop=True)
            assert result(store, jid)['status'] == 'exhausted'
            assert settled(store.read(jid))
        finally:
            for proc in children:
                if proc.poll() is None:
                    proc.terminate(); proc.wait(timeout=3)
            for item in [worker, live[managed['aid']]]:
                prepare(service[0], item, services, reason='test_cleanup', stop=True)


@pytest.mark.skipif(sys.platform != 'darwin', reason='Enforced host continuation is macOS only')
async def test_completion_during_transfer_reuses_original_result_without_adoption(client, managed, service, tmp_path, db):
    from orcha_cli.cli_job import current_job, summary
    from orcha_cli.job_recovery import recover_result
    await publish(client, managed, seconds=120)
    api = JobAPI(service[0], managed['token'], managed['tid'])
    store = JobStore(tmp_path)
    finish = tmp_path/'finish'
    code = f"from pathlib import Path;import time\nwhile not Path({str(finish)!r}).exists():time.sleep(.05)\nprint('done')"
    jid = start_job(api, store, key='completes', purpose='Complete in transfer', cwd=tmp_path,
                    argv=[sys.executable,'-c',code], isolate=True)['job_id']
    try:
        eventually(lambda: store.read(jid).get('transfer_socket'))
        transfer_command(store, jid, 'prepare', api.token)
        finish.write_text('finish')
        saved = eventually(lambda: result(store, jid))
        assert saved['status'] == 'completed' and saved['exit_code'] == 0
        eventually(lambda: store.read(jid).get('result_saved'))
        new = await successor(client, managed)
        replacement = JobAPI(service[0], new['token'], new['tid'])
        job = current_job(replacement, jid)
        # Wait until the original supervisor releases its publication lock.
        import time
        for _ in range(50):
            try:
                recovered = recover_result(replacement, store, job)
                break
            except JobStorageError:
                time.sleep(.02)
        else:
            pytest.fail('Original supervisor did not release saved result')
        assert recovered['transfers_used'] == 0 and recovered['state'] == 'completed'
        assert summary(store, recovered)['exit_code'] == 0
        assert len(db.execute('SELECT * FROM managed_jobs')) == 1
    finally:
        finish.write_text('finish')
        eventually(lambda: result(store, jid))


async def test_workflow_transfer_consumes_immutable_exact_old_generation_exit(client, db, monkeypatch):
    from test_workflow_local_launch import Project
    from portal_backend import workflow_service as ws
    monkeypatch.setattr(ws, 'WORKFLOWS_INTEGRATED', True)
    project = Project(client)
    await project.start('serial', [('build', project.ann, [])])
    launch = await project.reserve(project.ann, 'build')
    activation = await project.activate(project.ann, launch)
    old = {'aid': project.ann, 'tid': project.tasks['build'], 'rid':launch['run_id'],
           'token':activation['run_token'], 'headers': {'X-Orcha-Run-Token':activation['run_token']}}
    job, secret, _, transfer = await prepared(client, old)
    finished = await client.post(f"/api/runs/{old['rid']}/finish", json={'status':'exited','exit_code':0})
    assert finished.status_code == 200, finished.text
    stopped = await client.post(f"/api/agents/{old['aid']}/runs/{old['rid']}/confirm-stopped",
                                json={'generation':launch['generation']})
    assert stopped.status_code == 200, stopped.text
    continued = await client.post(f"/api/agents/{old['aid']}/runs/{old['rid']}/continue-reserve",
                                  json={'operation_key':'transfer-successor'})
    assert continued.status_code == 201, continued.text
    next_launch = continued.json()
    activated = await project.activate(project.ann, next_launch)
    new = {**old, 'rid':next_launch['run_id'], 'headers':{'X-Orcha-Run-Token':activated['run_token']}}
    await publish(client, new)
    assert db.execute('SELECT worker_stopped_at FROM workflow_executions')[0]['worker_stopped_at'] is None
    body = adoption(job, secret, transfer)
    original = db.execute('SELECT generation FROM worker_stop_observations')[0]['generation']
    db.execute('UPDATE worker_stop_observations SET generation=generation+1')
    response = await client.post(url(old, job, 'transfer/adopt'), headers=new['headers'], json=body)
    assert response.status_code == 409 and response.json()['detail']['code'] == 'managed_positive_worker_exit_required'
    db.execute('UPDATE worker_stop_observations SET generation=%s', (original,))
    response = await client.post(url(old, job, 'transfer/adopt'), headers=new['headers'], json=body)
    assert response.status_code == 200, response.text
    assert response.json()['workflow_generation'] == next_launch['generation']
    assert response.json()['transfers_used'] == 1


async def test_transfer_generated_contract_never_returns_capability(client):
    spec = (await client.get('/openapi.json')).json()
    for suffix, schema in [('prepare','ManagedTransferView'),('heartbeat','ManagedTransferAuthority'),('adopt','ManagedJobView')]:
        endpoint = spec['paths']['/api/tasks/{tid}/managed-jobs/{jid}/transfer/'+suffix]['post']
        assert endpoint['responses']['200']['content']['application/json']['schema']['$ref'].endswith('/'+schema)
        assert 'capability' not in spec['components']['schemas'][schema]['properties']


@pytest.mark.skipif(sys.platform != 'darwin', reason='Enforced host continuation is macOS only')
async def test_changed_guard_evidence_cannot_substitute_for_retained_pipe_proof(client, managed, service, tmp_path):
    from orcha_cli.job_store import read_json, atomic_json
    from orcha_cli.notifier_managed_jobs import prepare
    from test_gh312_notifier_jobs import worker_record
    from types import SimpleNamespace
    await publish(client, managed, seconds=120)
    api = JobAPI(service[0], managed['token'], managed['tid'])
    store = JobStore(tmp_path)
    jid = start_job(api, store, key='proof', purpose='Guard identity check', cwd=tmp_path,
                    argv=[sys.executable,'-c','import time;time.sleep(60)'], isolate=True)['job_id']
    try:
        eventually(lambda: store.read(jid).get('transfer_socket'))
        path = store.job_directory(jid)/'process.json'
        evidence = read_json(path)
        changed = {**evidence, 'process': {**evidence['process'], 'start':'unrelated process'}}
        atomic_json(path, changed)
        with pytest.raises(JobStorageError):
            transfer_command(store, jid, 'prepare', api.token)
        atomic_json(path, evidence)
        assert transfer_command(store, jid, 'prepare', api.token)['status'] == 'prepared'
    finally:
        services = SimpleNamespace(_post_json=lambda *a:{'message_id':str(uuid4())})
        assert prepare(service[0], worker_record(managed, store), services, reason='test_cleanup', stop=True)


@pytest.mark.skipif(sys.platform != 'darwin', reason='Enforced host continuation is macOS only')
async def test_committed_adoption_controller_crash_and_lost_reply_recover_saved_result(client, managed, service, tmp_path, db, monkeypatch):
    import os
    import signal
    from fastapi import HTTPException
    from portal_backend.application import app
    from orcha_cli.cli_job import current_job
    from orcha_cli.job_identity import same_process
    from orcha_cli.job_recovery import recover_result
    await publish(client, managed, seconds=120)
    api = JobAPI(service[0], managed['token'], managed['tid'])
    store = JobStore(tmp_path)
    jid = start_job(api, store, key='lost-controller', purpose='Adoption crash recovery', cwd=tmp_path,
                    argv=[sys.executable,'-c','import time;time.sleep(60)'], isolate=True)['job_id']
    try:
        eventually(lambda: store.read(jid).get('transfer_socket'))
        transfer_command(store, jid, 'prepare', api.token)
        new = await successor(client, managed)
        await observed(client, managed, db)
        route = next(r for r in app.routes if getattr(r, 'path', '').endswith('/transfer/adopt'))
        original = route.dependant.call
        def crash_after_commit(*args, **kwargs):
            original(*args, **kwargs)
            identity = store.read(jid)['supervisor']
            assert same_process(identity)
            os.kill(identity['pid'], signal.SIGKILL)
            raise HTTPException(503, 'Temporary test response loss')
        monkeypatch.setattr(route.dependant, 'call', crash_after_commit)
        with pytest.raises((JobStorageError, OSError)):
            transfer_command(store, jid, 'adopt', new['token'])
        saved = eventually(lambda: result(store, jid))
        assert saved['termination_verified'] and saved['owner_run_id'] == managed['rid']
        assert store.read(jid)['owner_run_id'] == managed['rid']
        third = await successor(client, new)
        replacement = JobAPI(service[0], third['token'], third['tid'])
        job = current_job(replacement, jid)
        assert job['owner_run_id'] == new['rid'] and job['transfers_used'] == 1
        recovered = recover_result(replacement, store, job)
        assert recovered['state'] == 'interrupted' and recovered['transfers_used'] == 1
        assert store.read(jid)['owner_run_id'] == new['rid']
    finally:
        db.execute('UPDATE worker_runs SET stop_requested_at=%s', (db.ago(0),))
        eventually(lambda: result(store, jid), seconds=12)


async def test_concurrent_adoption_retries_consume_one_durable_transfer(client, managed, db):
    import asyncio
    job, secret, _, transfer = await prepared(client, managed)
    new = await successor(client, managed)
    await observed(client, managed, db)
    body = adoption(job, secret, transfer)
    results = await asyncio.gather(*(client.post(url(managed, job, 'transfer/adopt'),
                                                 headers=new['headers'], json=body) for _ in range(4)))
    assert all(r.status_code == 200 for r in results)
    assert {r.json()['version'] for r in results} == {job['version']+1}
    assert db.execute('SELECT transfers_used FROM managed_jobs')[0]['transfers_used'] == 1


@pytest.mark.skipif(sys.platform != 'darwin', reason='Enforced host continuation is macOS only')
async def test_multiple_retained_commands_prepare_and_adopt_without_stopping_each_other(client, managed, service, tmp_path, db):
    import time
    await publish(client, managed, seconds=120)
    store = JobStore(tmp_path)
    api = JobAPI(service[0], managed['token'], managed['tid'])
    jobs = []
    try:
        for key in ['first', 'second']:
            jid = start_job(api, store, key=key, purpose='Multiple command transfer', cwd=tmp_path,
                            argv=[sys.executable, '-c', 'import time;time.sleep(60)'], isolate=True)['job_id']
            jobs.append(jid)
            eventually(lambda: store.read(jid).get('transfer_socket'))
        identities = [running(store, jid) for jid in jobs]
        transfer_command(store, jobs[0], 'prepare', api.token)
        # Give the second independent supervisor time to observe the run-wide
        # freeze before it receives its own prepare request.
        time.sleep(2.3)
        assert all(result(store, jid) is None for jid in jobs)
        transfer_command(store, jobs[1], 'prepare', api.token)
        new = await successor(client, managed)
        await observed(client, managed, db)
        for jid in jobs:
            assert transfer_command(store, jid, 'adopt', new['token'])['transfers_used'] == 1
        assert [running(store, jid) for jid in jobs] == identities
        assert {str(row['owner_run_id']) for row in db.execute('SELECT owner_run_id FROM managed_jobs')} == {new['rid']}
    finally:
        db.execute('UPDATE worker_runs SET stop_requested_at=%s', (db.ago(0),))
        for jid in jobs:
            eventually(lambda: result(store, jid), seconds=12)


@pytest.mark.skipif(sys.platform != 'darwin', reason='Enforced host continuation is macOS only')
async def test_stale_daemon_stop_snapshot_cannot_stop_adopted_command(client, managed, service, tmp_path, db, monkeypatch):
    from types import SimpleNamespace
    from orcha_cli import notifier_managed_jobs as daemon
    from test_gh312_notifier_jobs import worker_record
    await publish(client, managed, seconds=120)
    store = JobStore(tmp_path)
    api = JobAPI(service[0], managed['token'], managed['tid'])
    jid = start_job(api, store, key='stale-daemon', purpose='Stale daemon check', cwd=tmp_path,
                    argv=[sys.executable, '-c', 'import time;time.sleep(60)'], isolate=True)['job_id']
    try:
        eventually(lambda: store.read(jid).get('transfer_socket'))
        transfer_command(store, jid, 'prepare', api.token)
        previous = worker_record(managed, store)
        store_before, records_before = daemon.run_jobs(previous)
        new = await successor(client, managed)
        await observed(client, managed, db)
        transfer_command(store, jid, 'adopt', new['token'])
        # Only delay the already-obtained daemon snapshot across adoption. All
        # subsequent ownership reads and the real guard use production code.
        monkeypatch.setattr(daemon, 'run_jobs', lambda worker:(store_before, records_before))
        services = SimpleNamespace(_post_json=lambda *args:{'message_id':str(uuid4())})
        assert daemon.prepare(service[0], previous, services, reason='stale_exit', stop=True)
        assert not (store.job_directory(jid)/'daemon-stop.json').exists()
        assert result(store, jid) is None
    finally:
        db.execute('UPDATE worker_runs SET stop_requested_at=%s', (db.ago(0),))
        eventually(lambda: result(store, jid), seconds=12)
