"""Actual API design -> review -> correction -> CLEAN -> human verification."""
import json

import pytest
from portal_backend.database import db_cursor
from portal_backend import workflow_evidence_service as evidence
from test_workflow_local_launch import Project, local_lane, uid


@pytest.fixture(autouse=True)
def evidence_dir(monkeypatch, tmp_path):
    monkeypatch.setenv('ORCHA_ATTACHMENTS_DIR', str(tmp_path))
    monkeypatch.setattr(evidence.store, 'attachments_dir', lambda: tmp_path)


async def launch(p, aid, key, approve=True):
    r = await p.reserve(aid,key)
    a = await p.activate(aid,r)
    r['token'] = a['run_token']
    if approve:
        await p.client.post(f"/api/tasks/{p.tasks[key]}/messages", json={'author_agent_id':aid,'body':'Plan: produce and independently review the exact work.'})
        await p.call('POST','/api/decisions', {'subject_type':'plan_approval','subject_id':p.tasks[key],
            'decision':'approve','actor_agent_id':p.owner,'target_agent_id':aid},201)
    return r


async def handoff(p, r, result='Draft design ready for independent review', expect=200):
    with db_cursor() as (_,cur):
        cur.execute('SELECT work_revision FROM tasks WHERE id=%s',(p.tasks['design'],))
        revision=cur.fetchone()['work_revision']
    res = await p.client.post(f"/api/agents/{p.ann}/runs/{r['run_id']}/review-handoff",json={
        'review_task_id':p.tasks['review'],'expected_work_revision':revision,'result':result},
        headers={'X-Orcha-Run-Token':r['token']})
    assert res.status_code==expect,res.text
    return res.json()


async def stopped(p, aid, r):
    res=await p.client.post(f"/api/agents/{aid}/runs/{r['run_id']}/confirm-stopped",json={'generation':r['generation']})
    assert res.status_code==200,res.text
    return res.json()


async def verdict(p,r,h,outcome,expect=200):
    res=await p.client.post(f"/api/agents/{p.bob}/runs/{r['run_id']}/review-verdict",json={
        'handoff_id':h['handoff_id'],'verdict':outcome,'result':'Review: '+outcome},
        headers={'X-Orcha-Run-Token':r['token']})
    assert res.status_code==expect,res.text
    return res.json()


async def start_repeat(
    p, *, max_rounds=3, outside_prerequisite=False, owner_outcome=False
):
    tasks = [
        {'client_key': 'design', 'title': 'Task design', 'description': 'd',
         'definition_of_done': 'done', 'assignee_id': p.ann, 'priority': 10},
    ]
    review_dependencies = ['design']
    if outside_prerequisite:
        tasks.append({'client_key': 'research', 'title': 'Task research', 'description': 'd',
                      'definition_of_done': 'done', 'assignee_id': p.bob, 'priority': 20})
        review_dependencies.append('research')
    tasks.extend([
        {'client_key': 'review', 'title': 'Task review', 'description': 'd',
         'definition_of_done': 'done', 'assignee_id': p.bob,
         'depends_on': review_dependencies, 'priority': 30,
         'outcomes': [
             {'name': 'Approved', 'kind': 'success'},
             {'name': 'Changes requested', 'kind': 'changes'},
         ],
         'routes': [
             {'outcome': 'Approved', 'destination': 'exit_group'},
             {'outcome': 'Changes requested', 'destination': 'return',
              'destination_task': 'design'},
         ]},
        {'client_key': 'implementation', 'title': 'Task implementation', 'description': 'd',
         'definition_of_done': 'done', 'assignee_id': p.ann,
         'depends_on': ['review'], 'priority': 40},
    ])
    if owner_outcome:
        review = next(task for task in tasks if task['client_key'] == 'review')
        review['outcomes'].append({'name': 'Ask owner', 'kind': 'custom'})
        review['routes'].append({'outcome': 'Ask owner', 'destination': 'ask_owner'})
    draft = {
        'title': 'Repeat review', 'goal': 'Ship reviewed work', 'execution_mode': 'serial',
        'idempotency_key': uid(), 'tasks': tasks,
        'repeat_groups': [{
            'name': 'Design review', 'member_tasks': ['design', 'review'],
            'review_task': 'review', 'exit_outcome': 'Approved',
            'max_rounds': max_rounds, 'stall_rule': 'findings_and_artifact',
        }],
    }
    p.wid = (await p.call('POST', f'/api/containers/{p.cid}/workflows', draft, 201))['id']
    detail = await p.detail(p.wid)
    p.tasks = {t['title'].removeprefix('Task '): t['id'] for t in detail['tasks']}
    for tid in p.tasks.values():
        detail = await p.detail(p.wid)
        task = next(t for t in detail['tasks'] if t['id'] == tid)
        await p.call('POST', f'/api/tasks/{tid}/prepare',
                     p.mutation(detail, expected_work_revision=task['work_revision']))
    detail = await p.detail(p.wid)
    await p.call('POST', f'/api/workflows/{p.wid}/start', p.mutation(
        detail, task_ids=list(p.tasks.values()), holds=['start'],
        task_revisions={t['id']: t['work_revision'] for t in detail['tasks']}))


async def report_outcome(p, run, outcome, findings=()):
    detail = await p.detail(p.wid)
    task = next(t for t in detail['tasks'] if t['id'] == p.tasks['review'])
    response = await p.client.post(
        f"/api/tasks/{p.tasks['review']}/outcome",
        json={'outcome': outcome, 'findings': [{'text': text} for text in findings],
              'note': 'Review findings', 'expected_revision': detail['revision'],
              'expected_work_revision': task['work_revision'], 'idempotency_key': uid()},
        headers={'X-Orcha-Run-Token': run['token']},
    )
    assert response.status_code == 200, response.text
    return response.json()


async def test_repeat_group_handoff_routes_two_rounds_before_human_verification(client):
    p = Project(client)
    await start_repeat(p)
    before = {t['id']: t['work_revision'] for t in (await p.detail(p.wid))['tasks']}

    source = await launch(p, p.ann, 'design')
    first = await handoff(p, source, 'Draft one')
    await stopped(p, p.ann, source)
    review = await launch(p, p.bob, 'review')
    await report_outcome(p, review, 'Changes requested', ['Tighten the hierarchy'])
    await verdict(p, review, first, 'changes_requested')
    await stopped(p, p.bob, review)

    detail = await p.detail(p.wid)
    rows = {t['id']: t for t in detail['tasks']}
    assert rows[p.tasks['design']]['work_revision'] == before[p.tasks['design']] + 1
    assert rows[p.tasks['review']]['work_revision'] == before[p.tasks['review']] + 1
    assert rows[p.tasks['design']]['can_start']
    context = (await p.client.get(
        f"/api/tasks/{p.tasks['design']}/round-context", headers=p.headers
    )).json()
    assert context['group']['round'] == 2
    assert [f['text'] for f in context['group']['this_round']['findings']] == [
        'Tighten the hierarchy'
    ]

    # The unchanged, human-approved plans carry into round two.  No second plan
    # message or decision is created before either handoff operation.
    correction = await launch(p, p.ann, 'design', approve=False)
    second = await handoff(p, correction, 'Draft two')
    await stopped(p, p.ann, correction)
    review_two = await launch(p, p.bob, 'review', approve=False)
    await report_outcome(p, review_two, 'Approved')
    await verdict(p, review_two, second, 'clean')
    await stopped(p, p.bob, review_two)

    detail = await p.detail(p.wid)
    rows = {t['id']: t for t in detail['tasks']}
    assert rows[p.tasks['design']]['status'] == 'needs_verification'
    assert rows[p.tasks['review']]['status'] == 'needs_verification'
    assert rows[p.tasks['implementation']]['status'] == 'pending'
    assert detail['repeat_groups'][0]['state'] == 'exited'
    history = (await p.client.get(
        f'/api/workflows/{p.wid}/review-handoffs'
    )).json()['handoffs']
    assert [row['phase'] for row in history] == ['superseded', 'clean']
    with db_cursor() as (_, cur):
        cur.execute("SELECT count(*) AS n FROM task_approval_records WHERE phase='plan' AND task_id IN (%s,%s)",
                    (p.tasks['design'], p.tasks['review']))
        assert cur.fetchone()['n'] == 2
        cur.execute("SELECT count(*) AS n FROM workflow_task_acceptances")
        assert cur.fetchone()['n'] == 0


async def test_repeat_group_handoff_keeps_outside_prerequisites(client):
    p = Project(client)
    await start_repeat(p, outside_prerequisite=True)
    source = await launch(p, p.ann, 'design')
    refused = await handoff(p, source, expect=409)
    assert refused['detail']['code'] == 'review_not_eligible'
    blockers = refused['detail']['blockers']
    assert [b['code'] for b in blockers] == ['prerequisites']
    assert 'research' in blockers[0]['message']


async def test_repeat_group_verdict_must_match_the_reported_outcome(client):
    p = Project(client)
    await start_repeat(p)
    source = await launch(p, p.ann, 'design')
    receipt = await handoff(p, source)
    await stopped(p, p.ann, source)
    review = await launch(p, p.bob, 'review')
    await report_outcome(p, review, 'Approved')
    refused = await verdict(p, review, receipt, 'changes_requested', expect=409)
    assert refused['detail']['code'] == 'review_verdict_outcome_mismatch'


async def test_repeat_group_prompt_names_the_supported_handoff_order(client):
    from orcha_cli.notifier_protocol import _render_workflow
    from portal_backend.workflow_prompt import workflow_for_prompt

    p = Project(client)
    await start_repeat(p)
    with db_cursor() as (_, cur):
        cur.execute('SELECT * FROM tasks WHERE id=%s', (p.tasks['design'],))
        source_text = _render_workflow(workflow_for_prompt(cur, dict(cur.fetchone())))
        cur.execute('SELECT * FROM tasks WHERE id=%s', (p.tasks['review'],))
        review_text = _render_workflow(workflow_for_prompt(cur, dict(cur.fetchone())))
    assert "review_task_id" in source_text and p.tasks['review'] in source_text
    assert 'satisfies only this direct prerequisite' in source_text
    assert 'first report the configured loop outcome and findings' in review_text
    assert 'then POST the matching review verdict' in review_text


@pytest.mark.parametrize('choice', ['raise_limit', 'reassign_continue'])
async def test_repeat_group_round_limit_holds_both_results_until_owner_continues(client, choice):
    p = Project(client)
    await start_repeat(p, max_rounds=1)
    source = await launch(p, p.ann, 'design')
    receipt = await handoff(p, source)
    await stopped(p, p.ann, source)
    review = await launch(p, p.bob, 'review')
    await report_outcome(p, review, 'Changes requested', ['One more pass'])
    await verdict(p, review, receipt, 'changes_requested')
    await stopped(p, p.bob, review)
    detail = await p.detail(p.wid)
    rows = {t['id']: t for t in detail['tasks']}
    assert detail['repeat_groups'][0]['state'] == 'limit_reached'
    assert rows[p.tasks['design']]['status'] == 'not_ready'
    assert rows[p.tasks['review']]['status'] == 'not_ready'
    assert rows[p.tasks['review']]['awaiting_loop_decision'] == 'limit_reached'

    decision = {'kind': choice, 'task_id': p.tasks['review'], 'note': 'One more round'}
    if choice == 'raise_limit':
        decision['new_max_rounds'] = 2
    await p.call('POST', f'/api/workflows/{p.wid}/decisions',
                 p.mutation(detail, **decision))
    detail = await p.detail(p.wid)
    rows = {t['id']: t for t in detail['tasks']}
    assert detail['repeat_groups'][0]['state'] == 'open'
    assert detail['repeat_groups'][0]['current_round'] == 2
    assert rows[p.tasks['design']]['can_start']


@pytest.mark.parametrize('choice,state', [('accept_override', 'exited'), ('stop', 'stopped')])
async def test_repeat_group_owner_can_end_a_handoff_at_the_round_limit(client, choice, state):
    p = Project(client)
    await start_repeat(p, max_rounds=1)
    source = await launch(p, p.ann, 'design')
    receipt = await handoff(p, source)
    await stopped(p, p.ann, source)
    review = await launch(p, p.bob, 'review')
    await report_outcome(p, review, 'Changes requested', ['Owner decides'])
    await verdict(p, review, receipt, 'changes_requested')
    await stopped(p, p.bob, review)
    detail = await p.detail(p.wid)
    await p.call('POST', f'/api/workflows/{p.wid}/decisions', p.mutation(
        detail, kind=choice, task_id=p.tasks['review']))
    detail = await p.detail(p.wid)
    rows = {t['id']: t for t in detail['tasks']}
    assert detail['repeat_groups'][0]['state'] == state
    assert rows[p.tasks['design']]['status'] == 'needs_verification'
    assert rows[p.tasks['review']]['status'] == 'needs_verification'
    history = (await p.client.get(
        f'/api/workflows/{p.wid}/review-handoffs'
    )).json()['handoffs']
    assert history[-1]['phase'] == 'clean'
    if choice == 'stop':
        assert rows[p.tasks['implementation']]['route_state'] == 'not_selected'


async def test_repeat_group_owner_can_pick_the_exit_after_a_handoff_question(client):
    p = Project(client)
    await start_repeat(p, owner_outcome=True)
    source = await launch(p, p.ann, 'design')
    receipt = await handoff(p, source)
    await stopped(p, p.ann, source)
    review = await launch(p, p.bob, 'review')
    await report_outcome(p, review, 'Ask owner', ['Choose whether this is sufficient'])
    await verdict(p, review, receipt, 'changes_requested')
    await stopped(p, p.bob, review)
    detail = await p.detail(p.wid)
    rows = {t['id']: t for t in detail['tasks']}
    assert detail['repeat_groups'][0]['state'] == 'awaiting_owner'
    assert rows[p.tasks['design']]['status'] == 'not_ready'
    assert rows[p.tasks['review']]['awaiting_loop_decision'] == 'ask_owner'

    await p.call('POST', f'/api/workflows/{p.wid}/decisions', p.mutation(
        detail, kind='pick_outcome', task_id=p.tasks['review'], outcome='Approved'))
    detail = await p.detail(p.wid)
    rows = {t['id']: t for t in detail['tasks']}
    assert detail['repeat_groups'][0]['state'] == 'exited'
    assert rows[p.tasks['design']]['status'] == 'needs_verification'
    assert rows[p.tasks['review']]['status'] == 'needs_verification'


async def test_repeat_group_stall_compares_captured_handoff_hashes(client):
    p = Project(client)
    await start_repeat(p, max_rounds=4)
    for round_number in (1, 2):
        source = await launch(p, p.ann, 'design', approve=round_number == 1)
        receipt = await handoff(p, source, 'Unchanged draft')
        await stopped(p, p.ann, source)
        review = await launch(p, p.bob, 'review', approve=round_number == 1)
        await report_outcome(p, review, 'Changes requested', ['Same finding'])
        await verdict(p, review, receipt, 'changes_requested')
        await stopped(p, p.bob, review)
    detail = await p.detail(p.wid)
    rows = {t['id']: t for t in detail['tasks']}
    assert detail['repeat_groups'][0]['state'] == 'stalled'
    assert detail['repeat_groups'][0]['current_round'] == 2
    assert rows[p.tasks['design']]['status'] == 'not_ready'
    assert rows[p.tasks['review']]['awaiting_loop_decision'] == 'stalled'
    with db_cursor() as (_, cur):
        cur.execute("SELECT stall FROM workflow_group_rounds WHERE end_reason='stall'")
        stall = cur.fetchone()['stall']
        stall = json.loads(stall) if isinstance(stall, str) else stall
        assert stall['method'] == 'finding text and captured evidence hashes'
    await p.call('POST', f'/api/workflows/{p.wid}/decisions', p.mutation(
        detail, kind='resume_stalled', task_id=p.tasks['review'], note='Try one more round'))
    detail = await p.detail(p.wid)
    rows = {t['id']: t for t in detail['tasks']}
    assert detail['repeat_groups'][0]['state'] == 'open'
    assert detail['repeat_groups'][0]['current_round'] == 3
    assert rows[p.tasks['design']]['can_start']


@pytest.mark.parametrize('autonomy', ['off', 'on'])
async def test_full_loop_preserves_unfinished_work_and_requires_human_verification(client, autonomy):
    p=Project(client)
    await p.start('serial',[('design',p.ann,[]),('review',p.bob,[]),('implementation',p.ann,['design'])])
    if autonomy == 'on':
        for key in ('design', 'review'):
            await p.call('PUT', f"/api/tasks/{p.tasks[key]}/autonomy", {'autonomy': 'on', 'actor_agent_id': p.owner})
    source=await launch(p,p.ann,'design')
    h=await handoff(p,source)
    # An explicit handoff is NOT a successful task completion or proof of exit.
    await p.reserve(p.bob,'review',expect=409)
    assert next(t for t in (await p.detail(p.wid))['tasks'] if t['id']==p.tasks['design'])['status']=='in_progress'
    await stopped(p,p.ann,source)
    reviewer=await launch(p,p.bob,'review')
    await p.reserve(p.ann,'design',expect=409)
    await verdict(p,reviewer,h,'changes_requested')
    await p.reserve(p.ann,'design',expect=409)
    await stopped(p,p.bob,reviewer)
    correction=await launch(p,p.ann,'design')
    h2=await handoff(p,correction,'Corrected draft')
    await stopped(p,p.ann,correction)
    reviewer2=await launch(p,p.bob,'review')
    await verdict(p,reviewer2,h2,'clean')
    await stopped(p,p.bob,reviewer2)
    detail=await p.detail(p.wid)
    rows={t['id']:t for t in detail['tasks']}
    assert rows[p.tasks['design']]['status']=='needs_verification'
    assert rows[p.tasks['review']]['status']=='needs_verification'
    for key in ['design','review']:
        accept = next(a for a in rows[p.tasks[key]]['available_actions'] if a['action']=='accept')
        assert accept['enabled'], accept
    assert rows[p.tasks['implementation']]['status']=='pending'
    with db_cursor() as (_,cur):
        cur.execute('SELECT count(*) AS n FROM workflow_task_acceptances')
        assert cur.fetchone()['n']==0
        cur.execute("SELECT count(*) AS n FROM workflow_executions WHERE state IN ('running','reserved','awaiting_review','recovery_needed','stopping')")
        assert cur.fetchone()['n']==0
    history=(await client.get(f'/api/workflows/{p.wid}/review-handoffs')).json()['handoffs']
    assert [r['phase'] for r in history]==['superseded','clean']
    from portal_backend.workflow_evidence_service import evidence_reference
    for key in ['design','review']:
        detail=await p.detail(p.wid)
        t=next(t for t in detail['tasks'] if t['id']==p.tasks[key])
        with db_cursor() as (_,cur):
            cur.execute('SELECT current_evidence_set_id FROM workflow_executions WHERE task_id=%s ORDER BY generation DESC LIMIT 1',(t['id'],))
            ref=evidence_reference(cur,cur.fetchone()['current_evidence_set_id'])
        ref = {'evidence_set_id': ref['evidence_set_id'], 'items': [{k: item[k] for k in ('item_id','deliverable_id','deliverable_version','sha256')} for item in ref['items']]}
        await p.call('POST',f"/api/tasks/{t['id']}/accept",p.mutation(detail,expected_work_revision=t['work_revision'],evidence=ref))
    assert next(t for t in (await p.detail(p.wid))['tasks'] if t['id']==p.tasks['implementation'])['status']=='ready'


@pytest.mark.parametrize('gate',['plan','dependency','hold','cancel'])
async def test_handoff_preserves_existing_gates(client,gate):
    p=Project(client)
    await p.start('serial',[('design',p.ann,[]),('review',p.bob,['design'] if gate=='dependency' else [])])
    source=await launch(p,p.ann,'design',approve=gate!='plan')
    if gate=='hold':
        d=await p.detail(p.wid);t=next(t for t in d['tasks'] if t['id']==p.tasks['review'])
        await p.call('POST',f"/api/tasks/{t['id']}/hold",p.mutation(d,expected_work_revision=t['work_revision']))
    if gate=='cancel':
        d=await p.detail(p.wid)
        await p.call('POST',f'/api/workflows/{p.wid}/cancel',p.mutation(d))
    await handoff(p,source,expect=409)
    with db_cursor() as (_,cur):
        cur.execute('SELECT count(*) AS n FROM workflow_review_handoffs')
        assert cur.fetchone()['n']==0


async def test_cancel_after_handoff_keeps_all_work_cancelled(client):
    p=Project(client)
    await p.start('serial',[('design',p.ann,[]),('review',p.bob,[])])
    source=await launch(p,p.ann,'design')
    await handoff(p,source)
    d=await p.detail(p.wid)
    await p.call('POST',f'/api/workflows/{p.wid}/cancel',p.mutation(d))
    await stopped(p,p.ann,source)
    assert {t['status'] for t in (await p.detail(p.wid))['tasks']}=={'cancelled'}
    await p.reserve(p.bob,'review',expect=409)


async def test_handoff_retries_and_premature_completion_cannot_skip_review(client):
    p=Project(client)
    await p.start('serial',[('design',p.ann,[]),('review',p.bob,[])])
    source=await launch(p,p.ann,'design')
    h=await handoff(p,source)
    assert (await handoff(p,source))['handoff_id']==h['handoff_id']
    await handoff(p,source,result='Changed submission',expect=409)
    premature=await client.post(f"/api/tasks/{p.tasks['design']}/done",json={'agent_id':p.ann,'result':'Premature completion'},headers={'X-Orcha-Run-Token':source['token']})
    assert premature.status_code==409 and premature.json()['detail']['code']=='clean_review_required'
    await stopped(p,p.ann,source)
    reviewer=await launch(p,p.bob,'review')
    await verdict(p,reviewer,h,'clean')
    await verdict(p,reviewer,h,'clean')
    await stopped(p,p.bob,reviewer)
    again=await stopped(p,p.bob,reviewer)
    assert again['state']=='released'
    with db_cursor() as (_,cur):
        cur.execute('SELECT count(*) AS n FROM workflow_review_handoffs')
        assert cur.fetchone()['n']==1
    late=await client.post(f"/api/agents/{p.bob}/runs/{reviewer['run_id']}/review-verdict",json={'handoff_id':h['handoff_id'],'verdict':'changes_requested','result':'Late change'},headers={'X-Orcha-Run-Token':reviewer['token']})
    assert late.status_code==409


async def test_pending_handoff_keeps_single_turn_until_exit_and_retains_holds(client):
    p=Project(client)
    await p.start('serial',[('design',p.ann,[]),('review',p.bob,[])])
    source=await launch(p,p.ann,'design')
    await handoff(p,source)
    d=await p.detail(p.wid);t=next(t for t in d['tasks'] if t['id']==p.tasks['review'])
    await p.call('POST',f"/api/tasks/{t['id']}/hold",p.mutation(d,expected_work_revision=t['work_revision']))
    await stopped(p,p.ann,source)
    await p.reserve(p.bob,'review',expect=409)
    assert next(t for t in (await p.detail(p.wid))['tasks'] if t['id']==p.tasks['review'])['human_hold_by']==p.owner


async def test_author_reassignment_cannot_take_independent_review_turn(client):
    p=Project(client)
    await p.start('serial',[('design',p.ann,[]),('review',p.bob,[])])
    source=await launch(p,p.ann,'design')
    await handoff(p,source)
    await stopped(p,p.ann,source)
    # Simulate an assignment changed after the handoff was recorded.
    with db_cursor() as (_,cur):
        cur.execute("UPDATE agent_tasks SET assignment_status='done' WHERE task_id=%s", (p.tasks['review'],))
        cur.execute("INSERT INTO agent_tasks(agent_id,task_id,assignment_status) VALUES (%s,%s,'assigned')", (p.ann,p.tasks['review']))
    result=await p.reserve(p.ann,'review',expect=409)
    assert result['detail']['code']=='independent_review_required'


async def owner_action(p, key, action):
    detail = await p.detail(p.wid)
    task = next(t for t in detail['tasks'] if t['id'] == p.tasks[key])
    return await p.call('POST', f"/api/tasks/{task['id']}/{action}",
                        p.mutation(detail, expected_work_revision=task['work_revision']))


@pytest.mark.parametrize('side', ['source', 'review'])
@pytest.mark.parametrize('exit_kind', ['stop', 'lost'])
async def test_interrupted_round_requires_owner_retry_and_a_new_clean_round(client, side, exit_kind):
    p = Project(client)
    await p.start('serial', [('design', p.ann, []), ('review', p.bob, []), ('later', p.bob, [])])
    source = await launch(p, p.ann, 'design')
    h = await handoff(p, source)
    run, aid, key = source, p.ann, 'design'
    if side == 'review':
        await stopped(p, p.ann, source)
        run = await launch(p, p.bob, 'review')
        aid, key = p.bob, 'review'
        await verdict(p, run, h, 'clean')
    await owner_action(p, key, 'stop')
    # Interrupted handoffs cannot release capacity without proof or owner recovery.
    await p.reserve(p.bob, 'later', expect=409)
    if exit_kind == 'lost':
        from portal_backend import sql
        with db_cursor() as (_, cur):
            cur.execute('UPDATE workflow_executions SET first_stop_at=%s,last_runner_contact_at=%s WHERE run_id=%s',
                        (sql.ago(7200), sql.ago(7200), run['run_id']))
        await owner_action(p, key, 'release-lost-worker')
    else:
        await stopped(p, aid, run)
    history = (await client.get(f'/api/workflows/{p.wid}/review-handoffs')).json()['handoffs']
    assert history[-1]['phase'] == 'cancelled'
    detail = await p.detail(p.wid)
    for task in detail['tasks']:
        if task['id'] in (p.tasks['design'], p.tasks['review']):
            assert task['awaiting_owner_decision']
            assert next(a for a in task['available_actions'] if a['action'] == 'retry')['enabled']
    for k in ('design', 'review'):
        await owner_action(p, k, 'retry')
    correction = await launch(p, p.ann, 'design')
    premature = await client.post(f"/api/tasks/{p.tasks['design']}/done", json={
        'agent_id': p.ann, 'result': 'Retry must not waive CLEAN'},
        headers={'X-Orcha-Run-Token': correction['token']})
    assert premature.status_code == 409
    assert premature.json()['detail']['code'] == 'clean_review_required'
    h2 = await handoff(p, correction, 'Revised work after interrupted review')
    await stopped(p, p.ann, correction)
    reviewer = await launch(p, p.bob, 'review')
    await verdict(p, reviewer, h2, 'clean')
    await stopped(p, p.bob, reviewer)
    tasks = (await p.detail(p.wid))['tasks']
    assert all(t['status'] == 'needs_verification' for t in tasks if t['id'] in (p.tasks['design'], p.tasks['review']))


async def test_cancelled_reviewer_offers_retry_without_reviving_it_or_waiving_clean(client):
    p = Project(client)
    await p.start('serial', [('design', p.ann, []), ('review', p.bob, [])])
    source = await launch(p, p.ann, 'design')
    await handoff(p, source)
    await stopped(p, p.ann, source)
    await p.call('POST', f"/api/tasks/{p.tasks['review']}/cancel",
                 {'actor_agent_id': p.owner, 'reason': 'Owner cancels reviewer'})
    detail = await p.detail(p.wid)
    source_task = next(t for t in detail['tasks'] if t['id'] == p.tasks['design'])
    assert source_task['awaiting_owner_decision']
    assert next(a for a in source_task['available_actions'] if a['action'] == 'retry')['enabled']
    await owner_action(p, 'design', 'retry')
    correction = await launch(p, p.ann, 'design')
    await handoff(p, correction, expect=409)
    assert next(t for t in (await p.detail(p.wid))['tasks'] if t['id'] == p.tasks['review'])['status'] == 'cancelled'
    premature = await client.post(f"/api/tasks/{p.tasks['design']}/done", json={
        'agent_id': p.ann, 'result': 'No independent review yet'}, headers={'X-Orcha-Run-Token': correction['token']})
    assert premature.status_code == 409 and premature.json()['detail']['code'] == 'clean_review_required'
