"""Cancelled history cannot capture or consume a different live request."""
import pytest
from portal_backend.database import db_cursor
from portal_backend.events import publish_event
from portal_backend.stale_wake_events import reconcile_events
from test_workflow_local_launch import Project, _bob_candidate, local_lane


async def ask(client, p, title='Review current work'):
    r = await client.post(f'/api/containers/{p.cid}/requests', json={
        'requester_agent_id': p.ann, 'target_alias': 'Bob', 'payload': title,
        'type': 'task', 'expires_minutes': 60,
        'task': {'title': title, 'definition_of_done': 'Independent review'}})
    assert r.status_code == 201, r.text
    return r.json()['request_id']


def pending(p):
    with db_cursor() as (_, cur):
        cur.execute('SELECT id,event_name,payload FROM agent_events WHERE event_key=%s ORDER BY id', (p.bob,))
        return cur.fetchall()


async def cancel(p):
    d = await p.detail(p.wid)
    await p.call('POST', f'/api/workflows/{p.wid}/cancel', p.mutation(d))


async def test_cancelled_backlog_never_hides_live_request_or_human_nudge(client):
    p = Project(client)
    await p.start('serial', [('old', p.bob, [])])
    tid = p.tasks['old']
    for n in range(110):
        await p.call('POST', f'/api/tasks/{tid}/messages', {'author_agent_id': p.owner, 'body': f'Old {n} ' + 'x'*300}, 201)
    await cancel(p)
    rid = await ask(client, p)
    with db_cursor() as (_, cur):
        publish_event(cur, p.cid, p.bob, 'prompt', {'message': 'Human asks to handle the live review', 'request_id': rid})
        # A late producer can still race with cancellation; scan must check current state.
        publish_event(cur, p.cid, p.bob, 'task_message', {'task_id': tid, 'preview': 'Late old transport'})
    c = await _bob_candidate(client, p)
    assert c['should_wake'] and c['has_pending_task_request']
    assert c['context_task_id'] is None and c['wake_task_id'] is None
    assert 'workflow_id' not in c and c['auto_start_task_ids'] == []
    assert any((n.get('deeplink') or {}).get('id') == rid for n in c['notifications'])
    assert any('Human asks' in m for m in c['prompt_messages'])
    assert all('Old ' not in m and 'Late old' not in m for m in c['prompt_messages'])
    assert (await p.reserve(p.bob, 'old', expect=409))['detail']['code'] == 'not_eligible'


@pytest.mark.parametrize('state', ['closed', 'answered', 'escalated'])
async def test_reconciliation_rechecks_requests_and_preserves_live_nudges(client, state):
    p = Project(client)
    await p.start('serial', [('old', p.bob, [])])
    stale = await ask(client, p, 'Old review')
    live = await ask(client, p)
    with db_cursor() as (_, cur):
        if state == 'escalated':
            cur.execute('UPDATE requests SET target_id=%s WHERE id=%s', (p.owner, stale))
        else:
            cur.execute('UPDATE requests SET status=%s WHERE id=%s', (state, stale))
        publish_event(cur, p.cid, p.bob, 'prompt', {'message': 'Human nudge', 'request_id': stale})
    ids = [e['id'] for e in pending(p)]
    url = f'/api/agents/{p.bob}/events/reconcile-stale'
    preview = await client.post(url, json={'event_ids': ids})
    assert preview.status_code == 200
    ob = preview.json()['obsolete']
    assert len(ob) == 1 and ob[0]['reason'] == 'request_no_longer_owed'
    with db_cursor() as (_, cur):
        cur.execute('SELECT count(*) AS n FROM agent_event_acks WHERE agent_id=%s', (p.bob,))
        before = cur.fetchone()['n']
        # Recovery must recheck even if a human changed ownership after the preview.
        cur.execute("UPDATE requests SET status='open',target_id=%s WHERE id=%s", (p.bob, stale))
    applied = await client.post(url, json={'event_ids': ids, 'dry_run': False})
    assert applied.json()['obsolete'] == []
    with db_cursor() as (_, cur):
        cur.execute('SELECT count(*) AS n FROM agent_event_acks WHERE agent_id=%s', (p.bob,))
        assert cur.fetchone()['n'] == before
    assert (await client.post(url, json={'event_ids': list(range(201))})).status_code == 422


async def test_selective_ack_is_audited_idempotent_and_does_not_move_cursor(client):
    p = Project(client)
    await p.start('serial', [('old', p.bob, [])])
    await cancel(p)
    live = await ask(client, p)
    with db_cursor() as (_, cur):
        publish_event(cur, p.cid, p.bob, 'task_message', {'task_id': p.tasks['old']})
        publish_event(cur, p.cid, p.bob, 'prompt', {'message': 'Human nudge', 'request_id': live})
        cur.execute('SELECT delivered_ts FROM agent_wake_state WHERE agent_id=%s', (p.bob,))
        before = cur.fetchone()
    ids = [r['id'] for r in pending(p)]
    with db_cursor() as (_, cur):
        r = reconcile_events(cur, p.bob, p.cid, ids, dry_run=False)
        assert any(x['reason'] == 'terminal_task' for x in r['obsolete'])
        assert reconcile_events(cur, p.bob, p.cid, ids, dry_run=False)['obsolete'] == []
        cur.execute('SELECT delivered_ts FROM agent_wake_state WHERE agent_id=%s', (p.bob,))
        assert cur.fetchone() == before
        cur.execute("SELECT detail FROM events WHERE entity_id=%s AND event_type='stale_events_reconciled'", (p.bob,))
        assert len(cur.fetchall()) == 1
    assert (await _bob_candidate(client, p))['has_pending_task_request']


async def test_refusal_restart_and_historical_assignees_generate_no_wakes(client):
    p = Project(client)
    await p.start('serial', [('old', p.bob, [])])
    tid = p.tasks['old']
    with db_cursor() as (_, cur):
        cur.execute("INSERT INTO agent_tasks(agent_id,task_id,assignment_status) VALUES (%s,%s,'done')", (p.ann, tid))
    body = {'body': 'Orcha could not start this task automatically: on hold.', 'system_notice': True}
    first = await client.post(f'/api/tasks/{tid}/messages', json=body)
    second = await client.post(f'/api/tasks/{tid}/messages', json=body)
    assert second.json()['message_id'] == first.json()['message_id']
    with db_cursor() as (_, cur):
        cur.execute("SELECT count(*) AS n FROM agent_events WHERE event_key IN (%s,%s) AND event_name='task_message'", (p.bob, p.ann))
        assert cur.fetchone()['n'] == 0
    await p.call('POST', f'/api/tasks/{tid}/messages', {'author_agent_id': p.owner, 'body': 'Live collaboration'}, 201)
    with db_cursor() as (_, cur):
        cur.execute("SELECT count(*) AS n FROM agent_events WHERE event_key=%s AND event_name='task_message'", (p.ann,))
        assert cur.fetchone()['n'] == 0
    await cancel(p)
    terminal = await client.post(f'/api/tasks/{tid}/messages', json=body)
    assert terminal.json()['suppressed'] is True
    await p.call('POST', f'/api/tasks/{tid}/messages', {'author_agent_id': p.owner, 'body': 'Informative history'}, 201)
    c = await _bob_candidate(client, p)
    assert c['context_task_id'] is None


async def test_linked_answer_on_terminal_task_is_taskless_information(client):
    p = Project(client)
    await p.start('serial', [('old', p.bob, [])])
    await cancel(p)
    with db_cursor() as (_, cur):
        publish_event(cur, p.cid, p.bob, 'request_answered', {'originating_task_id': p.tasks['old'], 'response': 'Historical answer'})
    c = await _bob_candidate(client, p)
    assert c['context_task_id'] is None and c['wake_task_id'] is None and 'workflow_id' not in c
    assert c['should_wake']


async def test_cancel_between_scan_and_reservation_still_refuses_without_restarting(client):
    p = Project(client)
    await p.start('serial', [('old', p.bob, [])])
    c = await _bob_candidate(client, p)
    assert c['context_task_id'] == p.tasks['old']
    await cancel(p)
    r = await client.post(f'/api/agents/{p.bob}/runs/reserve', json={
        'task_id': c['context_task_id'], 'expected_workflow_revision': c['workflow_revision'],
        'expected_work_revision': c['workflow_work_revision'], 'operation_key': 'race'})
    assert r.status_code == 409
    with db_cursor() as (_, cur):
        cur.execute('SELECT count(*) AS n FROM worker_runs WHERE task_id=%s', (p.tasks['old'],))
        assert cur.fetchone()['n'] == 0


async def test_verification_feedback_remains_visible_after_task_completion(client):
    p=Project(client)
    await p.start('serial',[('old',p.bob,[])])
    await cancel(p)
    with db_cursor() as (_,cur):
        publish_event(cur,p.cid,p.bob,'task_verified',{'task_id':p.tasks['old'],'approved':True,'feedback':'Human follow-up note must stay visible'})
    rows=pending(p)
    with db_cursor() as (_,cur):
        result=reconcile_events(cur,p.bob,p.cid,[r['id'] for r in rows],dry_run=False)
    ids={r['event_id'] for r in result['obsolete']}
    assert all(r['id'] not in ids for r in rows if r['event_name']=='task_verified')
    c=await _bob_candidate(client,p)
    assert c['should_wake'] and c['context_task_id'] is None
    assert any('Human follow-up' in (n.get('preview') or '') for n in c['notifications'])


async def test_legacy_submitted_worker_receives_human_feedback_but_replaced_workers_do_not(client, work_headers):
    from uuid import uuid4
    p = Project(client)
    tid = str(uuid4())
    with db_cursor() as (_, cur):
        cur.execute("INSERT INTO tasks(id,container_id,title,definition_of_done,status) VALUES (%s,%s,'Legacy task','Human verifies','in_progress')", (tid,p.cid))
        cur.execute("INSERT INTO agent_tasks(agent_id,task_id,assignment_status) VALUES (%s,%s,'working'),(%s,%s,'done')", (p.bob,tid,p.ann,tid))
    result = await client.post(f'/api/tasks/{tid}/done', json={'agent_id':p.bob,'result':'Submitted for verification'}, headers=await work_headers(p.bob))
    assert result.status_code == 200, result.text
    await p.call('POST',f'/api/tasks/{tid}/messages',{'author_agent_id':p.owner,'body':'Please fix the remaining issue'},201)
    with db_cursor() as (_,cur):
        cur.execute("SELECT event_key FROM agent_events WHERE event_name='task_message' AND event_key IN (%s,%s) AND payload->>'task_id'=%s", (p.ann,p.bob,tid))
        assert [str(r['event_key']) for r in cur.fetchall()] == [p.bob]
    candidate = await _bob_candidate(client,p)
    assert candidate['should_wake']
    assert any('Please fix' in m for m in candidate['prompt_messages'])


async def test_daemon_reconciles_bounded_obsolete_rows_and_restart_preserves_live_work(client):
    p = Project(client)
    await p.start('serial',[('old',p.bob,[])])
    await cancel(p)
    live = await ask(client,p)
    with db_cursor() as (_,cur):
        for n in range(230):
            publish_event(cur,p.cid,p.bob,'task_message',{'task_id':p.tasks['old'],'preview':str(n)})
        publish_event(cur,p.cid,p.bob,'prompt',{'message':'Keep this human nudge','request_id':live})
    rows = pending(p)
    stale = {r['id'] for r in rows if r['event_name']=='task_message'}
    for iteration in range(2):
        candidate = await _bob_candidate(client,p)
        assert candidate['has_pending_task_request'] and candidate['context_task_id'] is None
        assert any('Keep this' in m for m in candidate['prompt_messages'])
        with db_cursor() as (_,cur):
            cur.execute('SELECT event_id FROM agent_event_acks WHERE agent_id=%s',(p.bob,))
            acked = {r['event_id'] for r in cur.fetchall()}
            assert not any(r['id'] in acked for r in rows if r['event_name'] in {'prompt','request_created'})
            assert len(stale & acked) >= (199 if iteration==0 else 230)
    with db_cursor() as (_,cur):
        cur.execute("SELECT detail FROM events WHERE entity_id=%s AND event_type='stale_events_reconciled'",(p.bob,))
        audits = cur.fetchall()
        assert len(audits)==2 and all(len(a['detail']['obsolete'])<=200 for a in audits)


async def test_refusal_status_recurrence_is_visible_without_regenerating_wakes(client):
    p = Project(client)
    await p.start('serial',[('old',p.bob,[])])
    mids = []
    for status in ['On hold', 'Waiting for another turn', 'On hold', 'On hold']:
        response = await client.post(f"/api/tasks/{p.tasks['old']}/messages",json={
            'body':status,'system_notice':True})
        assert response.status_code == 201
        mids.append(response.json()['message_id'])
    assert len(set(mids[:3]))==3 and mids[2]==mids[3]
    assert not any(r['event_name']=='task_message' for r in pending(p))


async def test_auto_reconcile_does_not_skip_an_active_parked_message(client):
    p = Project(client)
    await p.start('serial',[('first',p.ann,[]),('waiting',p.bob,['first'])])
    stale = await ask(client,p,'Old request')
    live = await ask(client,p,'Live request')
    with db_cursor() as (_,cur):
        cur.execute("UPDATE requests SET status='closed' WHERE id=%s",(stale,))
        publish_event(cur,p.cid,p.bob,'task_message',{'task_id':p.tasks['waiting'],'preview':'Park this until eligible'})
    rows=pending(p)
    candidate=await _bob_candidate(client,p)
    assert candidate['has_pending_task_request'] and candidate['context_task_id'] is None
    with db_cursor() as (_,cur):
        cur.execute('SELECT event_id FROM agent_event_acks WHERE agent_id=%s',(p.bob,))
        acked={r['event_id'] for r in cur.fetchall()}
        for r in rows:
            if r['event_name']=='request_created':
                assert (r['id'] in acked) == (r['payload']['request_id']==stale)
            if r['event_name']=='task_message':
                assert r['id'] not in acked


async def test_idle_daemon_scan_and_empty_recovery_never_take_the_graph_lock(client, monkeypatch):
    from portal_backend import workflow_service
    p = Project(client)
    def unexpected_lock(*args, **kwargs):
        pytest.fail('An idle scan or empty reconciliation must not take the graph lock')
    # Observe the actual lock seam, not just whether a durable row happens to exist.
    monkeypatch.setattr(workflow_service, 'lock_container_graph', unexpected_lock)
    await _bob_candidate(client,p)
    with db_cursor() as (_,cur):
        assert reconcile_events(cur,p.bob,p.cid,[],dry_run=False)['obsolete']==[]
        cur.execute('SELECT 1 FROM container_task_graph_guard WHERE container_id=%s',(p.cid,))
        assert cur.fetchone() is None
