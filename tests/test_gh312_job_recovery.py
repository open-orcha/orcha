"""A replacement imports the original saved result without executing again."""

import os
import signal
from uuid import uuid4

import pytest

from orcha_cli.cli_job import current_job, summary
from orcha_cli.job_api import JobAPI, JobAPIError
from orcha_cli.job_recovery import recover_result
from orcha_cli.job_store import JobStorageError, atomic_json, read_json
from test_gh312_job_supervisor import service, jobs, running, result, eventually
from test_gh312_managed_jobs import publish, reserve, url, checkpoint_body
from test_gh312_managed_messages import managed


async def successor(client, managed):
    finished = await client.post(f"/api/runs/{managed['rid']}/finish",
                                  json={'status': 'exited', 'exit_code': 0})
    assert finished.status_code == 200, finished.text
    token = (await client.post(f"/api/agents/{managed['aid']}/embodiment-tokens",
                              json={'lane': 'work', 'kind': 'headless'})).json()['run_token']
    new = await client.post(f"/api/agents/{managed['aid']}/runs",
                            json={'task_id': managed['tid'], 'token_id': token})
    assert new.status_code == 201, new.text
    next_run = {**managed, 'rid': new.json()['run_id'], 'token': token,
                'headers': {'X-Orcha-Run-Token': token}}
    await publish(client, next_run)
    return next_run


def body_for(job, **extra):
    return checkpoint_body(source_owner_run_id=job['owner_run_id'], launch_nonce=job['launch_nonce'],
                           state='completed', termination_verified=True, result_digest='b'*64, **extra)


async def test_saved_result_requires_ended_source_and_current_successor(client, managed, db):
    await publish(client, managed)
    job = await reserve(client, managed)
    body = body_for(job)
    path = url(managed, job, 'reconcile')
    assert (await client.post(path, headers=managed['headers'], json=body)).status_code == 409
    new = await successor(client, managed)
    for invalid in [None, managed['token'], 'unbound-fixture']:
        headers = {'X-Orcha-Run-Token': invalid} if invalid else {}
        assert (await client.post(path, headers=headers, json=body)).status_code in {403, 409}
    for changes in [{'source_owner_run_id': str(uuid4())}, {'launch_nonce': str(uuid4())},
                    {'expected_version': 1}, {'checkpoint_version': 0}]:
        assert (await client.post(path, headers=new['headers'], json={**body, **changes})).status_code in {409, 422}
    first = await client.post(path, headers=new['headers'], json=body)
    assert first.status_code == 200, first.text
    saved = first.json()
    assert saved['owner_run_id'] == managed['rid'] and saved['transfers_used'] == 0
    assert saved['budget_until'] == job['budget_until'] and saved['launch_nonce'] == job['launch_nonce']
    assert (await client.post(path, headers=new['headers'], json=body)).json() == saved
    assert len(db.execute('SELECT * FROM managed_job_operations')) == 1
    assert (await client.post(path, headers=new['headers'], json={**body, 'result_digest': 'c'*64})).status_code == 409
    altered = {**body, 'operation_id': str(uuid4()), 'expected_version': 1,
               'checkpoint_version': 2, 'result_digest': 'c'*64}
    assert (await client.post(path, headers=new['headers'], json=altered)).status_code == 409
    assert (await client.post(url(managed, job, 'heartbeat'), headers=new['headers'])).status_code == 409


@pytest.mark.parametrize('cause', ['hold', 'cancel', 'lease', 'runtime', 'unknown'])
async def test_recovery_cannot_bypass_gates_or_certify_unknown_result(client, managed, db, cause):
    await publish(client, managed)
    job = await reserve(client, managed)
    new = await successor(client, managed)
    body = body_for(job)
    if cause == 'hold':
        db.execute('UPDATE tasks SET start_hold=true WHERE id=%s', (managed['tid'],))
    elif cause == 'cancel':
        db.execute("UPDATE tasks SET status='cancelled' WHERE id=%s", (managed['tid'],))
    elif cause == 'lease':
        db.execute('UPDATE agent_wake_state SET wake_lease_until=%s', (db.ago(1),))
    elif cause == 'runtime':
        db.execute('UPDATE managed_run_limits SET run_until=%s', (db.ago(1),))
    else:
        body.update(state='unknown', termination_verified=False)
    response = await client.post(url(managed, job, 'reconcile'), headers=new['headers'], json=body)
    assert response.status_code in {409, 422}, response.text
    assert db.execute('SELECT version FROM managed_jobs')[0]['version'] == 0


async def test_real_guard_result_survives_crash_lost_reply_and_successor_restart(jobs, client, managed, service, tmp_path, db):
    api, store, launch = jobs
    jid = launch("import time;open('starts','a').write('once');time.sleep(60)")
    eventually(lambda: running(store, jid))
    eventually(lambda: (tmp_path/'starts').exists() and (tmp_path/'starts').read_text() == 'once')
    os.kill(store.read(jid)['supervisor']['pid'], signal.SIGKILL)
    saved = eventually(lambda: result(store, jid))
    assert saved['termination_verified']
    new = await successor(client, managed)
    replacement = JobAPI(service[0], new['token'], new['tid'])
    job = current_job(replacement, jid)
    before = (store.job_directory(jid)/'result.json').read_bytes()
    real = replacement.request
    def lost_reply(suffix, *args, **kwargs):
        response = real(suffix, *args, **kwargs)
        if suffix.endswith('/reconcile'):
            raise JobAPIError()
        return response
    replacement.request = lost_reply
    with pytest.raises(JobAPIError):
        recover_result(replacement, store, job)
    assert (store.job_directory(jid)/'recovery-publication.json').exists()
    # Retry from another embodiment, including an already-committed server reply.
    newer = await successor(client, new)
    retry = JobAPI(service[0], newer['token'], newer['tid'])
    response = recover_result(retry, store, current_job(retry, jid))
    assert response['state'] == 'interrupted' and response['termination_verified']
    assert response['owner_run_id'] == managed['rid'] and response['transfers_used'] == 0
    assert (store.job_directory(jid)/'result.json').read_bytes() == before
    assert summary(store, response)['exit_code'] == saved['exit_code']
    assert (tmp_path/'starts').read_text() == 'once'
    assert len(db.execute('SELECT * FROM managed_job_operations WHERE operation_id=%s',
                          (read_json(store.job_directory(jid)/'recovery-publication.json')['operation_id'],))) == 1


async def test_recovery_refuses_active_controller_wrong_identity_and_unknown_evidence(jobs, managed, client, service):
    api, store, launch = jobs
    jid = launch('import time;time.sleep(60)')
    eventually(lambda: running(store, jid))
    job = current_job(api, jid)
    with pytest.raises(JobStorageError, match='supervisor is still active'):
        recover_result(api, store, job)
    os.kill(store.read(jid)['supervisor']['pid'], signal.SIGKILL)
    original = eventually(lambda: result(store, jid))
    new = await successor(client, managed)
    replacement = JobAPI(service[0], new['token'], new['tid'])
    job = current_job(replacement, jid)
    path = store.job_directory(jid)/'result.json'
    for changes in [{'owner_run_id': new['rid']}, {'launch_nonce': str(uuid4())},
                    {'job_id': str(uuid4())}, {'termination_verified': False},
                    {'exit_code': None}, {'status': 'unknown'}, {'signal': 999}]:
        atomic_json(path, {**original, **changes})
        with pytest.raises(JobStorageError):
            recover_result(replacement, store, job)
    atomic_json(path, original)
    assert recover_result(replacement, store, job)['termination_verified']


async def test_absolute_budget_exhaustion_survives_repeated_wakes_without_relaunch(client, managed, tmp_path, service):
    import sys
    from orcha_cli.cli_job import start_job
    from orcha_cli.job_store import JobStore
    await publish(client, managed, seconds=120)
    api = JobAPI(service[0], managed['token'], managed['tid'])
    store = JobStore(tmp_path)
    def start(current):
        return start_job(current, store, key='fixed-budget', purpose='Temporary bounded command',
                         argv=[sys.executable, '-c', "import time;open('launches','a').write('once');time.sleep(60)"],
                         cwd=tmp_path, max_seconds=3, max_transfers=0)
    initial = start(api)
    jid = initial['job_id']
    stopped = eventually(lambda: result(store, jid))
    assert stopped['status'] == 'exhausted' and stopped['reason'] == 'budget_exhausted'
    assert stopped['termination_verified']
    eventually(lambda: store.read(jid).get('result_saved'))
    for _ in range(3):
        managed = await successor(client, managed)
        api = JobAPI(service[0], managed['token'], managed['tid'])
        repeated = start(api)
        assert repeated['job_id'] == jid and repeated['status'] == 'exhausted'
        assert repeated['budget_until'] == initial['budget_until'] and repeated['transfers_used'] == 0
        recover_result(api, store, current_job(api, jid))
    assert (tmp_path/'launches').read_text() == 'once'
