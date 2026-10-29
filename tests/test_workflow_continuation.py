"""GH #380: real stop -> durable signal -> notifier reservation -> review routes."""
import json

import pytest
from portal_backend import sql
from portal_backend.database import db_cursor
from test_workflow_local_launch import Project, local_lane, ann_candidate, notifier_launch
from test_workflow_review_handoff import launch, stopped, handoff, verdict, evidence_dir


def row(p):
    with db_cursor() as (_, cur):
        cur.execute('SELECT * FROM agent_self_wake WHERE agent_id=%s', (p.ann,))
        return cur.fetchone()


def due(p):
    with db_cursor() as (_, cur):
        cur.execute('UPDATE agent_self_wake SET resume_at=%s WHERE agent_id=%s', (sql.ago(1), p.ann))


async def ack(p, aid=None):
    aid = aid or p.ann
    scan = await p.client.get(f'/api/containers/{p.cid}/wake-scan', params={'cooldown': 0, 'min_idle': 0})
    c = next(c for c in scan.json()['candidates'] if c['agent_id'] == aid)
    res = await p.client.post(f'/api/agents/{aid}/events/ack-handled', json={'event_ids': c['handled_event_ids']})
    assert res.status_code == 200, res.text


async def finish(p, r, aid=None, status='exited', exit_code=0, **extra):
    aid = aid or p.ann
    res = await p.client.post(f"/api/runs/{r['run_id']}/finish", json={
        'status': status, 'exit_code': exit_code, 'output': 'Approved work remains.', **extra})
    assert res.status_code == 200, res.text
    await stopped(p, aid, r)
    await ack(p, aid)


async def setup(client, approve=True):
    p = Project(client)
    await p.start('serial', [('design', p.ann, []), ('review', p.bob, [])])
    return p, await launch(p, p.ann, 'design', approve=approve)


async def resume(p, r, monkeypatch):
    due(p)
    c = await ann_candidate(p, p.client)
    assert c['should_wake'] and c['pending_events'] == 0, c
    assert c['auto_continue_run_id'] == r['run_id']
    assert c['automatic_schedule_id'] == str(row(p)['id'])
    res = await notifier_launch(p.client, c, monkeypatch)
    assert res.status_code == 201, res.text
    next_run = res.json()
    assert next_run['generation'] == r['generation'] + 1
    assert row(p) is None
    token = await p.activate(p.ann, next_run)
    next_run['token'] = token['run_token']
    return next_run


@pytest.mark.parametrize('runtime', ['claude', 'codex'])
async def test_no_nudge_continues_through_review_correction_and_human_verification(client, monkeypatch, runtime):
    p, r = await setup(client)
    with db_cursor() as (_, cur):
        cur.execute('UPDATE worker_runs SET runtime=%s WHERE run_id=%s', (runtime, r['run_id']))
    await finish(p, r)
    scheduled = row(p)
    assert str(scheduled['auto_continue_run_id']) == r['run_id']
    assert not (await ann_candidate(p, client))['should_wake']
    await stopped(p, p.ann, r)
    assert row(p) == scheduled  # retries do not postpone the durable wake
    nxt = await resume(p, r, monkeypatch)
    h = await handoff(p, nxt)
    await finish(p, nxt)
    assert row(p) is None
    reviewer = await launch(p, p.bob, 'review')
    # The working reviewer may checkpoint despite the active handoff.
    await finish(p, reviewer, p.bob)
    with db_cursor() as (_, cur):
        cur.execute('SELECT * FROM agent_self_wake WHERE agent_id=%s', (p.bob,))
        review_wait = cur.fetchone()
        assert review_wait
        cur.execute('UPDATE agent_self_wake SET resume_at=%s WHERE agent_id=%s', (sql.ago(1), p.bob))
    res = await client.post(f"/api/agents/{p.bob}/runs/{reviewer['run_id']}/continue-reserve", json={
        'operation_key': f"auto-continue:{reviewer['run_id']}", 'automatic_schedule_id': str(review_wait['id'])})
    assert res.status_code == 201, res.text
    reviewer = res.json()
    reviewer['token'] = (await p.activate(p.bob, reviewer))['run_token']
    await verdict(p, reviewer, h, 'changes_requested')
    await finish(p, reviewer, p.bob)
    correction = await launch(p, p.ann, 'design')
    await finish(p, correction)
    correction = await resume(p, correction, monkeypatch)
    h = await handoff(p, correction, 'Corrected work')
    await finish(p, correction)
    reviewer = await launch(p, p.bob, 'review')
    await verdict(p, reviewer, h, 'clean')
    await finish(p, reviewer, p.bob)
    detail = await p.detail(p.wid)
    assert all(t['status'] == 'needs_verification' for t in detail['tasks'])
    assert not (await ann_candidate(p, client))['self_wake_due']
    # Human acceptance stays authoritative after automatic continuation.
    from portal_backend.workflow_evidence_service import evidence_reference
    for key in ('design', 'review'):
        d = await p.detail(p.wid)
        t = next(t for t in d['tasks'] if t['id'] == p.tasks[key])
        with db_cursor() as (_, cur):
            cur.execute('SELECT current_evidence_set_id FROM workflow_executions WHERE task_id=%s ORDER BY created_at DESC LIMIT 1', (t['id'],))
            ref = evidence_reference(cur, cur.fetchone()['current_evidence_set_id'])
        ref = {'evidence_set_id': ref['evidence_set_id'], 'items': [{k: i[k] for k in ('item_id','deliverable_id','deliverable_version','sha256')} for i in ref['items']]}
        await p.call('POST', f"/api/tasks/{t['id']}/accept", p.mutation(d, expected_work_revision=t['work_revision'], evidence=ref))


async def test_three_automatic_attempts_then_one_visible_request(client, monkeypatch):
    p, r = await setup(client)
    for _ in range(3):
        await finish(p, r)
        r = await resume(p, r, monkeypatch)
    await finish(p, r)
    await stopped(p, p.ann, r)
    assert row(p) is None
    with db_cursor() as (_, cur):
        cur.execute("SELECT * FROM requests WHERE requester_id=%s AND status='open'", (p.ann,))
        requests = cur.fetchall()
        assert len(requests) == 1 and str(requests[0]['originating_task_id']) == p.tasks['design']
        assert str(requests[0]['target_id']) == p.owner
        assert 'automatic continuation limit' in requests[0]['payload']
        cur.execute("SELECT count(*) AS n FROM events WHERE event_type='automatic_continuation_limit'")
        assert cur.fetchone()['n'] == 1
        cur.execute("SELECT count(*) AS n FROM task_messages WHERE author_id IS NULL AND task_id=%s", (p.tasks['design'],))
        assert cur.fetchone()['n'] == 1
    assert not (await ann_candidate(p, client))['should_wake']


async def test_ordinary_event_consumes_old_automatic_row_and_resets_count(client, monkeypatch):
    p, r = await setup(client)
    await finish(p, r)
    r = await resume(p, r, monkeypatch)
    await finish(p, r)
    old = row(p)
    due(p)
    await p.call('POST', f"/api/tasks/{p.tasks['design']}/messages", {'author_agent_id': p.owner, 'body': 'Continue.'}, 201)
    c = await ann_candidate(p, client)
    assert not c.get('automatic_schedule_id')
    res = await notifier_launch(client, c, monkeypatch)
    assert res.status_code == 201, res.text
    r = res.json()
    await p.activate(p.ann, r)
    assert row(p) is None
    await finish(p, r)
    assert str(row(p)['id']) != str(old['id'])
    assert str(row(p)['auto_continue_run_id']) == r['run_id']
    from portal_backend.workflow_continuation import automatic_attempts
    with db_cursor() as (_, cur):
        assert automatic_attempts(cur, {'id': r['execution_id']}) == 0
    await resume(p, r, monkeypatch)


async def test_manual_wait_replacement_and_delayed_ack_are_safe(client, monkeypatch):
    p, r = await setup(client)
    await finish(p, r)
    old = row(p)
    due(p)
    c = await ann_candidate(p, client)
    res = await notifier_launch(client, c, monkeypatch)
    nxt = res.json()
    token = (await p.activate(p.ann, nxt))['run_token']
    async def schedule():
        res = await client.post(f'/api/agents/{p.ann}/self-wake', headers={'X-Orcha-Run-Token': token}, json={
            'task_id': p.tasks['design'], 'delay_secs': 300, 'context': 'Wait for a remote check.'})
        assert res.status_code == 200, res.text
        return res.json()
    first = await schedule()
    second = await schedule()
    assert first['self_wake_id'] != second['self_wake_id']
    # Lost reservation reply replays without consuming the new wait.
    replay = await notifier_launch(client, c, monkeypatch)
    assert replay.status_code == 201 and replay.json()['run_id'] == nxt['run_id']
    for identity in (str(old['id']), first['self_wake_id']):
        acked = await client.post(f'/api/agents/{p.ann}/wake-ack', json={
            'kind': 'ephemeral', 'clear_self_wake': True, 'self_wake_task_id': p.tasks['design'], 'self_wake_id': identity})
        assert not acked.json()['cleared_self_wake']
    await finish(p, nxt)
    assert str(row(p)['id']) == second['self_wake_id']
    assert row(p)['auto_continue_run_id'] is None


@pytest.mark.parametrize('status,code,cause,expected', [
    ('exited', 0, None, True), ('exited', 1, None, False), ('failed', 0, None, False),
    ('rate_limited', 0, None, False), ('killed', -9, 'hard_cap', False),
    ('killed', -9, 'human_stop', False), ('killed', -9, 'stalled', False),
    ('killed', -9, 'host_process_missing_after_notifier_restart', True),
])
async def test_only_clean_or_confirmed_restart_outcomes_schedule(client, status, code, cause, expected):
    p, r = await setup(client)
    res = await client.post(f"/api/runs/{r['run_id']}/finish", json={
        'status': status, 'exit_code': code, 'output': 'remaining work', 'kill_reason': json.dumps({'cause': cause})})
    assert res.status_code == 200
    assert row(p) is None  # no positive stop observation yet
    await stopped(p, p.ann, r)
    assert bool(row(p)) == expected


@pytest.mark.parametrize('gate', ['plan', 'paused', 'task_done', 'cancelled', 'owner', 'loop', 'revision', 'assignment', 'stop', 'sandbox', 'request', 'current_unscoped'])
@pytest.mark.parametrize('when', ['schedule', 'reserve'])
async def test_gates_checked_at_stop_selection_and_reservation(client, gate, when):
    p, r = await setup(client, approve=not (gate == 'plan' and when == 'schedule'))
    if when == 'reserve':
        await finish(p, r)
        due(p)
        candidate = row(p)
    with db_cursor() as (_, cur):
        if gate == 'plan':
            cur.execute("UPDATE decisions SET decision='reject',reason='Changed plan' WHERE subject_id=%s", (p.tasks['design'],))
        elif gate == 'paused':
            cur.execute("UPDATE workflows SET status='paused' WHERE id=%s", (p.wid,))
        elif gate in ('task_done', 'cancelled'):
            cur.execute('UPDATE tasks SET status=%s WHERE id=%s', ('needs_verification' if gate == 'task_done' else 'cancelled', p.tasks['design']))
        elif gate in ('owner', 'loop'):
            col = 'awaiting_owner_decision' if gate == 'owner' else 'awaiting_loop_decision'
            cur.execute(f'UPDATE tasks SET {col}=%s WHERE id=%s', ('stopped_by_owner' if gate == 'owner' else 'ask_owner', p.tasks['design']))
        elif gate == 'revision':
            cur.execute('UPDATE tasks SET work_revision=work_revision+1 WHERE id=%s', (p.tasks['design'],))
        elif gate == 'assignment':
            cur.execute("UPDATE agent_tasks SET assignment_status='done' WHERE task_id=%s", (p.tasks['design'],))
        elif gate == 'stop':
            cur.execute('UPDATE workflow_executions SET first_stop_at=%s WHERE id=%s', (sql.utcnow(), r['execution_id']))
        elif gate == 'sandbox':
            cur.execute("UPDATE worker_runs SET sandbox_container_id='remote' WHERE run_id=%s", (r['run_id'],))
        elif gate in ('request', 'current_unscoped'):
            cur.execute("""INSERT INTO requests(container_id,type,requester_id,target_id,payload,expires_at,originating_task_id)
                VALUES (%s,'info',%s,%s,'Waiting on input',%s,%s)""", (p.cid,p.ann,p.owner,sql.from_now(3600),p.tasks['design'] if gate == 'request' else None))
    if when == 'schedule':
        await finish(p, r)
        assert row(p) is None
    else:
        assert not (await ann_candidate(p, client))['self_wake_due']
        res = await client.post(f"/api/agents/{p.ann}/runs/{r['run_id']}/continue-reserve", json={
            'operation_key': f"auto-continue:{r['run_id']}", 'automatic_schedule_id': str(candidate['id'])})
        assert res.status_code == 409, res.text
        assert row(p) is None


async def test_legacy_ack_cannot_delete_automatic_schedule_and_cancel_can(client):
    p, r = await setup(client)
    await finish(p, r)
    res = await client.post(f'/api/agents/{p.ann}/wake-ack', json={
        'kind': 'ephemeral', 'clear_self_wake': True, 'self_wake_task_id': p.tasks['design']})
    assert not res.json()['cleared_self_wake'] and row(p)
    # A new live task worker can cancel obsolete schedules using the existing endpoint.
    res = await client.post(f"/api/agents/{p.ann}/runs/{r['run_id']}/continue-reserve", json={'operation_key': 'event'})
    nxt = res.json()
    token = (await p.activate(p.ann, nxt))['run_token']
    with db_cursor() as (_, cur):
        cur.execute('INSERT INTO agent_self_wake(agent_id,task_id,resume_at,context,auto_continue_run_id) VALUES (%s,%s,%s,%s,%s)',
                    (p.ann,p.tasks['design'],sql.from_now(120),'obsolete',r['run_id']))
    res = await client.delete(f'/api/agents/{p.ann}/self-wake', params={'task_id': p.tasks['design']}, headers={'X-Orcha-Run-Token': token})
    assert res.status_code == 200 and row(p) is None


async def test_openapi_exposes_optional_schedule_identity(client):
    spec = (await client.get('/openapi.json')).json()['components']['schemas']
    for model, field in [('WorkflowContinue','automatic_schedule_id'),('WakeAck','self_wake_id')]:
        assert field in spec[model]['properties'] and field not in spec[model].get('required', [])


async def test_old_unscoped_request_does_not_disable_current_work(client, monkeypatch):
    p, r = await setup(client)
    with db_cursor() as (_, cur):
        cur.execute("""INSERT INTO requests(container_id,type,requester_id,target_id,payload,expires_at,created_at)
            VALUES (%s,'info',%s,%s,'Old unrelated question',%s,%s)""", (p.cid,p.ann,p.owner,sql.from_now(3600),sql.ago(3600)))
    await finish(p, r)
    await resume(p, r, monkeypatch)


async def test_stale_source_replaced_and_stale_candidate_never_falls_back(client, monkeypatch):
    p, r = await setup(client)
    await finish(p, r)
    due(p)
    stale = await ann_candidate(p, client)
    old = row(p)
    res = await client.post(f"/api/agents/{p.ann}/runs/{r['run_id']}/continue-reserve", json={'operation_key': 'event'})
    nxt = res.json()
    await p.activate(p.ann, nxt)
    # Simulate a retained old schedule from an older notifier/server boundary.
    with db_cursor() as (_, cur):
        cur.execute('INSERT INTO agent_self_wake(id,agent_id,task_id,resume_at,context,auto_continue_run_id) VALUES (%s,%s,%s,%s,%s,%s)',
                    (old['id'],p.ann,p.tasks['design'],sql.ago(1),'old',r['run_id']))
    res = await notifier_launch(client, stale, monkeypatch)
    assert res.status_code == 409 and row(p) is None
    with db_cursor() as (_, cur):
        cur.execute('INSERT INTO agent_self_wake(id,agent_id,task_id,resume_at,context,auto_continue_run_id) VALUES (%s,%s,%s,%s,%s,%s)',
                    (old['id'],p.ann,p.tasks['design'],sql.ago(1),'old',r['run_id']))
    await finish(p, nxt)
    assert str(row(p)['id']) != str(old['id'])
    assert str(row(p)['auto_continue_run_id']) == nxt['run_id']


async def test_manual_wait_survives_running_worker_and_is_suppressed_when_handed_off(client):
    p, r = await setup(client)
    res = await client.post(f'/api/agents/{p.ann}/self-wake', headers={'X-Orcha-Run-Token': r['token']}, json={
        'task_id': p.tasks['design'], 'delay_secs': 300, 'context': 'Wait for a remote check.'})
    assert res.status_code == 200
    due(p)
    assert not (await ann_candidate(p, client))['self_wake_due']
    assert row(p)
    await handoff(p, r)
    await finish(p, r)
    c = await ann_candidate(p, client)
    assert not c['self_wake_due'] and not c['should_wake']


async def test_repeat_round_uses_unchanged_approved_plan(client, monkeypatch):
    from test_workflow_review_handoff import start_repeat, report_outcome
    p = Project(client)
    await start_repeat(p)
    r = await launch(p, p.ann, 'design')
    h = await handoff(p, r)
    await finish(p, r)
    review = await launch(p, p.bob, 'review')
    await report_outcome(p, review, 'Changes requested', ['Fix spacing'])
    await verdict(p, review, h, 'changes_requested')
    await finish(p, review, p.bob)
    correction = await launch(p, p.ann, 'design', approve=False)
    await finish(p, correction)
    await resume(p, correction, monkeypatch)


async def test_autonomy_on_needs_no_human_plan_decision(client, monkeypatch):
    p, r = await setup(client, approve=False)
    await p.call('PUT', f"/api/tasks/{p.tasks['design']}/autonomy", {'autonomy': 'on', 'actor_agent_id': p.owner})
    await finish(p, r)
    await resume(p, r, monkeypatch)


async def test_hard_cap_during_automatic_run_is_not_clean_or_restart_recovery(client, monkeypatch):
    p, r = await setup(client)
    await finish(p, r)
    nxt = await resume(p, r, monkeypatch)
    await finish(p, nxt, status='killed', exit_code=-9, kill_reason=json.dumps({'cause': 'hard_cap'}))
    assert row(p) is None


async def test_reservation_does_not_allow_early_schedule_or_unbounded_automatic_key(client):
    p, r = await setup(client)
    await finish(p, r)
    scheduled = row(p)
    body = {'operation_key': f"auto-continue:{r['run_id']}", 'automatic_schedule_id': str(scheduled['id'])}
    res = await client.post(f"/api/agents/{p.ann}/runs/{r['run_id']}/continue-reserve", json=body)
    assert res.status_code == 409 and row(p)
    body.pop('automatic_schedule_id')
    res = await client.post(f"/api/agents/{p.ann}/runs/{r['run_id']}/continue-reserve", json=body)
    assert res.status_code == 409 and row(p)


async def test_concurrent_reservations_replay_one_permit(client):
    import asyncio
    from concurrent.futures import ThreadPoolExecutor
    from test_evidence_review_races import post
    p, r = await setup(client)
    await finish(p, r)
    due(p)
    body = {'operation_key': f"auto-continue:{r['run_id']}", 'automatic_schedule_id': str(row(p)['id'])}
    def race():
        with ThreadPoolExecutor(max_workers=3) as pool:
            jobs = [pool.submit(post, f"/api/agents/{p.ann}/runs/{r['run_id']}/continue-reserve", body) for _ in range(3)]
            return [j.result(timeout=20) for j in jobs]
    replies = await asyncio.to_thread(race)
    assert [r.status_code for r in replies] == [201, 201, 201], [r.text for r in replies]
    assert len({r.json()['run_id'] for r in replies}) == 1
    assert row(p) is None
    with db_cursor() as (_, cur):
        cur.execute('SELECT count(*) AS n FROM workflow_launch_permits WHERE execution_id=%s', (r['execution_id'],))
        assert cur.fetchone()['n'] == 2


async def test_restart_before_dispatch_and_after_delivery_preserves_bounded_recovery(client, monkeypatch):
    import importlib
    from orcha_cli import notifier_workflow
    p, r = await setup(client)
    await finish(p, r)
    saved = row(p)
    importlib.reload(notifier_workflow)  # fresh daemon state, same durable database
    assert row(p) == saved
    nxt = await resume(p, r, monkeypatch)
    await finish(p, nxt, status='killed', exit_code=-1,
                 kill_reason=json.dumps({'cause': 'host_process_missing_after_notifier_restart'}))
    assert row(p)
    next_recovery = await resume(p, nxt, monkeypatch)
    from portal_backend.workflow_continuation import automatic_attempts
    with db_cursor() as (_, cur):
        assert automatic_attempts(cur, {'id': next_recovery['execution_id']}) == 2


@pytest.mark.parametrize('kind', ['live', 'missing_pid', 'sandbox'])
def test_notifier_requires_positive_host_stop(kind, monkeypatch):
    from types import SimpleNamespace
    from orcha_cli import notifier_workflow, notifier_orphan_cleanup
    calls = []
    monkeypatch.setattr(notifier_workflow, 'runner_post', lambda *a: calls.append(a))
    if kind == 'live':
        assert not notifier_workflow.confirm_exit('http://local', 'agent', {
            'workflow': True, 'proc': SimpleNamespace(poll=lambda: None)})
    else:
        r = {'workflow_generation': 1, 'pid': None if kind == 'missing_pid' else 123,
             'sandbox_container_id': 'remote' if kind == 'sandbox' else None}
        assert not notifier_orphan_cleanup._confirm_workflow_stop('http://local', r)
    assert not calls
