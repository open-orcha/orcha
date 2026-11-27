"""Replacement requests must not combine one attempt's evidence with another's session."""
from test_qa_run_tasks import (team, inline, task, hand, session, verdict, finish, qa_of, thread, result_of)  # noqa: F401


async def test_replacement_request_owns_the_card_thread_and_duration(team, db):
    source = await task(team)
    first = await hand(team, source)
    tid = first['qa_task_id']
    old = await session(team, request_id=first['request']['id'])
    await verdict(team, old, 0, 'blocked')
    await verdict(team, old, 1, 'blocked')
    finding = await team['client'].post(f"/api/qa/sessions/{old['id']}/findings", json={
        'actor_agent_id': team['qa'], 'severity': 'blocker', 'title': 'Old blank page'})
    assert finding.status_code == 201, finding.text
    await finish(team, old)
    second = await hand(team, source)
    # Reproduce the reported unassigned duplicate, rather than repair any live record.
    db.execute('DELETE FROM agent_tasks WHERE task_id=%s', (second['qa_task_id'],))
    db.execute("UPDATE tasks SET status='ready', started_at=NULL WHERE id=%s", (second['qa_task_id'],))
    new = await session(team, task_id=tid, request_id=second['request']['id'])
    await verdict(team, new, 0)
    await verdict(team, new, 1)
    db.execute("UPDATE qa_sessions SET started_at='2026-11-26T03:45:00+00:00' WHERE id=%s", (new['id'],))
    db.execute("UPDATE qa_sessions SET started_at='2026-11-26T01:17:00+00:00', ended_at='2026-11-26T01:20:00+00:00' WHERE id=%s", (old['id'],))
    await finish(team, new)
    db.execute("UPDATE qa_sessions SET ended_at='2026-11-26T04:05:00+00:00' WHERE id=%s", (new['id'],))
    from portal_backend import qa_run_tasks
    from portal_backend.database import db_cursor
    with db_cursor() as (conn, cur):
        # Re-record with deterministic time; allow a new thread entry for this assertion.
        cur.execute('UPDATE qa_runs SET result_session_id=NULL WHERE task_id=%s', (tid,))
        qa_run_tasks.record(cur, tid)
        conn.commit()
    out = (await qa_of(team, tid))['run_result']
    assert out['request_id'] == second['request']['id']
    assert out['session_ids'] == [new['id']]
    assert [r['verdict'] for r in out['lines']] == ['pass', 'pass']
    assert out['findings'] == []
    assert out['duration_seconds'] == 1200
    assert result_of(db, tid)['qa_run']['request_id'] == second['request']['id']
    post = [x for x in await thread(team, tid) if x.startswith('[Run result]')][-1]
    assert '2 of 2 lines proven' in post and '20.0 min' in post and 'Old blank page' not in post
    assert db.execute('SELECT qa_task_id FROM qa_requests WHERE id=%s', (second['request']['id'],))[0]['qa_task_id'] == tid
    assert db.execute('SELECT status FROM tasks WHERE id=%s', (second['qa_task_id'],))[0]['status'] == 'cancelled'


async def test_replacement_can_reuse_the_task_without_creating_a_duplicate(team, db):
    source = await task(team)
    first = await hand(team, source)
    old = await session(team, request_id=first['request']['id'])
    await verdict(team, old, 0, 'blocked')
    await finish(team, old)
    before = db.execute('SELECT count(*) AS n FROM tasks')[0]['n']
    second = await hand(team, source, qa_task_id=first['qa_task_id'])
    assert second['qa_task_id'] == first['qa_task_id']
    assert db.execute('SELECT count(*) AS n FROM tasks')[0]['n'] == before
    new = await session(team, request_id=second['request']['id'])
    assert new['task_id'] == first['qa_task_id']


async def test_replacement_never_takes_an_assigned_duplicate_task(team, db):
    source = await task(team)
    first = await hand(team, source)
    old = await session(team, request_id=first['request']['id'])
    await finish(team, old)
    second = await hand(team, source)
    before = db.execute('SELECT status FROM tasks WHERE id=%s', (second['qa_task_id'],))[0]['status']
    response = await team['client'].post(f"/api/containers/{team['cid']}/qa/sessions", json={
        'actor_agent_id': team['qa'], 'kind': 'explore', 'platform': 'web',
        'task_id': first['qa_task_id'], 'request_id': second['request']['id']})
    assert response.status_code == 409
    assert db.execute('SELECT status FROM tasks WHERE id=%s', (second['qa_task_id'],))[0]['status'] == before


async def test_historical_mismatched_request_link_does_not_select_old_verdicts(team, db):
    source = await task(team)
    first = await hand(team, source)
    old = await session(team, request_id=first['request']['id'])
    await verdict(team, old, 0, 'blocked')
    await finish(team, old)
    second = await hand(team, source)
    new = await session(team, request_id=second['request']['id'])
    await verdict(team, new, 0)
    await verdict(team, new, 1)
    await finish(team, new)
    # Stored data from before the fix: the session points to the original task,
    # but the replacement request still points to its own duplicate task.
    db.execute('UPDATE qa_sessions SET task_id=%s WHERE id=%s', (first['qa_task_id'], new['id']))
    out = (await qa_of(team, first['qa_task_id']))['run_result']
    assert out['request_id'] == second['request']['id']
    assert [line['verdict'] for line in out['lines']] == ['pass', 'pass']
    assert out['session_ids'] == [new['id']]
    assert db.execute('SELECT qa_task_id FROM qa_requests WHERE id=%s', (second['request']['id'],))[0]['qa_task_id'] == second['qa_task_id']
