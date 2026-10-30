"""Accepted-task guidance survives exit before registration or task attribution."""

import time
from uuid import uuid4

import pytest


async def accept(client, request_id, aid, token):
    return await client.post(
        f'/api/requests/{request_id}/accept-task',
        headers={'X-Orcha-Run-Token': token},
        json={'responder_agent_id': aid},
    )


@pytest.fixture
async def unbound(client, make_agent, make_request):
    aid = (await make_agent('Unbound startup probe'))['agent_id']
    requester = (await make_agent('Probe requester'))['agent_id']
    request = await make_request(
        requester,
        'Please do the assigned command.',
        target_alias='Unbound startup probe',
        type='task',
        task={'title': 'Startup interruption', 'definition_of_done': 'Keep startup instructions'},
    )
    token = (
        await client.post(f'/api/agents/{aid}/embodiment-tokens',
                          json={'lane': 'work', 'kind': 'headless'})
    ).json()['run_token']
    return aid, request['id'], token


@pytest.mark.parametrize('delivery', ['event_ack', 'wake_ack', 'eventless'])
@pytest.mark.parametrize('interruption', ['before_registration', 'before_attribution', 'after_attribution'])
async def test_accept_before_registration_exit_before_attribution(client, unbound, db, delivery, interruption):
    aid, request_id, token = unbound
    claim = await client.post(f'/api/agents/{aid}/wake-claim', json={})
    assert claim.json()['claimed'], claim.text
    accepted = await accept(client, request_id, aid, token)
    assert accepted.status_code == 200, accepted.text
    tid = accepted.json()['spawned_task_id']
    posted = await client.post(f'/api/tasks/{tid}/messages', json={'body': 'Keep this startup instruction'})
    assert posted.status_code == 201, posted.text
    mid = posted.json()['message_id']
    events = db.execute("SELECT id FROM agent_events WHERE event_key=%s AND event_name='task_message'", (aid,))
    assert events
    if delivery != 'eventless':
        response = await client.post(f'/api/agents/{aid}/events/ack-handled',
                                     json={'event_ids': [row['id'] for row in events]})
        assert response.status_code == 200, response.text
    else:
        db.execute("DELETE FROM agent_events WHERE event_key=%s AND event_name='task_message'", (aid,))
    # Retaining startup guidance must not revive old discussion or our own posts.
    db.execute('INSERT INTO task_messages(id,task_id,body,created_at) VALUES (%s,%s,%s,%s)',
               (str(uuid4()), tid, 'Old discussion', db.ago(86400)))
    own = await client.post(f'/api/tasks/{tid}/messages',
                            json={'author_agent_id': aid, 'body': 'My own progress'})
    assert own.status_code == 201, own.text
    if delivery == 'wake_ack':
        notified = await client.post(f'/api/agents/{aid}/wake-ack',
                                     json={'kind': 'ephemeral', 'release_lease': False, 'stamp_woken': True})
        assert notified.status_code == 200, notified.text
    rid = None
    if interruption != 'before_registration':
        run = await client.post(f'/api/agents/{aid}/runs', json={'token_id': token, 'wake_event': 'prompt'})
        assert run.status_code == 201, run.text
        assert run.json()['task_id'] is None
        rid = run.json()['run_id']
        if interruption == 'after_attribution':
            rebound = await accept(client, request_id, aid, token)
            assert rebound.status_code == 200, rebound.text
        # The two earlier interruption cases never repeat successful acceptance.
        ended = await client.post(f'/api/runs/{rid}/finish', json={'status': 'exited', 'exit_code': 0})
        assert ended.status_code == 200, ended.text
    # If registration never happened, the notifier releases the unbound lease
    # after confirming exit. Otherwise release only the exact finished run.
    ack = await client.post(f'/api/agents/{aid}/wake-ack',
                            json={'kind': 'ephemeral', 'release_lease': True, 'run_id': rid})
    assert ack.status_code == 200, ack.text
    time.sleep(0.02)
    claim = await client.post(f'/api/agents/{aid}/wake-claim', json={})
    assert claim.json()['claimed'], claim.text
    next_token = (
        await client.post(f'/api/agents/{aid}/embodiment-tokens',
                          json={'lane': 'work', 'kind': 'headless'})
    ).json()['run_token']
    replacement = await client.post(f'/api/agents/{aid}/runs', json={'token_id': next_token, 'task_id': tid})
    assert replacement.status_code == 201, replacement.text
    headers = {'X-Orcha-Run-Token': next_token}
    page = await client.post(f'/api/tasks/{tid}/managed-messages/poll', headers=headers, json={})
    assert page.status_code == 200, page.text
    assert [m['message_id'] for m in page.json()['messages']] == [mid], 'Unhandled startup instruction lost'
    handled = await client.post(f'/api/tasks/{tid}/managed-messages/{mid}/handled',
                                headers=headers, json={'outcome': 'applied'})
    assert handled.status_code == 200, handled.text
    # Retrying acceptance cannot reset the window or resurrect handled guidance.
    rebound = await accept(client, request_id, aid, next_token)
    assert rebound.status_code == 200, rebound.text
    page = await client.post(f'/api/tasks/{tid}/managed-messages/poll', headers=headers, json={})
    assert page.status_code == 200 and page.json()['messages'] == [], page.text


async def test_unbound_acceptance_retry_keeps_boundary_without_scheduling_claim(client, unbound, db):
    aid, request_id, token = unbound
    accepted = await accept(client, request_id, aid, token)
    assert accepted.status_code == 200, accepted.text
    tid = accepted.json()['spawned_task_id']
    query = 'SELECT started_at FROM managed_task_dispatches WHERE task_id=%s AND agent_id=%s'
    saved = db.execute(query, (tid, aid))[0]['started_at']
    posted = await client.post(f'/api/tasks/{tid}/messages', json={'body': 'Instruction before registration'})
    assert posted.status_code == 201, posted.text
    mid = posted.json()['message_id']
    db.execute("DELETE FROM agent_events WHERE event_key=%s AND event_name='task_message'", (aid,))
    time.sleep(0.02)
    assert (await client.post(f'/api/agents/{aid}/wake-claim', json={})).json()['claimed']
    retried = await accept(client, request_id, aid, token)
    assert retried.status_code == 200 and retried.json()['already_accepted'], retried.text
    assert db.execute(query, (tid, aid))[0]['started_at'] == saved
    run = await client.post(f'/api/agents/{aid}/runs', json={'token_id': token, 'task_id': tid})
    assert run.status_code == 201, run.text
    page = await client.post(f'/api/tasks/{tid}/managed-messages/poll',
                             headers={'X-Orcha-Run-Token': token}, json={})
    assert page.status_code == 200, page.text
    assert [m['message_id'] for m in page.json()['messages']] == [mid]


async def test_unbound_boundary_rolls_back_with_failed_acceptance(client, unbound, db, monkeypatch):
    from portal_backend import request_acceptance_routes as routes

    aid, request_id, token = unbound
    original = routes._attribute_token_run_to_task_getter()

    def interrupt(*args):
        original(*args)
        raise RuntimeError('Interrupted before acceptance commit')

    monkeypatch.setattr(routes, '_attribute_token_run_to_task_getter', lambda: interrupt)
    with pytest.raises(RuntimeError, match='Interrupted before acceptance commit'):
        await accept(client, request_id, aid, token)
    assert not db.execute('SELECT * FROM managed_task_dispatches')
    assert db.execute('SELECT status,spawned_task_id FROM requests WHERE id=%s', (request_id,)) == [
        {'status': 'open', 'spawned_task_id': None}
    ]
