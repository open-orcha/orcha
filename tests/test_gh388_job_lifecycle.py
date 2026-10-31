"""Real supervisor, registry reconciliation and notifier admission seams."""

import asyncio
import hashlib
import json
import subprocess
import sys
import time
from types import SimpleNamespace

import httpx
import pytest

from orcha_cli.cli_job import start_job, yield_command, handle_result
from orcha_cli.job_api import JobAPI, JobAPIError
from orcha_cli.job_store import JobStore, read_json, atomic_json
from orcha_cli import notifier_job_monitors, notifier_managed_jobs
from test_gh312_managed_messages import managed
from test_gh312_managed_jobs import publish, reserve
from test_gh312_job_supervisor import service, eventually, running, result
from test_gh388_job_monitors import finish_worker, candidate, monitor_url, observation


@pytest.fixture
def transport():
    with httpx.Client(timeout=3) as client:
        def post(url, body):
            r = client.post(url,json=body)
            assert r.status_code in {200,201}, r.text
            return r.json()
        def get(url):
            r=client.get(url)
            assert r.status_code==200,r.text
            return r.json()
        yield SimpleNamespace(_post_json=post,_get_json=get)


@pytest.mark.skipif(sys.platform != 'darwin', reason='Continuation requires the enforced macOS contract')
@pytest.mark.parametrize('runtime',['claude','codex'])
async def test_yield_original_supervisor_survives_and_notifier_launches_once(
        client,managed,db,service,tmp_path,transport,monkeypatch,runtime):
    from orcha_cli import notifier, notifier_wake_worker
    await publish(client,managed,seconds=120)
    db.execute("UPDATE tasks SET autonomy='on' WHERE id=%s",(managed['tid'],))
    db.execute('UPDATE worker_runs SET runtime=%s WHERE run_id=%s',(runtime,managed['rid']))
    api=JobAPI(service[0],managed['token'],managed['tid'])
    store=JobStore(tmp_path)
    code="import os,time;from pathlib import Path;p=Path(os.environ['ORCHA_JOB_SCRATCH'])/'starts';p.write_text('once');time.sleep(3);print('private-result-marker')"
    jid=start_job(api,store,key='retained-original',purpose='Disposable isolated check',
        argv=[sys.executable,'-c',code],cwd=tmp_path,isolate=True,continue_after_exit=True)['job_id']
    try:
        await asyncio.to_thread(eventually,lambda:running(store,jid))
        await asyncio.to_thread(eventually,lambda:(store.job_directory(jid)/'scratch'/'starts').exists())
        before=store.read(jid)
        yield_command(api,store,jid,{'completed_steps':['Started the check.'],'remaining_steps':['Use the result.']})
        worker={'run_id':managed['rid'],'base_cwd':str(tmp_path),'run_token':managed['token']}
        assert await asyncio.to_thread(notifier_managed_jobs.prepare,service[0],worker,transport,
                                      reason='worker_exited',stop=True)
        assert not (store.job_directory(jid)/'daemon-stop.json').exists()
        await finish_worker(client,managed)
        assert not (await candidate(client,managed,db))['should_wake']
        saved=await asyncio.to_thread(eventually,lambda:result(store,jid),seconds=12)
        ended=time.monotonic()
        assert saved['exit_code']==0 and saved['owner_run_id']==managed['rid']
        assert store.read(jid)['supervisor']==before['supervisor']
        assert (store.job_directory(jid)/'scratch'/'starts').read_text()=='once'
        await asyncio.to_thread(eventually,lambda:db.execute('SELECT * FROM managed_job_outcomes'),seconds=8)
        c=await candidate(client,managed,db)
        assert c['should_wake'] and c['completion']
        assert 'private-result-marker' not in json.dumps(c)
        c['headless_cwd']=str(tmp_path)
        c['model_runtime']=runtime
        # Only the unavailable model executable is substituted. All claim,
        # token, startup, run-registration and fixed-limit calls remain real.
        spawned=[]
        def model_leaf(*args,**kwargs):
            assert kwargs['runtime']==runtime
            assert 'result-handled' in kwargs['system_prompt']
            p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(.2)'])
            spawned.append(p)
            return True,'temporary model leaf',p
        monkeypatch.setattr(notifier,'spawn_headless',model_leaf)
        live={}
        launched=await asyncio.to_thread(notifier_wake_worker.spawn,service[0],c,prompt='Continue the saved task.',
            event='managed_command_completion',dry_run=False,quiet=True,lease_ttl=120,live_workers=live,services=notifier)
        assert launched and launched['sent']
        assert time.monotonic()-ended < 15  # eligible host, cooldown and idle gates zero
        assert (await asyncio.to_thread(notifier_wake_worker.spawn,service[0],c,prompt='Retry delivery.',
            event='managed_command_completion',dry_run=False,quiet=True,lease_ttl=120,live_workers=live,services=notifier)) is None
        assert len(spawned)==1
        successor=live[managed['aid']]
        successor_api=JobAPI(service[0],successor['run_token'],managed['tid'])
        outcomes=successor_api.request('job-outcomes/poll',{})['outcomes']
        assert len(outcomes)==1
        handle_result(successor_api,store,jid,outcomes[0]['revision'],'applied','Used the verified exit status.')
        assert not successor_api.request('job-outcomes/poll',{})['outcomes']
        spawned[0].wait(timeout=3)
        await finish_worker(client,{**managed,'rid':successor['run_id']})
        assert not (await candidate(client,managed,db))['completion']
    finally:
        # The original deadline is also finite; use the existing stop endpoint
        # for cleanup if an assertion interrupted the normal completion path.
        if not result(store,jid):
            before=store.read(jid)
            directory=store.job_directory(jid)
            atomic_json(directory/'daemon-stop.json',{'owner_run_id':before['owner_run_id'],'launch_nonce':before['launch_nonce'],'reason':'test_cleanup'})
            await asyncio.to_thread(eventually,lambda:result(store,jid),seconds=12)


async def test_registry_discovers_missing_record_and_retries_lost_publication(
        client,managed,db,service,tmp_path,transport,monkeypatch):
    await publish(client,managed)
    job=await reserve(client,managed)
    db.execute('UPDATE managed_jobs SET reserved_at=%s',(db.ago(30),))
    store=JobStore(tmp_path)
    cid=str(db.execute('SELECT container_id FROM agents WHERE id=%s',(managed['aid'],))[0]['container_id'])
    original=JobAPI.request
    lost=[False]
    def lose_reply(self,suffix,*args,**kwargs):
        response=original(self,suffix,*args,**kwargs)
        if suffix.endswith('/observe') and not lost[0]:
            lost[0]=True
            raise JobAPIError()
        return response
    monkeypatch.setattr(JobAPI,'request',lose_reply)
    await asyncio.to_thread(notifier_job_monitors.tick,service[0],cid,str(tmp_path),transport)
    assert len(db.execute('SELECT * FROM managed_job_outcomes'))==1
    pending=read_json(store.root/f".observation-{job['job_id']}.json")
    notifier_job_monitors._last_pass.clear()  # restarted daemon
    await asyncio.to_thread(notifier_job_monitors.tick,service[0],cid,str(tmp_path),transport)
    assert len(db.execute('SELECT * FROM managed_job_outcomes'))==1
    assert not (store.root/f".observation-{job['job_id']}.json").exists()
    operations=db.execute('SELECT * FROM managed_job_monitor_operations')
    assert len(operations)==1 and str(operations[0]['operation_id'])==pending['operation_id']
    with store.locked():
        assert store.retains_worktree(tmp_path)


async def test_workflow_completion_uses_automatic_limit_despite_system_events(client,monkeypatch):
    from test_workflow_continuation import setup, finish, due
    from test_workflow_local_launch import ann_candidate, notifier_launch
    from portal_backend.database import db_cursor
    from portal_backend import sql
    p,r=await setup(client)
    m={'rid':r['run_id'],'tid':p.tasks['design'],'aid':p.ann,'headers':{'X-Orcha-Run-Token':r['token']}}
    await publish(client,m)
    job=await reserve(client,m)
    await finish(p,r)
    response=await client.post(monitor_url(m,job,'observe'),json=observation(job))
    assert response.status_code==200,response.text
    due(p)
    with db_cursor() as (_,cur):
        cur.execute('UPDATE workflow_executions SET worker_stopped_at=%s WHERE run_id=%s',(sql.ago(130),r['run_id']))
    c=await ann_candidate(p,client)
    assert c['completion']
    response=await notifier_launch(client,c,monkeypatch)
    assert response.status_code==201,response.text
    replay=await notifier_launch(client,c,monkeypatch)
    assert replay.json()==response.json()
    from portal_backend.workflow_continuation import automatic_attempts
    with db_cursor() as (_,cur):
        assert automatic_attempts(cur,{'id':r['execution_id']})==1
        cur.execute('SELECT attempts FROM managed_job_outcomes')
        assert cur.fetchone()['attempts']==1


@pytest.mark.skipif(sys.platform != 'darwin', reason='Continuation requires the enforced macOS contract')
@pytest.mark.parametrize('runtime', ['claude', 'codex'])
async def test_stop_after_exit_reaches_retained_guard_and_preserves_result(
        client, managed, db, service, tmp_path, transport, make_agent, runtime):
    await publish(client, managed, seconds=30)
    db.execute('UPDATE worker_runs SET runtime=%s WHERE run_id=%s', (runtime, managed['rid']))
    api = JobAPI(service[0], managed['token'], managed['tid'])
    store = JobStore(tmp_path)
    jid = start_job(api, store, key='stop-retained-command', purpose='Disposable stop check',
        argv=[sys.executable, '-c', 'import time;time.sleep(20)'], cwd=tmp_path,
        isolate=True, continue_after_exit=True)['job_id']
    try:
        await asyncio.to_thread(eventually, lambda: running(store, jid))
        worker = {'run_id': managed['rid'], 'base_cwd': str(tmp_path), 'run_token': managed['token']}
        assert await asyncio.to_thread(notifier_managed_jobs.prepare, service[0], worker,
            transport, reason='worker_exited', stop=True)
        await finish_worker(client, managed)
        owner = (await make_agent('Stop owner', kind='human'))['agent_id']
        stopped = await client.post(f"/api/runs/{managed['rid']}/stop", json={'actor_agent_id': owner})
        assert stopped.status_code == 200 and stopped.json()['stop_requested'], stopped.text
        saved = await asyncio.to_thread(eventually, lambda: result(store, jid), seconds=12)
        assert saved['termination_verified'] and saved['exit_code'] != 0
        await asyncio.to_thread(eventually, lambda: db.execute('SELECT * FROM managed_job_outcomes'))
        assert db.execute('SELECT status FROM worker_runs')[0]['status'] == 'exited'
        assert not (await candidate(client, managed, db))['completion']
        assert db.execute('SELECT handled_at FROM managed_job_outcomes')[0]['handled_at'] is None
        with store.locked():
            assert store.retains_worktree(tmp_path)
    finally:
        if not result(store, jid):
            record = store.read(jid)
            atomic_json(store.job_directory(jid) / 'daemon-stop.json', {
                'owner_run_id': record['owner_run_id'], 'launch_nonce': record['launch_nonce'],
                'reason': 'test_cleanup'})
            await asyncio.to_thread(eventually, lambda: result(store, jid), seconds=12)


async def test_yield_suppresses_direct_checkpoint_and_restart_recovery_but_keeps_guidance(
        client, managed, db, service, transport, make_agent):
    from orcha_cli.notifier_checkpoint import checkpoint_and_respawn
    await publish(client, managed)
    db.execute("UPDATE tasks SET autonomy='on' WHERE id=%s", (managed['tid'],))
    job = await reserve(client, managed, continuation_contract='readonly_single_process_v1',
        continue_after_exit=True, continuation_capability_digest=hashlib.sha256(b'a'*43).hexdigest())
    response = await client.post(monitor_url(managed, job, 'yield'), headers=managed['headers'],
        json={'context_digest': 'd'*64})
    assert response.status_code == 200, response.text
    killed = []
    transport._kill_worker = lambda proc, **kw: killed.append(proc)
    process = object()
    # No spawn/token methods are supplied: calling any replacement path fails.
    await asyncio.to_thread(checkpoint_and_respawn, service[0], managed['aid'],
        {'proc': process, 'run_id': managed['rid']}, {}, True, transport)
    assert killed == [process]
    response = await client.post(f"/api/runs/{managed['rid']}/finish", json={
        'status': 'killed', 'exit_code': -15, 'error': 'Recovered after notifier restart'})
    assert response.status_code == 200, response.text
    assert not db.execute("SELECT * FROM agent_events WHERE event_name='task_assigned' "
                         "AND payload->>'reason'='notifier_restart_recovery'")
    await client.post(f"/api/agents/{managed['aid']}/wake-ack", json={
        'run_id': managed['rid'], 'release_lease': True, 'lane': 'work', 'kind': 'released'})
    assert not (await candidate(client, managed, db))['should_wake']
    owner = (await make_agent('Guidance owner', kind='human'))['agent_id']
    response = await client.post(f"/api/tasks/{managed['tid']}/messages", json={
        'author_agent_id': owner, 'body': 'Please inspect the saved progress.'})
    assert response.status_code == 201, response.text
    wake = await candidate(client, managed, db)
    assert wake['should_wake'] and wake['context_task_id'] == managed['tid']
    assert len(db.execute('SELECT * FROM managed_jobs')) == 1
    assert len(db.execute('SELECT * FROM managed_job_waits')) == 1


async def test_handling_before_final_checkpoint_reply_does_not_mutate_controller_record(
        client, managed, db, service, tmp_path, monkeypatch):
    import threading
    from portal_backend.application import app
    await publish(client, managed, seconds=60)
    route = next(r for r in app.routes if getattr(r, 'path', '').endswith('/{jid}/checkpoint'))
    original = route.dependant.call
    committed, release = threading.Event(), threading.Event()

    def delay_terminal_reply(*args, **kwargs):
        response = original(*args, **kwargs)
        if kwargs['body'].state == 'completed':
            committed.set()
            release.wait(timeout=3)
        return response

    monkeypatch.setattr(route.dependant, 'call', delay_terminal_reply)
    api = JobAPI(service[0], managed['token'], managed['tid'])
    store = JobStore(tmp_path)
    jid = start_job(api, store, key='handle-before-publication-reply', purpose='Disposable receipt race',
        argv=[sys.executable, '-c', 'import time;time.sleep(.2)'], cwd=tmp_path)['job_id']
    try:
        assert await asyncio.to_thread(committed.wait, 8)
        record = store.read(jid)
        outcome = api.request('job-outcomes/poll', {})['outcomes'][0]
        handle_result(api, store, jid, outcome['revision'], 'applied', 'Used the original result.')
        assert store.read(jid) == record
        assert store.result_handled(record)
    finally:
        release.set()
    await asyncio.to_thread(eventually, lambda: not (store.job_directory(jid)/'publication.json').exists())
    assert not any(read_json(p)['reason'] == 'supervisor_error'
                   for p in store.job_directory(jid).glob('checkpoint-*.json'))


def test_handled_result_keeps_checkout_until_saved_remaining_work_releases_it(tmp_path):
    from uuid import uuid4
    store = JobStore(tmp_path)
    jid, nonce, rid = (str(uuid4()) for _ in range(3))
    store.reserve(jid, dict(cwd=str(tmp_path), launch_nonce=nonce, owner_run_id=rid, task_id=str(uuid4()),
        status='completed', termination_verified=True, result_saved=True, monitor_enabled=True))
    directory = store.job_directory(jid)
    atomic_json(directory/'result.json', dict(job_id=jid, launch_nonce=nonce, owner_run_id=rid,
        termination_verified=True, status='completed', exit_code=0, signal=None))
    context = directory/'context.json'
    atomic_json(context, dict(completed_steps=['Read the test result.'],
        remaining_steps=['Continue using the ignored build artifacts in this original checkout.']))

    class SavedOutcome:  # Only the server acknowledgement is substituted.
        def request(self, suffix, body=None, method='POST', timeout=None):
            if suffix == 'managed-jobs':
                return {'jobs': [{'job_id': jid}]}
            return {'termination_verified': True, **body}

    def retained():
        with store.locked():
            return store.retains_worktree(tmp_path)

    handle_result(SavedOutcome(), store, jid, 1, 'applied', 'Used the verified result.')
    assert store.result_handled(store.read(jid))
    assert retained(), 'handling released a checkout still needed by saved remaining work'
    handle_result(SavedOutcome(), store, jid, 1, 'applied', 'Used the verified result.', release_checkout=True)
    assert not retained()
    # A later save of new remaining work is not covered by the earlier release.
    atomic_json(context, dict(completed_steps=[], remaining_steps=['Rebuild from the cached objects.']))
    assert retained()
    atomic_json(context, dict(completed_steps=['Done.'], remaining_steps=[]))
    assert not retained()
    context.write_text('{not json')
    assert retained()
