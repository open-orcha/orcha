"""Cancellation closes queued work and refuses worker replacements through real routes."""
import pytest

from test_qa_run_tasks import team, inline, task, hand, session, finish, thread  # noqa: F401
from test_qa_time_limits import timeout


async def continued(team, minutes=0):
    out, old = await timeout(team)
    response = await team['client'].post(f"/api/qa/sessions/{old['id']}/continue", json={
        'actor_agent_id': team['human'], 'minutes': minutes})
    assert response.status_code == 201, response.text
    return out, old, response.json()


async def start(team, tid, **extra):
    return await team['client'].post(f"/api/containers/{team['cid']}/qa/sessions", json={
        'actor_agent_id': team['qa'], 'kind': 'explore', 'platform': 'web', 'task_id': tid, **extra})


@pytest.mark.parametrize('through', ['request', 'task'])
@pytest.mark.parametrize('stage', ['queued', 'claimed', 'device_wait'])
async def test_cancel_continuation_ends_work_preserves_evidence_and_queue(team, db, through, stage):
    out, old, queued = await continued(team)
    tid, rid, sid = out['qa_task_id'], out['request']['id'], queued['id']
    before = db.execute('SELECT * FROM qa_sessions WHERE id=%s', (old['id'],))[0]
    verdicts = db.execute('SELECT * FROM qa_acceptance_verdicts WHERE request_id=%s', (rid,))
    if stage != 'queued':
        assert (await session(team, task_id=tid))['id'] == sid
        if stage == 'device_wait':
            response = await team['client'].patch(f'/api/qa/sessions/{sid}', json={
                'actor_agent_id': team['qa'], 'budget_used_seconds': 17,
                'waiting': {'device': 'iPhone', 'reason': 'Device busy', 'position': 1}})
            assert response.status_code == 200, response.text
    other, _, next_queue = await continued(team, 45)
    path = f'/api/qa/requests/{rid}/cancel' if through == 'request' else f'/api/tasks/{tid}/cancel'
    response = await team['client'].post(path, json={'actor_agent_id': team['human'], 'reason': 'Stop this run'})
    assert response.status_code == 200, response.text
    ended = (await team['client'].get(f'/api/qa/sessions/{sid}')).json()
    assert ended['status'] == 'cancelled' and ended['ended_at']
    assert ended['queue'] is None and not ended['queued'] and ended['stop_reason']
    assert 'waiting' not in ended['result']
    assert db.execute('SELECT * FROM qa_sessions WHERE id=%s', (old['id'],))[0] == before
    assert db.execute('SELECT * FROM qa_acceptance_verdicts WHERE request_id=%s', (rid,)) == verdicts
    following = (await team['client'].get(f"/api/qa/sessions/{next_queue['id']}")).json()
    assert following['status'] == 'running' and following['queue']['position'] == 1
    for extra in ({}, {'request_id': rid}):
        response = await start(team, tid, **extra)
        assert response.status_code == 409, response.text
    active = (await team['client'].get(f"/api/containers/{team['cid']}/qa/sessions?status=running")).json()['sessions']
    assert sid not in [s['id'] for s in active]


async def test_cancel_run_again_without_request_prevents_claim_or_replacement(team, db):
    old = await session(team, task_id=await task(team, assignee='QAEngineer'))
    await finish(team, old)
    response = await team['client'].post(f"/api/qa/sessions/{old['id']}/again", json={'actor_agent_id': team['human']})
    assert response.status_code == 201, response.text
    queued = response.json()
    assert not queued.get('request_id')
    response = await team['client'].post(f"/api/tasks/{queued['task_id']}/cancel", json={
        'actor_agent_id': team['human'], 'reason': 'Stop repeat'})
    assert response.status_code == 200, response.text
    assert db.execute('SELECT status FROM qa_sessions WHERE id=%s', (queued['id'],))[0]['status'] == 'cancelled'
    assert (await start(team, queued['task_id'])).status_code == 409


@pytest.mark.parametrize('state', ['cancelled_task', 'completed_task', 'cancelled_request', 'finished_request'])
@pytest.mark.parametrize('queued', [True, False])
async def test_legacy_terminal_work_cannot_start_or_claim(team, db, state, queued):
    out, old, row = await continued(team)
    tid, rid = out['qa_task_id'], out['request']['id']
    if not queued:
        await session(team, task_id=tid)
        db.execute("UPDATE qa_sessions SET status='abandoned', ended_at=now() WHERE id=%s", (row['id'],))
    if state.endswith('task'):
        db.execute('UPDATE tasks SET status=%s WHERE id=%s', (state.split('_')[0], tid))
    else:
        db.execute('UPDATE qa_requests SET status=%s WHERE id=%s', ('cancelled' if state == 'cancelled_request' else 'passed', rid))
    count = db.execute('SELECT count(*) AS n FROM qa_sessions')[0]['n']
    response = await start(team, tid)
    assert response.status_code == 409, response.text
    assert db.execute('SELECT count(*) AS n FROM qa_sessions')[0]['n'] == count
    if queued:
        from portal_backend import qa_explorations
        qa_explorations.sweep_abandoned(team['cid'], force=True)
        ended = (await team['client'].get(f"/api/qa/sessions/{row['id']}")).json()
        assert ended['status'] != 'running' and ended['queue'] is None


@pytest.mark.parametrize('minutes', [0, 45])
async def test_continue_explains_time_and_uses_same_check_numbers(team, db, minutes):
    out, old, queued = await continued(team, minutes)
    messages = await thread(team, out['qa_task_id'])
    note = next(m for m in messages if m.startswith('Continue QA'))
    stop = next(m for m in messages if m.startswith('[Run result]'))
    assert 'Line 2: The receipt is emailed' in stop and 'Line 2: The receipt is emailed' in note
    assert ('No limit' if minutes == 0 else '45 more minutes') in note
    assert out['request']['id'] not in note and 'minutes=' not in note
    description = db.execute('SELECT description FROM tasks WHERE id=%s', (out['qa_task_id'],))[0]['description']
    assert ('Time limit: none.' if minutes == 0 else 'Time limit: 45 minutes.') in description
    assert (await session(team, task_id=out['qa_task_id']))['budget_minutes'] == minutes


async def test_explicit_run_again_after_finished_request_can_replace_worker(team):
    out, old = await timeout(team)
    response = await team['client'].post(f"/api/qa/sessions/{old['id']}/again", json={'actor_agent_id': team['human']})
    assert response.status_code == 201, response.text
    queued = response.json()
    fresh = await session(team, task_id=queued['task_id'])
    assert not fresh.get('request_id') and fresh['id'] == queued['id']
    await finish(team, fresh, 'abandoned')
    replacement = await session(team, task_id=queued['task_id'])
    assert not replacement.get('request_id')
    assert replacement['result']['resumed_from_session_id'] == fresh['id']


async def test_real_tool_cannot_open_device_after_cancel(team, tmp_path, monkeypatch):
    import main
    from fastapi.testclient import TestClient
    from orcha_cli.qa.mcp_server import QATools
    from test_qa_mcp_portal import AppPortal, Ident, FakeDevice, jshot, opener
    from test_qa_mcp import Clock

    monkeypatch.setattr(main, 'ATTACHMENTS_DIR', tmp_path)
    out = await hand(team, await task(team), platform='ios', kind='check', minutes=20)
    old = await session(team, request_id=out['request']['id'], kind='check', platform='ios')
    response = await team['client'].patch(f"/api/qa/sessions/{old['id']}", json={
        'actor_agent_id': team['qa'], 'status': 'done',
        'result': {'budget': {'minutes': 20, 'used_s': 1201, 'left_s': 0}}})
    assert response.status_code == 200, response.text
    response = await team['client'].post(f"/api/qa/sessions/{old['id']}/continue", json={
        'actor_agent_id': team['human'], 'minutes': 0})
    assert response.status_code == 201, response.text
    response = await team['client'].post(f"/api/qa/requests/{out['request']['id']}/cancel", json={'actor_agent_id': team['human']})
    assert response.status_code == 200, response.text
    opened = []
    device = FakeDevice([jshot('home', ('Heading', 'Checkout'))])
    with TestClient(main.app) as client:
        qa = QATools(identity=Ident(team['cid'], team['qa']), portal=AppPortal(client, team['cid'], team['qa']),
                     device_opener=opener(device, opened), clock=Clock())
        response = await qa.start_session(platform='ios', kind='check', task_id=out['qa_task_id'], app='com.example.checkout')
        assert response.startswith('error:'), response
        assert qa.live is None and not opened
