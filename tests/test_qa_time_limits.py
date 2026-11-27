"""Time choices and continuing preserve evidence through the actual portal routes."""
import pytest
from test_qa_run_tasks import (team, inline, task, hand, session, verdict, finish, qa_of, thread)  # noqa: F401


@pytest.mark.parametrize('minutes', [0, 65, 480, None])
async def test_request_time_reaches_session_even_without_tool_override(team, minutes):
    out = await hand(team, await task(team), minutes=minutes)
    s = await session(team, request_id=out['request']['id'])
    assert s['budget_minutes'] == (20 if minutes is None else minutes)


async def timeout(team):
    out = await hand(team, await task(team), minutes=20)
    s = await session(team, request_id=out['request']['id'])
    await verdict(team, s, 0)
    r = await team['client'].patch(f"/api/qa/sessions/{s['id']}", json={
        'actor_agent_id': team['qa'], 'status': 'done',
        'result': {'budget': {'minutes': 20, 'used_s': 1201, 'left_s': 0}}})
    assert r.status_code == 200, r.text
    return out, s


async def test_time_limit_names_unfinished_lines_everywhere(team):
    out, s = await timeout(team)
    result = (await qa_of(team, out['qa_task_id']))['run_result']
    assert result['stop_reason'] == 'time_limit'
    assert result['outcome'] == 'blocked'
    assert [x['index'] for x in result['unfinished_lines']] == [1]
    assert 'Stopped at the 20-minute time limit.' in result['summary']
    assert 'Line 2: The receipt is emailed' in result['summary']
    post = [x for x in await thread(team, out['qa_task_id']) if x.startswith('[Run result]')][-1]
    assert 'time limit' in post and 'Line 2: The receipt is emailed' in post
    detail = (await team['client'].get(f"/api/qa/sessions/{s['id']}")).json()
    assert 'Line 2: The receipt is emailed' in detail['stop_reason']


@pytest.mark.parametrize('minutes', [45, 0])
async def test_continue_keeps_passes_on_same_request_and_same_task(team, db, minutes):
    out, s = await timeout(team)
    count = db.execute('SELECT count(*) AS n FROM tasks')[0]['n']
    url = f"/api/qa/sessions/{s['id']}/continue"
    body = {'actor_agent_id': team['human'], 'minutes': minutes}
    r = await team['client'].post(url, json=body)
    assert r.status_code == 201, r.text
    queued = r.json()
    assert queued['request_id'] == out['request']['id']
    assert queued['task_id'] == out['qa_task_id']
    assert queued['budget_minutes'] == minutes
    assert (await team['client'].post(url, json=body)).json()['id'] == queued['id']
    assert db.execute('SELECT count(*) AS n FROM tasks')[0]['n'] == count
    new = await session(team, request_id=out['request']['id'])
    assert new['id'] == queued['id'] and new['budget_minutes'] == minutes
    await verdict(team, new, 1)
    await finish(team, new)
    result = (await qa_of(team, out['qa_task_id']))['run_result']
    assert [l['verdict'] for l in result['lines']] == ['pass', 'pass']
    assert result['lines'][0]['session_id'] == s['id']
    assert result['stop_reason'] is None
    assert result['outcome'] == 'passed'


async def test_person_can_choose_time_when_approving_request(team):
    out = await hand(team, await task(team))
    r = await team['client'].put(f"/api/qa/requests/{out['request']['id']}/time-limit", json={
        'actor_agent_id': team['human'], 'minutes': 0})
    assert r.status_code == 200, r.text
    assert r.json()['minutes'] == 0
    s = await session(team, request_id=out['request']['id'])
    assert s['budget_minutes'] == 0
    r = await team['client'].put(f"/api/qa/requests/{out['request']['id']}/time-limit", json={
        'actor_agent_id': team['human'], 'minutes': 60})
    assert r.status_code == 409


async def test_worker_replacement_keeps_clock_and_proven_lines(team):
    out = await hand(team, await task(team), minutes=60)
    first = await session(team, request_id=out['request']['id'])
    await verdict(team, first, 0)
    # The QA tool's shutdown at a worker cap saves the elapsed clock.
    r = await team['client'].patch(f"/api/qa/sessions/{first['id']}", json={
        'actor_agent_id': team['qa'], 'status': 'abandoned',
        'result': {'budget': {'minutes': 60, 'used_s': 1200, 'left_s': 2400}}})
    assert r.status_code == 200, r.text
    second = await session(team, request_id=out['request']['id'])
    assert second['result']['budget_offset_s'] == 1200
    await verdict(team, second, 1)
    await finish(team, second)
    result = (await qa_of(team, out['qa_task_id']))['run_result']
    assert [l['verdict'] for l in result['lines']] == ['pass', 'pass']
    assert result['lines'][0]['session_id'] == first['id']


async def test_continue_a_portal_run_without_a_request(team):
    tid = await task(team, assignee='QAEngineer')
    s = await session(team, task_id=tid, budget_minutes=20)
    r = await team['client'].patch(f"/api/qa/sessions/{s['id']}", json={
        'actor_agent_id': team['qa'], 'status': 'done',
        'result': {'budget': {'minutes': 20, 'used_s': 1201, 'left_s': 0}}})
    assert r.status_code == 200
    r = await team['client'].post(f"/api/qa/sessions/{s['id']}/continue", json={
        'actor_agent_id': team['human'], 'minutes': 0})
    assert r.status_code == 201, r.text
    new = await session(team, task_id=tid)
    assert new['id'] == r.json()['id'] and new['budget_minutes'] == 0
    assert new['request_id']
    await finish(team, new)
    out = (await qa_of(team, tid))['run_result']
    assert set(out['session_ids']) == {s['id'], new['id']}


async def test_hard_worker_stop_keeps_heartbeat_clock_before_sweeper_runs(team, db):
    from orcha_cli.notifier_policy import HARD_CAP_MIN_SECS
    out = await hand(team, await task(team), minutes=60)
    first = await session(team, request_id=out['request']['id'])
    await verdict(team, first, 0)
    r = await team['client'].patch(f"/api/qa/sessions/{first['id']}", json={
        'actor_agent_id': team['qa'], 'budget_used_seconds': HARD_CAP_MIN_SECS})
    assert r.status_code == 200, r.text
    # No shutdown call: a worker killed at its cap leaves the row running.
    second = await session(team, request_id=out['request']['id'])
    assert second['result']['budget_offset_s'] == HARD_CAP_MIN_SECS
    assert db.execute('SELECT status FROM qa_sessions WHERE id=%s', (first['id'],))[0]['status'] == 'abandoned'
    # Another interruption before the first heartbeat must not lose the offset.
    third = await session(team, request_id=out['request']['id'])
    assert third['result']['budget_offset_s'] == HARD_CAP_MIN_SECS
    await verdict(team, third, 1)
    await finish(team, third)
    result = (await qa_of(team, out['qa_task_id']))['run_result']
    assert result['outcome'] == 'passed'
    assert [line['verdict'] for line in result['lines']] == ['pass', 'pass']


@pytest.mark.parametrize('status', ['completed', 'cancelled', 'needs_verification', 'worker_running'])
async def test_time_approval_cannot_change_finished_or_active_work(team, db, status):
    out = await hand(team, await task(team), minutes=20)
    if status == 'worker_running':
        db.execute("INSERT INTO worker_runs (agent_id, task_id, status) VALUES (%s,%s,'running')",
                   (team['qa'], out['qa_task_id']))
    else:
        db.execute('UPDATE tasks SET status=%s WHERE id=%s', (status, out['qa_task_id']))
    r = await team['client'].put(f"/api/qa/requests/{out['request']['id']}/time-limit", json={
        'actor_agent_id': team['human'], 'minutes': 0})
    assert r.status_code == 409, r.text
    assert db.execute('SELECT minutes FROM qa_requests WHERE id=%s', (out['request']['id'],))[0]['minutes'] == 20


@pytest.mark.parametrize('state', ['cancelled', 'replaced', 'worker_running'])
async def test_continue_cannot_restart_cancelled_replaced_or_active_work(team, db, state):
    out, s = await timeout(team)
    if state == 'cancelled':
        db.execute("UPDATE qa_requests SET status='cancelled' WHERE id=%s", (out['request']['id'],))
    elif state == 'replaced':
        replacement = await hand(team, await task(team), qa_task_id=out['qa_task_id'])
        newer = await session(team, request_id=replacement['request']['id'])
        await finish(team, newer)
    else:
        db.execute("INSERT INTO worker_runs (agent_id, task_id, status) VALUES (%s,%s,'running')",
                   (team['qa'], out['qa_task_id']))
    before = db.execute('SELECT count(*) AS n FROM qa_sessions')[0]['n']
    r = await team['client'].post(f"/api/qa/sessions/{s['id']}/continue", json={
        'actor_agent_id': team['human'], 'minutes': 45})
    assert r.status_code == 409, r.text
    assert db.execute('SELECT count(*) AS n FROM qa_sessions')[0]['n'] == before
