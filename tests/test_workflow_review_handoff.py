"""Actual API design -> review -> correction -> CLEAN -> human verification."""
import pytest
from portal_backend.database import db_cursor
from portal_backend import workflow_evidence_service as evidence
from test_workflow_local_launch import Project, local_lane


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


async def verdict(p,r,h,outcome):
    res=await p.client.post(f"/api/agents/{p.bob}/runs/{r['run_id']}/review-verdict",json={
        'handoff_id':h['handoff_id'],'verdict':outcome,'result':'Review: '+outcome},
        headers={'X-Orcha-Run-Token':r['token']})
    assert res.status_code==200,res.text


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
