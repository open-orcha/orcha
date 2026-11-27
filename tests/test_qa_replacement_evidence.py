"""Interrupted portal runs retain evidence; finite checks can finish before their limit."""

import pytest

from test_qa_run_tasks import team, inline, task, hand, session, finish, qa_of, thread  # noqa: F401


async def queue(team, tid):
    r = await team['client'].post(f"/api/containers/{team['cid']}/qa/sessions/queue", json={
        'actor_agent_id': team['human'], 'kind': 'explore', 'platform': 'web',
        'task_id': tid, 'agent_id': team['qa'], 'budget_minutes': 60})
    assert r.status_code == 201, r.text


async def evidence(team, s):
    r = await team['client'].post(f"/api/qa/sessions/{s['id']}/findings", json={
        'actor_agent_id': team['qa'], 'severity': 'blocker', 'title': 'Checkout crashes before payment'})
    assert r.status_code == 201, r.text
    r = await team['client'].post(f"/api/qa/sessions/{s['id']}/steps", json={
        'actor_agent_id': team['qa'], 'steps': [{'seq': 1, 'kind': 'screen', 'screen_key': 'checkout'}]})
    assert r.status_code == 200, r.text


@pytest.mark.parametrize('status', ['abandoned', 'failed', 'running'])
async def test_portal_replacements_keep_evidence_and_duration(team, db, status):
    tid = await task(team, assignee='QAEngineer')
    await queue(team, tid)
    first = await session(team, task_id=tid)
    await evidence(team, first)
    r = await team['client'].patch(f"/api/qa/sessions/{first['id']}", json={
        'actor_agent_id': team['qa'], 'status': status, 'budget_used_seconds': 1200})
    assert r.status_code == 200, r.text
    second = await session(team, task_id=tid)
    third = await session(team, task_id=tid)
    # Device updates and the final report must preserve the replacement chain.
    for s in [second, third]:
        r = await team['client'].patch(f"/api/qa/sessions/{s['id']}", json={
            'actor_agent_id': team['qa'], 'result': {'steps': 1}})
        assert r.status_code == 200, r.text
    await finish(team, third)
    for n, s in enumerate([first, second, third]):
        db.execute('UPDATE qa_sessions SET started_at=%s, ended_at=%s WHERE id=%s',
                   (f'2026-01-01T00:0{n}:00Z', f'2026-01-01T00:0{n + 1}:00Z', s['id']))
    result = (await qa_of(team, tid))['run_result']
    assert result['outcome'] == 'failed'
    assert [f['title'] for f in result['findings']] == ['Checkout crashes before payment']
    assert set(result['session_ids']) == {first['id'], second['id'], third['id']}
    assert result['screens'] == ['checkout']
    assert result['duration_seconds'] == 180
    post = [p for p in await thread(team, tid) if p.startswith('[Run result]')][-1]
    assert 'found problems' in post and 'Checkout crashes before payment' in post


@pytest.mark.parametrize('boundary', ['done', 'new_queue'])
async def test_new_portal_attempt_excludes_previous_findings(team, boundary):
    tid = await task(team, assignee='QAEngineer')
    await queue(team, tid)
    old = await session(team, task_id=tid)
    await evidence(team, old)
    await finish(team, old, 'done' if boundary == 'done' else 'abandoned')
    if boundary == 'new_queue':
        await queue(team, tid)
    new = await session(team, task_id=tid)
    await finish(team, new)
    result = (await qa_of(team, tid))['run_result']
    assert result['outcome'] == 'passed'
    assert result['session_ids'] == [new['id']]
    assert result['findings'] == [] and result['screens'] == []


async def test_continue_portal_replacement_keeps_the_whole_attempt(team):
    tid = await task(team, assignee='QAEngineer')
    await queue(team, tid)
    first = await session(team, task_id=tid)
    await evidence(team, first)
    await finish(team, first, 'abandoned')
    second = await session(team, task_id=tid)
    r = await team['client'].patch(f"/api/qa/sessions/{second['id']}", json={
        'actor_agent_id': team['qa'], 'status': 'done',
        'result': {'budget': {'minutes': 60, 'used_s': 3601, 'left_s': 0}}})
    assert r.status_code == 200, r.text
    r = await team['client'].post(f"/api/qa/sessions/{second['id']}/continue", json={
        'actor_agent_id': team['human'], 'minutes': 0})
    assert r.status_code == 201, r.text
    third = await session(team, task_id=tid)
    await finish(team, third)
    result = (await qa_of(team, tid))['run_result']
    assert result['outcome'] == 'failed'
    assert set(result['session_ids']) == {first['id'], second['id'], third['id']}
    assert [f['title'] for f in result['findings']] == ['Checkout crashes before payment']


async def test_failed_device_start_does_not_break_evidence_chain(team):
    tid = await task(team, assignee='QAEngineer')
    await queue(team, tid)
    first = await session(team, task_id=tid)
    await evidence(team, first)
    await finish(team, first, 'abandoned')
    second = await session(team, task_id=tid)
    await finish(team, second, 'failed')  # No steps: the device could not start.
    third = await session(team, task_id=tid)
    await finish(team, third)
    result = (await qa_of(team, tid))['run_result']
    assert result['outcome'] == 'failed'
    assert set(result['session_ids']) == {first['id'], third['id']}
    assert [f['title'] for f in result['findings']] == ['Checkout crashes before payment']


async def test_new_portal_run_does_not_use_an_old_request_result(team):
    out = await hand(team, await task(team))
    tid = out['qa_task_id']
    first = await session(team, request_id=out['request']['id'])
    await evidence(team, first)
    await finish(team, first)
    await queue(team, tid)
    new = await session(team, task_id=tid)
    assert not new.get('request_id')
    await finish(team, new)
    result = (await qa_of(team, tid))['run_result']
    assert result['request_id'] is None
    assert result['outcome'] == 'passed'
    assert result['findings'] == [] and result['session_ids'] == [new['id']]


@pytest.mark.parametrize('kind', ['check', 'draft', 'explore'])
@pytest.mark.parametrize('timed_out', [False, True])
async def test_finite_requests_use_maximum_time_without_delaying_completed_checks(team, tmp_path, monkeypatch, kind, timed_out):
    import main
    from fastapi.testclient import TestClient
    from orcha_cli.qa.mcp_server import QATools
    from test_qa_mcp import Clock
    from test_qa_mcp_portal import AppPortal, Ident, FakeDevice, jshot, opener

    monkeypatch.setattr(main, 'ATTACHMENTS_DIR', tmp_path)
    out = await hand(team, await task(team), platform='ios', kind=kind, minutes=60,
                     acceptance=['The total drops'] if kind == 'check' else [])
    device = FakeDevice([jshot('home', ('Heading', 'Checkout'), ('StaticText', 'Total: $9'))])
    clock = Clock()
    with TestClient(main.app) as tc:
        tools = QATools(identity=Ident(team['cid'], team['qa']),
                        portal=AppPortal(tc, team['cid'], team['qa']),
                        device_opener=opener(device, []), clock=clock)
        try:
            started = await tools.start_session(request_id=out['request']['id'], app='com.example.checkout')
            assert started.startswith('session started'), started
            sid = tools.live.id
            if kind == 'check':
                said = await tools.verdict(verdict='pass', acceptance_line=0)
                assert 'acceptance line 0 pass' in said, said
                recorded = tc.get(f"/api/qa/requests/{out['request']['id']}").json()
                assert recorded['line_verdicts'][0]['verdict'] == 'pass'
            clock.t += 3601 if timed_out else 1
            ended = await tools.end_session('Requested work completed.')
            if kind == 'explore' and not timed_out:
                assert ended.startswith('error:') and 'budget is left' in ended
            else:
                assert ended.startswith(f'session {sid} ended'), ended
                saved = tc.get(f'/api/qa/sessions/{sid}').json()
                assert saved['result']['budget']['minutes'] == 60
                assert (saved['result'].get('stop_reason') == 'time_limit') == timed_out
        finally:
            if tools.live:
                await tools.shutdown()
