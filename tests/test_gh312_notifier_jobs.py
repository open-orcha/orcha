"""Real detached-child shutdown, recovery, and durable handoff notices."""

import asyncio
import os
import signal
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest

from orcha_cli import notifier_managed_jobs as handoff
from orcha_cli.job_store import atomic_json, read_json
from test_gh312_job_supervisor import service, jobs, running, result, eventually
from test_gh312_managed_messages import managed


def worker_record(managed, store, **extra):
    return {'run_id': managed['rid'], 'run_token': managed['token'],
            'base_cwd': str(store.root.parent.parent), 'respawn_ctx': {'task_id': managed['tid']}, **extra}


@pytest.fixture
def transport():
    with httpx.Client(timeout=2) as client:
        def post(url, body):
            response = client.post(url, json=body)
            assert response.status_code == 201, response.text
            return response.json()
        yield SimpleNamespace(_post_json=post)


@pytest.mark.parametrize('autonomy', ['on', 'off'])
async def test_handoff_notice_retry_survives_interleaving_without_plan_approval(client, managed, db, autonomy):
    db.execute('UPDATE tasks SET autonomy=%s WHERE id=%s', (autonomy, managed['tid']))
    url = f"/api/tasks/{managed['tid']}/messages"
    body = {'system_notice': True, 'system_notice_key': str(uuid4()), 'body': 'Command recovery details are saved.'}
    first = await client.post(url, json=body)
    assert first.status_code == 201
    await client.post(url, json={'body': 'Another system update', 'system_notice': True})
    retry = await client.post(url, json=body)
    assert retry.json()['message_id'] == first.json()['message_id']
    assert retry.json()['deduplicated']
    assert len(db.execute('SELECT * FROM task_messages')) == 2
    assert not db.execute('SELECT * FROM task_approval_records')
    assert not db.execute("SELECT * FROM agent_events WHERE target_id IS NOT NULL AND event_name='task_message'")
    conflict = await client.post(url, json={**body, 'body': 'Changed content'})
    assert conflict.status_code == 409
    assert (await client.post(url, json={**body, 'author_agent_id': managed['aid']})).status_code == 403
    assert (await client.post(url, json={**body, 'system_notice': False})).status_code == 422


async def test_daemon_checkpoints_and_stops_after_token_revocation(jobs, managed, client, service, transport):
    api, store, launch = jobs
    jid = launch('import time;time.sleep(60)')
    eventually(lambda: running(store, jid))
    await client.post(f"/api/embodiment-tokens/{managed['token']}/revoke", json={})
    worker = worker_record(managed, store)
    assert await asyncio.to_thread(handoff.prepare, service[0], worker, transport, reason='human_stop', stop=True)
    directory = store.job_directory(jid)
    checkpoint = read_json(directory/'handoff.json')
    stopped = result(store, jid)
    assert checkpoint['saved_at'] < stopped['finished_at']
    assert stopped['termination_verified'] and stopped['status'] == 'interrupted'
    assert checkpoint['pending_messages'] == [] and checkpoint['guidance_incomplete']
    assert read_json(directory/'mechanical.json')['saved_monotonic'] > 0
    assert handoff.settled(store.read(jid))


async def test_supervisor_crash_result_reconciles_without_relaunch(jobs, managed, service, transport, tmp_path):
    api, store, launch = jobs
    jid = launch("import time;open('starts','a').write('once');time.sleep(60)")
    eventually(lambda: running(store, jid))
    eventually(lambda: store.read(jid).get('supervisor'))
    original = store.read(jid)
    os.kill(original['supervisor']['pid'], signal.SIGKILL)
    stopped = eventually(lambda: result(store, jid))
    assert stopped['termination_verified']
    worker = worker_record(managed, store)
    assert await asyncio.to_thread(handoff.prepare, service[0], worker, transport, reason='worker_missing', stop=True)
    assert handoff.settled(store.read(jid))
    assert launch("raise AssertionError('must not launch again')") == jid
    assert (tmp_path/'starts').read_text() == 'once'


async def test_notifier_reconciles_lapsed_lease_but_stops_for_hold(jobs, managed, service, db):
    api, store, launch = jobs
    jid = launch('import time;time.sleep(60)')
    eventually(lambda: running(store, jid))
    worker = worker_record(managed, store)
    assert await asyncio.to_thread(handoff.reconcile_renewal, service[0], worker)
    from datetime import datetime, timedelta, timezone
    db.execute('UPDATE agent_wake_state SET wake_lease_until=%s WHERE agent_id=%s',
               (datetime.now(timezone.utc)-timedelta(seconds=1), managed['aid']))
    assert await asyncio.to_thread(handoff.reconcile_renewal, service[0], worker)
    assert not worker['managed_authority_clocks'][jid].mutations_allowed
    db.execute("UPDATE tasks SET status='cancelled' WHERE id=%s", (managed['tid'],))
    assert not await asyncio.to_thread(handoff.reconcile_renewal, service[0], worker)


async def test_stale_daemon_stop_does_not_control_current_job(jobs, managed):
    api, store, launch = jobs
    jid = launch('import time;time.sleep(1)')
    eventually(lambda: running(store, jid))
    record = store.read(jid)
    atomic_json(store.job_directory(jid)/'daemon-stop.json', {
        'owner_run_id': str(uuid4()), 'launch_nonce': record['launch_nonce'], 'reason': 'old worker'})
    observed = eventually(lambda: result(store, jid))
    assert observed['status'] == 'completed' and observed['exit_code'] == 0


async def test_notice_lost_response_and_restart_posts_once(jobs, managed, service, transport, db):
    api, store, launch = jobs
    jid = launch('import time;time.sleep(60)')
    eventually(lambda: running(store, jid))
    worker = worker_record(managed, store)
    lost = SimpleNamespace(_post_json=lambda url, body: (transport._post_json(url, body), None)[1])
    assert await asyncio.to_thread(handoff.prepare, service[0], worker, lost, reason='deadline')
    transport._post_json(f"{service[0]}/api/tasks/{managed['tid']}/messages", {'system_notice': True, 'body': 'Interleaved update'})
    assert await asyncio.to_thread(handoff.prepare, service[0], dict(worker), transport, reason='deadline')
    assert len(db.execute('SELECT * FROM system_notice_receipts')) == 1
    assert len(db.execute('SELECT * FROM task_messages')) == 2


def test_unknown_reservation_retains_fence_and_records_stop(tmp_path):
    from orcha_cli.job_store import JobStore
    store = JobStore(tmp_path)
    jid, rid = str(uuid4()), str(uuid4())
    record = store.reserve(jid, {'owner_run_id': rid, 'launch_nonce': str(uuid4()),
                                'task_id': str(uuid4()), 'cwd': str(tmp_path), 'status': 'reserved'})
    worker = {'run_id': rid, 'base_cwd': str(tmp_path)}
    transport = SimpleNamespace(_post_json=lambda *a: {'message_id': str(uuid4())})
    assert not handoff.prepare('http://test', worker, transport, reason='transfer', stop=True, wait_secs=0)
    assert worker['managed_disposition_unknown']
    assert read_json(store.job_directory(jid)/'daemon-stop.json')['launch_nonce'] == record['launch_nonce']
    with store.locked():
        assert store.retains_worktree(tmp_path)


def test_unknown_job_prevents_checkpoint_replacement_after_worker_stop(tmp_path):
    from orcha_cli.job_store import JobStore
    from orcha_cli.notifier_checkpoint import checkpoint_and_respawn
    store = JobStore(tmp_path)
    jid, rid = str(uuid4()), str(uuid4())
    store.reserve(jid, {'owner_run_id': rid, 'launch_nonce': str(uuid4()),
                        'task_id': str(uuid4()), 'cwd': str(tmp_path), 'status': 'unknown'})
    worker = {'run_id': rid, 'base_cwd': str(tmp_path), 'proc': SimpleNamespace(poll=lambda: 0)}
    observed = []
    def kill(proc, **kwargs):
        directory = store.job_directory(jid)
        assert (directory/'handoff.json').exists() and (directory/'daemon-stop.json').exists()
        observed.append('stopped')
    services = SimpleNamespace(_kill_worker=kill, HARD_CAP_MIN_SECS=1200, HARD_CAP_RESPAWN_MAX=3,
                               _post_json=lambda *args: {'message_id': str(uuid4())})
    checkpoint_and_respawn('http://test', 'agent', worker, {}, True, services)
    assert observed == ['stopped'] and worker['managed_disposition_unknown']
    assert worker['respawns'] == 3  # No spawn service exists: an unsafe replacement fails this test.


def test_startup_pointers_omit_private_metadata_and_explain_both_wait_contracts(tmp_path):
    from orcha_cli.job_store import JobStore
    from orcha_cli.job_guidance import startup_guidance
    store = JobStore(tmp_path)
    tid, jid = str(uuid4()), str(uuid4())
    store.reserve(jid, {'task_id': tid, 'owner_run_id': str(uuid4()), 'cwd': str(tmp_path),
                        'status': 'running', 'purpose': 'private-purpose-fixture',
                        'command': 'private-command-fixture'})
    (store.job_directory(jid)/'stdout.log').write_text('private-output-fixture')
    text = startup_guidance(tmp_path, tid)
    assert jid in text and 'record.json' in text
    assert all(secret not in text for secret in ('private-purpose-fixture', 'private-command-fixture', 'private-output-fixture'))
    assert '--seconds 100' in text and '120000' in text and 'session_id' in text
    assert 'write_stdin' in text and 'yield_time_ms=50000' in text
    assert 'Generic commands stop before worker transfer' in text
    assert jid not in startup_guidance(tmp_path, str(uuid4()))


async def test_system_notice_key_is_in_generated_contract(client):
    schema = (await client.get('/openapi.json')).json()
    field = schema['components']['schemas']['TaskMessage']['properties']['system_notice_key']
    assert any(part.get('format') == 'uuid' for part in field['anyOf'])


async def test_concurrent_short_commands_keep_observed_exit_results(jobs):
    api, store, launch = jobs
    ids = [launch('import time;time.sleep(.1)', key=f'short-{index}') for index in range(12)]
    for jid in ids:
        directory = store.job_directory(jid)
        eventually(lambda: result(store, jid) or (directory/'guard-error.json').exists())
        assert not (directory/'guard-error.json').exists(), read_json(directory/'guard-error.json') if (directory/'guard-error.json').exists() else {}
        assert result(store, jid)['exit_code'] == 0
        assert result(store, jid)['termination_verified']
