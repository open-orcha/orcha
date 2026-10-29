"""Actual API/DB seams: guidance survives delivery, stale acks, and worker changes."""

from datetime import datetime, timezone
from uuid import UUID, uuid4

import pytest


@pytest.fixture
async def managed(client, make_agent, make_task, db):
    aid = (await make_agent('Managed worker'))['agent_id']
    tid = (await make_task('Long command', 'Read guidance exactly once',
                           assignee_alias='Managed worker'))['id']
    db.execute("UPDATE tasks SET status='in_progress' WHERE id=%s", (tid,))
    token = (await client.post(f'/api/agents/{aid}/embodiment-tokens',
                              json={'lane': 'work', 'kind': 'headless'})).json()['run_token']
    claim = await client.post(f'/api/agents/{aid}/wake-claim', json={})
    assert claim.json()['claimed'], claim.text
    run = await client.post(f'/api/agents/{aid}/runs',
                            json={'task_id': tid, 'token_id': token, 'runtime': 'codex'})
    assert run.status_code == 201, run.text
    return {'aid': aid, 'tid': tid, 'rid': run.json()['run_id'], 'token': token,
            'headers': {'X-Orcha-Run-Token': token},
            'url': f'/api/tasks/{tid}/managed-messages'}


def messages(db, managed, count=3):
    stamp = datetime(2026, 1, 1, tzinfo=timezone.utc)
    ids = [str(UUID(int=i)) for i in range(1, count + 1)]
    for mid in ids:
        db.execute('INSERT INTO task_messages(id,task_id,body,created_at) VALUES (%s,%s,%s,%s)',
                   (mid, managed['tid'], 'Guidance', stamp))
    return ids


async def poll(client, managed, **body):
    response = await client.post(managed['url'] + '/poll', headers=managed['headers'], json=body)
    assert response.status_code == 200, response.text
    return response.json()


async def handle(client, managed, mid):
    response = await client.post(managed['url'] + f'/{mid}/handled',
                                 headers=managed['headers'], json={'outcome': 'applied'})
    assert response.status_code == 200, response.text
    return response.json()


async def test_poll_replays_and_handled_cursor_never_crosses_gap(client, managed, db):
    ids = messages(db, managed)
    first = await poll(client, managed, limit=2)
    assert [m['message_id'] for m in first['messages']] == ids[:2]
    assert first['has_more'] and first['handled_position'] is None
    assert first == await poll(client, managed, limit=2)
    assert (await handle(client, managed, ids[1]))['handled_position'] is None
    page = await poll(client, managed, limit=2)
    assert [m['message_id'] for m in page['messages']] == [ids[0], ids[2]]
    assert page['received_position']['message_id'] == ids[-1]
    assert (await handle(client, managed, ids[0]))['handled_position']['message_id'] == ids[1]
    assert (await handle(client, managed, ids[2]))['handled_position']['message_id'] == ids[2]
    assert (await handle(client, managed, ids[2]))['already_handled']
    assert (await poll(client, managed))['messages'] == []


async def test_event_ack_and_receipt_are_atomic_and_mapping_is_scoped(client, managed, db, monkeypatch):
    from portal_backend import managed_message_routes as routes
    from portal_backend.database import db_cursor
    from portal_backend.events import publish_event
    ids = messages(db, managed, 1)
    with db_cursor() as (conn, cur):
        cur.execute('SELECT container_id FROM agents WHERE id=%s', (managed['aid'],))
        cid = str(cur.fetchone()['container_id'])
        for tid in [managed['tid'], str(uuid4())]:
            publish_event(cur, cid, managed['aid'], 'task_message', {'task_id': tid, 'message_id': ids[0]})
        conn.commit()
    page = await poll(client, managed)
    mapped = page['messages'][0]['event_ids']
    assert len(mapped) == 1
    assert not db.execute('SELECT * FROM agent_event_acks WHERE event_id=%s', (mapped[0],))
    real = routes.acknowledge_event_ids
    def fail_after_ack(*args):
        real(*args)
        raise RuntimeError('simulated crash before commit')
    with monkeypatch.context() as patch:
        patch.setattr(routes, 'acknowledge_event_ids', fail_after_ack)
        with pytest.raises(RuntimeError, match='simulated crash'):
            await handle(client, managed, ids[0])
    assert db.execute('SELECT handled_at FROM managed_message_receipts')[0]['handled_at'] is None
    assert not db.execute('SELECT * FROM agent_event_acks WHERE event_id=%s', (mapped[0],))
    await handle(client, managed, ids[0])
    assert db.execute('SELECT event_id FROM agent_event_acks') == [{'event_id': mapped[0]}]


async def test_legacy_ack_cannot_hide_guidance_from_replacement(client, managed, db):
    from portal_backend.database import db_cursor
    from portal_backend.events import publish_event
    mid = messages(db, managed, 1)[0]
    with db_cursor() as (conn, cur):
        cur.execute('SELECT container_id FROM agents WHERE id=%s', (managed['aid'],))
        publish_event(cur, str(cur.fetchone()['container_id']), managed['aid'], 'task_message',
                      {'task_id': managed['tid'], 'message_id': mid})
        conn.commit()
    event = db.execute("SELECT id FROM agent_events WHERE event_key=%s AND event_name='task_message'",
                       (managed['aid'],))[0]['id']
    ack = await client.post(f"/api/agents/{managed['aid']}/events/ack-handled", json={'event_ids': [event]})
    assert ack.status_code == 200
    assert not db.execute('SELECT * FROM managed_message_receipts')
    # The old worker never polled before delivery acknowledgement/crash.
    db.execute("UPDATE worker_runs SET status='exited',ended_at=now() WHERE run_id=%s", (managed['rid'],))
    db.execute('UPDATE embodiment_tokens SET revoked_at=now() WHERE run_token=%s', (managed['token'],))
    replacement = (await client.post(f"/api/agents/{managed['aid']}/embodiment-tokens",
                                    json={'lane': 'work', 'kind': 'headless'})).json()['run_token']
    new_run = await client.post(f"/api/agents/{managed['aid']}/runs",
                                json={'task_id': managed['tid'], 'token_id': replacement})
    assert new_run.status_code == 201, new_run.text
    stale = await client.post(managed['url'] + '/poll', headers=managed['headers'], json={})
    assert stale.status_code == 403
    managed['headers'] = {'X-Orcha-Run-Token': replacement}
    page = await poll(client, managed)
    assert [m['message_id'] for m in page['messages']] == [mid]
    assert page['messages'][0]['event_ids'] == [event]
    await handle(client, managed, mid)


@pytest.mark.parametrize('change,status', [
    ('unbound', 409), ('revoked', 403), ('wrong_run', 409), ('wrong_task', 409),
    ('conversation', 403), ('stopped', 409), ('terminal', 409), ('lease', 409),
    ('hold', 409), ('cancelled', 409), ('unassigned', 409), ('resident', 409),
    ('paused', 409), ('owner_decision', 409),
])
async def test_fenced_worker_cannot_receive_or_handle(client, managed, db, change, status):
    mid = messages(db, managed, 1)[0]
    await poll(client, managed)
    if change in {'unbound', 'revoked', 'conversation', 'wrong_run'}:
        fields = {'unbound': 'run_id=NULL', 'revoked': 'revoked_at=now()',
                  'conversation': "lane='conversation'", 'wrong_run': 'run_id=%s'}
        args = (managed['token'],)
        if change == 'wrong_run':
            rid = str(uuid4())
            db.execute("INSERT INTO worker_runs(run_id,agent_id,lane,wake_kind,status) "
                       "VALUES (%s,%s,'work','ephemeral','running')", (rid, managed['aid']))
            args = (rid, managed['token'])
        db.execute('UPDATE embodiment_tokens SET ' + fields[change] + ' WHERE run_token=%s', args)
    elif change in {'stopped', 'terminal', 'resident', 'wrong_task'}:
        fields = {'stopped': 'stop_requested_at=now()', 'terminal': "status='exited'",
                  'resident': "wake_kind='resident'", 'wrong_task': 'task_id=NULL'}
        db.execute('UPDATE worker_runs SET ' + fields[change] + ' WHERE run_id=%s', (managed['rid'],))
    elif change == 'lease':
        db.execute('UPDATE agent_wake_state SET wake_lease_until=NULL WHERE agent_id=%s', (managed['aid'],))
    elif change == 'unassigned':
        db.execute('DELETE FROM agent_tasks WHERE task_id=%s', (managed['tid'],))
    elif change == 'paused':
        db.execute("UPDATE containers SET status='paused'")
    else:
        field = {'hold': 'start_hold=true', 'cancelled': "status='cancelled'",
                  'owner_decision': "awaiting_owner_decision='changes_requested'"}[change]
        db.execute('UPDATE tasks SET ' + field + ' WHERE id=%s', (managed['tid'],))
    for path, body in [('/poll', {}), (f'/{mid}/handled', {'outcome': 'applied'})]:
        response = await client.post(managed['url'] + path, headers=managed['headers'], json=body)
        assert response.status_code == status, response.text
    assert db.execute('SELECT handled_at FROM managed_message_receipts')[0]['handled_at'] is None


async def test_managed_calls_never_change_activity_or_turn_counts(client, managed, db):
    mid = messages(db, managed, 1)[0]
    def activity():
        return [db.execute(q) for q in [
            'SELECT last_heartbeat_at,turns_used FROM agents',
            'SELECT work_last_heartbeat_at,wake_lease_until,last_woken_at FROM agent_wake_state',
            'SELECT * FROM worker_run_lines']]
    before = activity()
    page = await poll(client, managed)
    assert page['messages'][0]['event_ids'] == []
    assert page['task']['definition_of_done'] == 'Read guidance exactly once'
    await handle(client, managed, mid)
    assert activity() == before


async def test_rebind_of_token_rejected_atomically(client, managed, db):
    response = await client.post(f"/api/agents/{managed['aid']}/runs",
                                  json={'task_id': managed['tid'], 'token_id': managed['token']})
    assert response.status_code == 409
    assert len(db.execute('SELECT * FROM worker_runs')) == 1
    assert str(db.execute('SELECT run_id FROM embodiment_tokens')[0]['run_id']) == managed['rid']


async def test_unreceived_and_changed_outcome_refused(client, managed, db):
    mid = messages(db, managed, 1)[0]
    path = managed['url'] + f'/{mid}/handled'
    response = await client.post(path, headers=managed['headers'], json={'outcome': 'applied'})
    assert response.status_code == 409
    await poll(client, managed)
    await handle(client, managed, mid)
    response = await client.post(path, headers=managed['headers'], json={'outcome': 'not_applicable', 'handling_note': 'Superseded by owner guidance'})
    assert response.status_code == 409


async def test_managed_openapi_and_limits(client, managed):
    spec = (await client.get('/openapi.json')).json()
    for path in ['/api/tasks/{tid}/managed-messages/poll', '/api/tasks/{tid}/managed-messages/{mid}/handled']:
        route = spec['paths'][path]['post']
        assert route['responses']['200']['content']['application/json']['schema']['$ref']
        assert any(p['name'].lower() == 'x-orcha-run-token' for p in route['parameters'])
    for limit in [0, 201]:
        assert (await client.post(managed['url'] + '/poll', headers=managed['headers'],
                                   json={'limit': limit})).status_code == 422
    assert (await client.post(managed['url'] + '/poll', json={})).status_code == 403


async def test_stale_daemon_cannot_renew_or_release_successor(client, managed, db):
    await poll(client, managed)
    aid, old = managed['aid'], managed['rid']
    db.execute("UPDATE worker_runs SET status='exited',ended_at=now() WHERE run_id=%s", (old,))
    token = (await client.post(f'/api/agents/{aid}/embodiment-tokens',
                              json={'lane': 'work', 'kind': 'headless'})).json()['run_token']
    response = await client.post(f'/api/agents/{aid}/runs', json={
        'task_id': managed['tid'], 'token_id': token, 'managed_commands': True})
    assert response.status_code == 201, response.text
    new = response.json()['run_id']
    before = db.execute('SELECT * FROM agent_wake_state WHERE agent_id=%s', (aid,))
    for identity in [{}, {'run_id': old}]:
        response = await client.post(f'/api/agents/{aid}/wake-renew', json=identity)
        assert not response.json()['renewed'], response.text
        response = await client.post(f'/api/agents/{aid}/wake-ack', json={
            'kind': 'finished', 'release_lease': True, **identity})
        assert response.json()['released'] is False, response.text
        assert db.execute('SELECT * FROM agent_wake_state WHERE agent_id=%s', (aid,)) == before
        assert db.execute('SELECT status FROM worker_runs WHERE run_id=%s', (new,))[0]['status'] == 'running'
    # The stale worker token was not revoked in this simulated race: the lane binding still fences it.
    response = await client.post(managed['url'] + '/poll', headers=managed['headers'], json={})
    assert response.status_code == 409, response.text
    response = await client.post(f'/api/agents/{aid}/wake-renew', json={'run_id': new})
    assert response.json()['renewed'], response.text
    await client.post(f'/api/runs/{new}/finish', json={'status': 'exited', 'exit_code': 0})
    response = await client.post(f'/api/agents/{aid}/wake-ack', json={
        'kind': 'finished', 'release_lease': True, 'run_id': new})
    assert response.status_code == 200, response.text
    assert response.json()['wake_lease_until'] is None


async def test_same_task_old_running_token_cannot_use_new_lane(client, managed, db):
    # Even if a legacy launcher records two running rows, a previous token cannot
    # borrow the lane that was just bound to a different run on the same task.
    token = (await client.post(f"/api/agents/{managed['aid']}/embodiment-tokens",
                              json={'lane': 'work', 'kind': 'headless'})).json()['run_token']
    response = await client.post(f"/api/agents/{managed['aid']}/runs",
                                  json={'task_id': managed['tid'], 'token_id': token})
    assert response.status_code == 201, response.text
    response = await client.post(managed['url'] + '/poll', headers=managed['headers'], json={})
    assert response.status_code == 409
    assert response.json()['detail']['code'] == 'worker_lane_owner_changed'


async def test_workflow_messages_use_generation_without_ordinary_lease(client, db, monkeypatch):
    from test_workflow_local_launch import Project
    from portal_backend import workflow_service as ws
    monkeypatch.setattr(ws, 'WORKFLOWS_INTEGRATED', True)
    project = Project(client)
    await project.start('serial', [('build', project.ann, [])])
    launch = await project.reserve(project.ann, 'build')
    activation = await project.activate(project.ann, launch)
    headers = {'X-Orcha-Run-Token': activation['run_token']}
    tid = project.tasks['build']
    url = f'/api/tasks/{tid}/managed-messages'
    assert all(row['wake_lease_until'] is None for row in db.execute(
        'SELECT wake_lease_until FROM agent_wake_state WHERE agent_id=%s', (project.ann,)))
    mid = str(uuid4())
    db.execute('INSERT INTO task_messages(id,task_id,body) VALUES (%s,%s,%s)', (mid, tid, 'Follow-up'))
    response = await client.post(url + '/poll', json={}, headers=headers)
    assert response.status_code == 200, response.text
    db.execute("UPDATE workflows SET status='paused' WHERE id=%s", (project.wid,))
    response = await client.post(url + f'/{mid}/handled', json={'outcome': 'applied'}, headers=headers)
    assert response.status_code == 409, response.text
    db.execute("UPDATE workflows SET status='active' WHERE id=%s", (project.wid,))
    db.execute('UPDATE workflow_executions SET generation_revoked_at=now() WHERE run_id=%s', (launch['run_id'],))
    response = await client.post(url + '/poll', json={}, headers=headers)
    assert response.status_code == 409, response.text
    assert db.execute('SELECT handled_at FROM managed_message_receipts')[0]['handled_at'] is None


@pytest.mark.parametrize("with_job", [False, True])
async def test_renewal_and_reaper_serialize_before_eligibility(client, managed, db, monkeypatch, with_job):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from starlette.requests import Request
    from portal_backend import wake_lease_renewal_routes as renewal
    from portal_backend.orphan_lease_routes import reap_orphan_leases
    from portal_backend.schemas.wakes import WakeClaim
    await poll(client, managed)
    if with_job:
        from test_gh312_managed_jobs import publish, reserve
        await publish(client, managed, seconds=7200)
        await reserve(client, managed)
        db.execute('UPDATE worker_runs SET started_at=%s WHERE run_id=%s', (db.ago(3000), managed['rid']))
    db.execute('UPDATE agents SET last_heartbeat_at=%s WHERE id=%s', (db.ago(3000), managed['aid']))
    db.execute('UPDATE agent_wake_state SET work_last_heartbeat_at=%s,last_woken_at=%s WHERE agent_id=%s',
               (db.ago(3000), db.ago(3000), managed['aid']))
    cid = str(db.execute('SELECT container_id FROM agents WHERE id=%s', (managed['aid'],))[0]['container_id'])
    locked, resume, reaping = Event(), Event(), Event()
    real = renewal.lock_agent_runs
    def lock_then_wait(*args):
        result = real(*args)
        locked.set()
        assert resume.wait(5)
        return result
    monkeypatch.setattr(renewal, 'lock_agent_runs', lock_then_wait)
    def reap():
        reaping.set()
        return reap_orphan_leases(cid, Request({'type': 'http', 'headers': []}), orphan_secs=1260)
    with ThreadPoolExecutor(max_workers=2) as pool:
        renewed = pool.submit(renewal.wake_renew, managed['aid'], WakeClaim(run_id=managed['rid']))
        try:
            assert locked.wait(5)
            reaped = pool.submit(reap)
            assert reaping.wait(5)
            # Give the contender a chance to reach the database while the first
            # transaction owns the lane; SQLite and PostgreSQL must both wait.
            assert not Event().wait(0.15)
        finally:
            resume.set()
        assert renewed.result(timeout=5)['renewed']
        result = reaped.result(timeout=5)
    assert not result['reaped'] and not result['stranded']
    assert db.execute('SELECT status FROM worker_runs WHERE run_id=%s', (managed['rid'],))[0]['status'] == 'running'


@pytest.mark.parametrize("note", [None, "", "   "])
async def test_non_applicable_requires_explanation_as_validation_response(client, managed, note):
    response = await client.post(managed['url'] + f'/{uuid4()}/handled',
                                 headers=managed['headers'],
                                 json={'outcome': 'not_applicable', 'handling_note': note})
    assert response.status_code == 422, response.text
