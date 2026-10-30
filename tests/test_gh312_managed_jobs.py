"""Real API/DB regressions for managed command ownership and finite authority."""

from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from test_gh312_managed_messages import managed  # shared real worker fixture


async def publish(client, managed, seconds=1200, sandbox=None):
    now = datetime.now(timezone.utc)
    data = {'run_until': (now + timedelta(seconds=seconds)).isoformat()}
    if sandbox is not None:
        data['sandbox_until'] = (now + timedelta(seconds=sandbox)).isoformat()
    response = await client.post(f"/api/runs/{managed['rid']}/managed-limits", json=data)
    assert response.status_code == 200, response.text
    return response.json()


async def reserve(client, managed, **kwargs):
    response = await client.post(f"/api/tasks/{managed['tid']}/managed-jobs",
                                 headers=managed['headers'], json={'job_key': str(uuid4()), **kwargs})
    assert response.status_code == 200, response.text
    return response.json()


def url(managed, job, action):
    return f"/api/tasks/{managed['tid']}/managed-jobs/{job['job_id']}/{action}"


async def heartbeat(client, managed, job):
    return await client.post(url(managed, job, 'heartbeat'), headers=managed['headers'])


def checkpoint_body(**kwargs):
    return {'operation_id': str(uuid4()), 'expected_version': 0, 'state': 'running',
            'checkpoint_version': 1, 'checkpoint_digest': 'a'*64, **kwargs}


async def test_reservation_retry_and_crash_fence(client, managed, db):
    path = f"/api/tasks/{managed['tid']}/managed-jobs"
    body = {'job_key': str(uuid4())}
    assert (await client.post(path, headers=managed['headers'], json=body)).status_code == 409
    await publish(client, managed)
    first = await reserve(client, managed, **body)
    assert first['state'] == 'reserved' and first['max_transfers'] == 3
    assert first == await reserve(client, managed, **body)
    assert len(db.execute('SELECT * FROM managed_jobs')) == 1
    assert (await client.post(path, headers=managed['headers'], json={**body, 'max_transfers': 4})).status_code == 409
    # A replacement can discover the reservation but cannot rewrite or launch it.
    token = (await client.post(f"/api/agents/{managed['aid']}/embodiment-tokens",
                              json={'lane': 'work', 'kind': 'headless'})).json()['run_token']
    new = await client.post(f"/api/agents/{managed['aid']}/runs",
                            json={'task_id': managed['tid'], 'token_id': token})
    assert new.status_code == 201
    old_headers = managed['headers']
    managed = {**managed, 'rid': new.json()['run_id'], 'headers': {'X-Orcha-Run-Token': token}}
    await publish(client, managed)
    assert first == await reserve(client, managed, **body)
    listing = await client.get(path, headers=managed['headers'])
    assert listing.json()['jobs'] == [first]
    assert (await heartbeat(client, managed, first)).status_code == 409
    assert (await client.post(url(managed, first, 'checkpoint'), headers=old_headers,
                               json=checkpoint_body())).status_code == 409


async def test_checkpoint_cas_retry_and_saved_result_immutable(client, managed, db):
    await publish(client, managed)
    job = await reserve(client, managed)
    path = url(managed, job, 'checkpoint')
    body = checkpoint_body()
    response = await client.post(path, headers=managed['headers'], json=body)
    assert response.status_code == 200, response.text
    assert response.json()['version'] == 1
    assert (await client.post(path, headers=managed['headers'], json=body)).json() == response.json()
    for changes in [{'checkpoint_digest': 'b'*64}, {'operation_id': str(uuid4())}]:
        assert (await client.post(path, headers=managed['headers'], json={**body, **changes})).status_code == 409
    done = checkpoint_body(expected_version=1, checkpoint_version=2, state='completed',
                           termination_verified=True, result_digest='c'*64)
    result = await client.post(path, headers=managed['headers'], json=done)
    assert result.status_code == 200, result.text
    assert result.json()['termination_verified']
    assert (await client.post(path, headers=managed['headers'], json=checkpoint_body(
        expected_version=2, checkpoint_version=3))).status_code == 409
    assert (await client.post(path, headers=managed['headers'], json=checkpoint_body(
        expected_version=2, checkpoint_version=3, state='completed', termination_verified=True,
        result_digest='d'*64))).status_code == 409
    assert len(db.execute('SELECT * FROM managed_job_operations')) == 2


async def test_heartbeat_read_only_and_same_run_lapse_recovery(client, managed, db):
    await publish(client, managed)
    job = await reserve(client, managed)
    db.execute('UPDATE agent_wake_state SET wake_lease_until=%s WHERE agent_id=%s',
               (db.ago(5), managed['aid']))
    def snapshot():
        return [db.execute(q) for q in ['SELECT * FROM agents', 'SELECT * FROM agent_wake_state',
                                       'SELECT * FROM worker_run_lines', 'SELECT * FROM managed_jobs']]
    before = snapshot()
    response = await heartbeat(client, managed, job)
    assert response.status_code == 200, response.text
    body = response.json()
    assert not body['mutations_allowed'] and not body['lease_active']
    assert datetime.fromisoformat(body['authority_until']) > datetime.fromisoformat(body['server_time'])
    assert snapshot() == before
    assert (await client.post(managed['url']+'/poll', headers=managed['headers'], json={})).status_code == 409
    assert (await client.post(url(managed, job, 'checkpoint'), headers=managed['headers'],
                               json=checkpoint_body())).status_code == 409
    assert not (await client.post(f"/api/agents/{managed['aid']}/wake-claim", json={})).json()['claimed']
    for bad in [{}, {'run_id': str(uuid4())}]:
        assert not (await client.post(f"/api/agents/{managed['aid']}/wake-renew", json=bad)).json()['renewed']
    renewed = await client.post(f"/api/agents/{managed['aid']}/wake-renew", json={'run_id': managed['rid']})
    assert renewed.json()['renewed'], renewed.text
    assert (await heartbeat(client, managed, job)).json()['mutations_allowed']
    # A clean release is never revived.
    db.execute('UPDATE agent_wake_state SET wake_lease_until=NULL WHERE agent_id=%s', (managed['aid'],))
    assert not (await client.post(f"/api/agents/{managed['aid']}/wake-renew", json={'run_id': managed['rid']})).json()['renewed']
    assert (await heartbeat(client, managed, job)).status_code == 409


@pytest.mark.parametrize('cause', ['stop', 'hold', 'cancel', 'revoke', 'run_cap', 'job_cap', 'activity'])
async def test_lapse_never_recovers_lost_authority(client, managed, db, cause):
    await publish(client, managed, seconds=7200)
    job = await reserve(client, managed)
    db.execute('UPDATE agent_wake_state SET wake_lease_until=%s WHERE agent_id=%s', (db.ago(5), managed['aid']))
    if cause == 'stop':
        db.execute('UPDATE worker_runs SET stop_requested_at=now() WHERE run_id=%s', (managed['rid'],))
    elif cause == 'hold':
        db.execute('UPDATE tasks SET start_hold=true WHERE id=%s', (managed['tid'],))
    elif cause == 'cancel':
        db.execute("UPDATE tasks SET status='cancelled' WHERE id=%s", (managed['tid'],))
    elif cause == 'revoke':
        db.execute('UPDATE embodiment_tokens SET revoked_at=now() WHERE run_token=%s', (managed['token'],))
    elif cause == 'run_cap':
        db.execute('UPDATE managed_run_limits SET run_until=%s', (db.ago(1),))
    elif cause == 'job_cap':
        db.execute('UPDATE managed_jobs SET budget_until=%s', (db.ago(1),))
    else:
        age_run(db, managed, 1300)
    assert (await heartbeat(client, managed, job)).status_code in {403, 409}
    if cause != 'job_cap':  # job budget stops the command, not the whole worker
        assert not (await client.post(f"/api/agents/{managed['aid']}/wake-renew",
                                       json={'run_id': managed['rid']})).json()['renewed']


def age_run(db, managed, seconds):
    old = db.ago(seconds)
    db.execute('UPDATE worker_runs SET started_at=%s WHERE run_id=%s', (old, managed['rid']))
    db.execute('UPDATE agents SET last_heartbeat_at=%s WHERE id=%s', (old, managed['aid']))
    db.execute('UPDATE agent_wake_state SET work_last_heartbeat_at=%s,last_woken_at=%s WHERE agent_id=%s',
               (old, old, managed['aid']))


@pytest.mark.parametrize('lapsed', [False, True])
@pytest.mark.parametrize('sandbox', [False, True])
async def test_both_reapers_honor_managed_floor_per_row(client, managed, make_agent, db, lapsed, sandbox):
    await publish(client, managed, seconds=20000, sandbox=20000 if sandbox else None)
    if sandbox:
        db.execute("UPDATE worker_runs SET sandbox_container_id='test-sandbox' WHERE run_id=%s", (managed['rid'],))
    await reserve(client, managed)
    aid = (await make_agent('Legacy worker'))['agent_id']
    assert (await client.post(f'/api/agents/{aid}/wake-claim', json={})).json()['claimed']
    legacy = (await client.post(f'/api/agents/{aid}/runs', json={})).json()['run_id']
    age_run(db, managed, 1300 if sandbox else 30)
    age_run(db, {'aid': aid, 'rid': legacy}, 30)
    if lapsed:
        db.execute('UPDATE agent_wake_state SET wake_lease_until=%s', (db.ago(1),))
    cid = str(db.execute('SELECT container_id FROM agents WHERE id=%s', (aid,))[0]['container_id'])
    response = await client.post(f'/api/containers/{cid}/reap-orphan-leases?orphan_secs=0')
    assert response.status_code == 200, response.text
    rows = {str(r['run_id']): r['status'] for r in db.execute('SELECT run_id,status FROM worker_runs')}
    assert rows[managed['rid']] == 'running'
    assert rows[legacy] == 'orphaned'
    age_run(db, managed, 8500 if sandbox else 1300)
    response = await client.post(f'/api/containers/{cid}/reap-orphan-leases?orphan_secs=0')
    assert db.execute('SELECT status FROM worker_runs WHERE run_id=%s', (managed['rid'],))[0]['status'] == 'orphaned'


async def test_fixed_caps_never_extend_and_legacy_wait_cannot_bypass(client, managed, db):
    caps = await publish(client, managed)
    job = await reserve(client, managed)
    more = await client.post(f"/api/runs/{managed['rid']}/managed-limits",
                             json={'run_until': (datetime.now(timezone.utc)+timedelta(hours=2)).isoformat()})
    assert more.status_code == 409
    same = await client.post(f"/api/runs/{managed['rid']}/managed-limits", json={'run_until': caps['run_until']})
    assert same.status_code == 200
    db.execute('UPDATE managed_run_limits SET run_until=%s', (db.ago(1),))
    # Compatibility activity may delay idle cleanup but does not extend a fixed cap.
    db.execute('UPDATE agent_wake_state SET work_last_heartbeat_at=%s', (db.ago(3000),))
    waited = await client.get(f"/api/agents/{managed['aid']}/wait?timeout=1")
    assert waited.status_code == 200, waited.text
    assert db.execute('SELECT work_last_heartbeat_at FROM agent_wake_state')[0]['work_last_heartbeat_at'] > db.ago(5)
    assert (await heartbeat(client, managed, job)).status_code == 409


async def test_managed_job_openapi(client):
    spec = (await client.get('/openapi.json')).json()
    paths = {p: methods for p, methods in spec['paths'].items() if 'managed-jobs' in p or 'managed-limits' in p}
    assert len(paths) == 8
    for p, methods in paths.items():
        for method in methods.values():
            assert method['responses']['200']['content']['application/json']['schema']['$ref']
            if 'managed-jobs' in p:
                assert any(x['name'].lower() == 'x-orcha-run-token' for x in method['parameters'])


async def test_workflow_authority_has_finite_cap_without_lane_and_fences_generation(client, db, monkeypatch):
    from test_workflow_local_launch import Project
    from portal_backend import workflow_service as ws
    monkeypatch.setattr(ws, 'WORKFLOWS_INTEGRATED', True)
    project = Project(client)
    await project.start('serial', [('build', project.ann, [])])
    launch = await project.reserve(project.ann, 'build')
    activation = await project.activate(project.ann, launch)
    ctx = {'aid': project.ann, 'tid': project.tasks['build'], 'rid': launch['run_id'],
           'headers': {'X-Orcha-Run-Token': activation['run_token']}}
    limits = await publish(client, ctx, seconds=40)
    job = await reserve(client, ctx)
    response = await heartbeat(client, ctx, job)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body['lease_until'] is None and body['mutations_allowed']
    assert body['workflow_generation'] == launch['generation']
    assert datetime.fromisoformat(body['authority_until']) == datetime.fromisoformat(limits['run_until'])
    assert datetime.fromisoformat(body['prepare_at']) < datetime.fromisoformat(body['server_time'])
    db.execute("UPDATE workflows SET status='paused' WHERE id=%s", (project.wid,))
    assert (await heartbeat(client, ctx, job)).status_code == 409
    db.execute("UPDATE workflows SET status='active' WHERE id=%s", (project.wid,))
    db.execute('UPDATE workflow_executions SET generation_revoked_at=now() WHERE run_id=%s', (ctx['rid'],))
    assert (await heartbeat(client, ctx, job)).status_code == 409


async def test_sandbox_cap_and_unknown_jobs_remain_fenced(client, managed, db):
    db.execute("UPDATE worker_runs SET sandbox_container_id='sandbox' WHERE run_id=%s", (managed['rid'],))
    path = f"/api/runs/{managed['rid']}/managed-limits"
    data = {'run_until': (datetime.now(timezone.utc)+timedelta(hours=1)).isoformat()}
    assert (await client.post(path, json=data)).status_code == 409
    limits = await publish(client, managed, seconds=3600, sandbox=120)
    job = await reserve(client, managed)
    assert datetime.fromisoformat((await heartbeat(client, managed, job)).json()['authority_until']) == datetime.fromisoformat(limits['sandbox_until'])
    unknown = await client.post(url(managed, job, 'checkpoint'), headers=managed['headers'],
                                json=checkpoint_body(state='unknown'))
    assert unknown.status_code == 200
    assert (await heartbeat(client, managed, job)).status_code == 409
    assert (await client.post(url(managed, job, 'checkpoint'), headers=managed['headers'],
                               json=checkpoint_body(expected_version=1, checkpoint_version=2))).status_code == 409
    # Unknown disposition retains its reservation and job budget across retries.
    original = await reserve(client, managed, job_key=job['job_key'])
    assert original['job_id'] == job['job_id'] and original['state'] == 'unknown'
    assert original['budget_until'] == job['budget_until']
    db.execute('UPDATE managed_run_limits SET sandbox_until=%s', (db.ago(1),))
    assert (await heartbeat(client, managed, job)).status_code == 409


async def test_fast_completion_requires_saved_evidence_even_before_running_update(client, managed):
    await publish(client, managed)
    job = await reserve(client, managed)
    path = url(managed, job, 'checkpoint')
    for state in ['completed', 'interrupted']:
        response = await client.post(path, headers=managed['headers'], json=checkpoint_body(state=state))
        assert response.status_code == 422
    response = await client.post(path, headers=managed['headers'], json=checkpoint_body(
        state='completed', termination_verified=True, result_digest='e'*64))
    assert response.status_code == 200, response.text
    assert response.json()['state'] == 'completed'
