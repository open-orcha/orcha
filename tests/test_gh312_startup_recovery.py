"""Real startup, notification and lost-transfer sequences across worker boundaries."""

import sys
import time
import pytest
from test_gh312_managed_messages import managed
from test_gh312_job_supervisor import service, eventually, result, running, jobs
from test_gh312_job_recovery import successor
from test_gh312_job_transfer import observed
from test_gh312_managed_jobs import publish, reserve
from orcha_cli.cli_job import start_job
from orcha_cli.job_api import JobAPI
from orcha_cli.job_store import JobStore, JobStorageError
from orcha_cli.job_transfer import transfer_command


@pytest.mark.skipif(sys.platform != 'darwin', reason='Enforced host continuation is macOS only')
@pytest.mark.parametrize('committed', [True, False])
async def test_lost_adoption_reply_then_lapsed_retry_preserves_original_operation(
    client, managed, service, tmp_path, db, monkeypatch, committed
):
    from fastapi import HTTPException
    from portal_backend.application import app

    await publish(client, managed, seconds=120)
    api = JobAPI(service[0], managed['token'], managed['tid'])
    store = JobStore(tmp_path)
    jid = start_job(
        api,
        store,
        key='lost-then-lapsed',
        purpose='Review probe',
        cwd=tmp_path,
        argv=[sys.executable, '-c', 'import time;time.sleep(60)'],
        isolate=True,
    )['job_id']
    try:
        process = eventually(lambda: running(store, jid))
        eventually(lambda: store.read(jid).get('transfer_socket'))
        transfer_command(store, jid, 'prepare', api.token)
        new = await successor(client, managed)
        await observed(client, managed, db)
        if not committed:
            # Lease recovery requires work already owned by this successor.
            # Keep an unlaunched reservation while the transfer is uncertain.
            await reserve(client, new)
        route = next(r for r in app.routes if getattr(r, 'path', '').endswith('/transfer/adopt'))
        original = route.dependant.call
        calls = []
        refusals = []

        def lose_reply_and_expire_lease(*args, **kwargs):
            calls.append(str(kwargs['body'].operation_id))
            try:
                value = original(*args, **kwargs) if committed or len(calls) > 1 else None
            except HTTPException as exc:
                if isinstance(exc.detail, dict) and exc.detail.get('code') == 'worker_lease_lapsed':
                    refusals.append(True)
                raise
            if len(calls) == 1:
                db.execute(
                    'UPDATE agent_wake_state SET wake_lease_until=%s WHERE agent_id=%s',
                    (db.ago(1), managed['aid']),
                )
                raise HTTPException(503, 'Simulated lost response after commit')
            return value

        monkeypatch.setattr(route.dependant, 'call', lose_reply_and_expire_lease)
        with pytest.raises(JobStorageError):
            transfer_command(store, jid, 'adopt', new['token'])
        eventually(lambda: refusals)
        assert str(
            db.execute('SELECT owner_run_id FROM managed_jobs WHERE job_id=%s', (jid,))[0]['owner_run_id']
        ) == (new['rid'] if committed else managed['rid'])
        assert store.read(jid)['owner_run_id'] == managed['rid']
        renewed = await client.post(f"/api/agents/{managed['aid']}/wake-renew", json={'run_id': new['rid']})
        assert renewed.status_code == 200 and renewed.json()['renewed'], renewed.text
        # Recovery must reuse the exact committed operation and keep the original process.
        eventually(lambda: store.read(jid)['owner_run_id'] == new['rid'])
        assert result(store, jid) is None, 'Committed adoption was abandoned after a retryable lease lapse'
        assert store.read(jid)['owner_run_id'] == new['rid']
        assert len(set(calls)) == 1
        assert running(store, jid) == process
        assert store.read(jid)['transfers_used'] == 1
    finally:
        db.execute('UPDATE worker_runs SET stop_requested_at=%s', (db.ago(0),))
        eventually(lambda: result(store, jid), seconds=12)


@pytest.mark.parametrize('delivery', ['event_ack', 'wake_ack', 'eventless'])
@pytest.mark.parametrize('replace_before_poll', [True, False])
async def test_late_task_binding_before_first_poll_preserves_startup(
    client, make_agent, make_request, db, delivery, replace_before_poll
):
    aid = (await make_agent('Late bound reviewer probe'))['agent_id']
    requester = (await make_agent('Probe requester'))['agent_id']
    request = await make_request(
        requester,
        'Please handle the assigned command.',
        target_alias='Late bound reviewer probe',
        type='task',
        task={'title': 'Late bound work', 'definition_of_done': 'Preserve startup guidance'},
    )
    token = (
        await client.post(f'/api/agents/{aid}/embodiment-tokens', json={'lane': 'work', 'kind': 'headless'})
    ).json()['run_token']
    headers = {'X-Orcha-Run-Token': token}
    assert (await client.post(f'/api/agents/{aid}/wake-claim', json={})).json()['claimed']
    # A worker can accept before the notifier registers the spawned process.
    accepted = await client.post(
        f"/api/requests/{request['id']}/accept-task", headers=headers, json={'responder_agent_id': aid}
    )
    assert accepted.status_code == 200, accepted.text
    tid = accepted.json()['spawned_task_id']
    boundary = db.execute('SELECT work_dispatch_started_at FROM agent_wake_state WHERE agent_id=%s', (aid,))[
        0
    ]['work_dispatch_started_at']
    posted = await client.post(f'/api/tasks/{tid}/messages', json={'body': 'Keep this startup instruction'})
    assert posted.status_code == 201, posted.text
    mid = posted.json()['message_id']
    events = db.execute(
        "SELECT id FROM agent_events WHERE event_key=%s AND event_name='task_message'", (aid,)
    )
    assert events
    if delivery == 'eventless':
        db.execute('DELETE FROM agent_events WHERE event_key=%s AND event_name=%s', (aid, 'task_message'))
    else:
        ack = await client.post(
            f'/api/agents/{aid}/events/ack-handled', json={'event_ids': [r['id'] for r in events]}
        )
        assert ack.status_code == 200, ack.text
    if delivery == 'wake_ack':
        time.sleep(0.02)
        ack = await client.post(
            f'/api/agents/{aid}/wake-ack',
            json={'kind': 'ephemeral', 'release_lease': False, 'stamp_woken': True},
        )
        assert ack.status_code == 200, ack.text
        assert (
            db.execute('SELECT last_woken_at FROM agent_wake_state WHERE agent_id=%s', (aid,))[0][
                'last_woken_at'
            ]
            > boundary
        )
    assert not (await client.post(f'/api/agents/{aid}/wake-claim', json={})).json()['claimed']
    assert (
        db.execute('SELECT work_dispatch_started_at FROM agent_wake_state WHERE agent_id=%s', (aid,))[0][
            'work_dispatch_started_at'
        ]
        == boundary
    )
    time.sleep(0.02)
    # A prompt run deliberately starts without inferred task context.
    run = await client.post(f'/api/agents/{aid}/runs', json={'token_id': token, 'wake_event': 'prompt'})
    assert run.status_code == 201, run.text
    assert run.json()['task_id'] is None
    # Retrying an accepted request is the public late-attribution seam.
    accepted = await client.post(
        f"/api/requests/{request['id']}/accept-task", headers=headers, json={'responder_agent_id': aid}
    )
    assert accepted.status_code == 200, accepted.text
    original_run = run.json()['run_id']
    if replace_before_poll:
        new = await successor(client, {'aid': aid, 'tid': tid, 'rid': original_run, 'token': token})
        headers = new['headers']
    assert (
        str(
            db.execute('SELECT first_run_id FROM managed_message_windows WHERE task_id=%s', (tid,))[0][
                'first_run_id'
            ]
        )
        == original_run
    )
    page = await client.post(f'/api/tasks/{tid}/managed-messages/poll', headers=headers, json={})
    assert page.status_code == 200, page.text
    assert mid in [
        m['message_id'] for m in page.json()['messages']
    ], 'Startup guidance lost when task attribution follows run registration'


async def test_initial_lease_lapse_does_not_poison_never_launched_key(
    jobs, managed, client, db, monkeypatch, tmp_path
):
    from portal_backend.application import app

    api, store, launch = jobs
    route = next(r for r in app.routes if getattr(r, 'path', '').endswith('/{jid}/heartbeat'))
    original = route.dependant.call
    replies = []

    def lapse_before_first_heartbeat(*args, **kwargs):
        if not replies:
            db.execute(
                'UPDATE agent_wake_state SET wake_lease_until=%s WHERE agent_id=%s',
                (db.ago(1), managed['aid']),
            )
        value = original(*args, **kwargs)
        replies.append(value['mutations_allowed'])
        return value

    monkeypatch.setattr(route.dependant, 'call', lapse_before_first_heartbeat)
    code = "open('starts','a').write('once')"
    jid = launch(code)
    eventually(lambda: store.read(jid)['status'] in {'not_started', 'unknown'})
    assert replies == [False]
    assert db.execute('SELECT version,state FROM managed_jobs') == [{'version': 0, 'state': 'reserved'}]
    assert not (store.job_directory(jid) / 'process.json').exists()
    renewed = await client.post(f"/api/agents/{managed['aid']}/wake-renew", json={'run_id': managed['rid']})
    assert renewed.status_code == 200 and renewed.json()['renewed'], renewed.text
    monkeypatch.setattr(route.dependant, 'call', original)
    assert store.read(jid)['status'] == 'not_started'
    # The old supervisor may still be releasing its lock. Retry the same key
    # until launch is admitted, then verify the actual single execution.
    eventually(lambda: (launch(code), store.read(jid)['status'] != 'not_started')[1])
    assert launch(code) == jid
    assert eventually(lambda: result(store, jid))['exit_code'] == 0
    assert (tmp_path / 'starts').read_text() == 'once'
