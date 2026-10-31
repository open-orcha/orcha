"""Durable outcomes through real API/DB seams, independent of delivery cursors."""

import hashlib
from uuid import uuid4

import pytest

from test_gh312_managed_messages import managed
from test_gh312_managed_jobs import checkpoint_body, publish, reserve, url
from test_gh312_job_supervisor import service  # noqa: F401 (fixture)


def monitor_url(m, job, action):
    return f"/api/tasks/{m['tid']}/job-monitors/{job['job_id']}/{action}"


def observation(job, **changes):
    return checkpoint_body(owner_run_id=job['owner_run_id'], launch_nonce=job['launch_nonce'],
        state='completed', termination_verified=True, result_digest='b'*64, **changes)


async def test_late_publication_survives_revoked_worker_and_pause(client, managed, db):
    await publish(client, managed)
    job = await reserve(client, managed)
    db.execute("UPDATE worker_runs SET status='exited',ended_at=now() WHERE run_id=%s", (managed['rid'],))
    db.execute('UPDATE embodiment_tokens SET revoked_at=now() WHERE run_token=%s', (managed['token'],))
    db.execute("UPDATE containers SET status='paused'")
    body = observation(job)
    result = await client.post(monitor_url(managed, job, 'observe'), json=body)
    assert result.status_code == 200, result.text
    assert result.json()['outcome']['termination_verified']
    assert (await client.post(monitor_url(managed, job, 'observe'), json=body)).json() == result.json()
    assert (await client.post(monitor_url(managed, job, 'observe'), json={**body, 'result_digest':'c'*64})).status_code == 409
    assert len(db.execute('SELECT * FROM managed_job_outcomes')) == 1
    assert db.execute('SELECT status FROM worker_runs')[0]['status'] == 'exited'


async def test_handling_is_exact_and_uncertainty_does_not_hide_later_result(client, managed, db):
    await publish(client, managed)
    job = await reserve(client, managed)
    body = observation(job)
    unknown = {**body, 'state':'unknown', 'termination_verified':False, 'result_digest':None}
    first = await client.post(monitor_url(managed, job, 'observe'), json=unknown)
    assert first.status_code == 200, first.text
    poll_url = f"/api/tasks/{managed['tid']}/job-outcomes/poll"
    handling = f"/api/tasks/{managed['tid']}/job-outcomes/{job['job_id']}/handled"
    page = await client.post(poll_url, headers=managed['headers'])
    assert len(page.json()['outcomes']) == 1
    data = {'revision':1, 'disposition':'uncertainty_resolved', 'note':'Preserved the launch fence.'}
    handled = await client.post(handling, headers=managed['headers'], json=data)
    assert handled.status_code == 200, handled.text
    assert (await client.post(handling, headers=managed['headers'], json=data)).json() == handled.json()
    assert (await client.post(handling, headers=managed['headers'], json={**data,'note':'Changed'})).status_code == 409
    assert not (await client.post(poll_url, headers=managed['headers'])).json()['outcomes']
    cid = db.execute('SELECT container_id FROM agents WHERE id=%s', (managed['aid'],))[0]['container_id']
    registry = await client.get(f'/api/containers/{cid}/job-monitors')
    assert len(registry.json()['monitors']) == 1  # handled uncertainty still monitored
    final = await client.post(monitor_url(managed, job, 'observe'),
        json={**body, 'operation_id':str(uuid4()), 'expected_version':1,'checkpoint_version':2})
    assert final.status_code == 200, final.text
    assert final.json()['outcome']['revision'] == 2
    assert (await client.post(handling, headers=managed['headers'], json=data)).status_code == 409
    applied = {**data,'revision':2,'disposition':'applied','result_digest':'b'*64}
    assert (await client.post(handling, headers=managed['headers'], json={**applied,'result_digest':'c'*64})).status_code == 409
    assert (await client.post(handling, headers=managed['headers'], json=applied)).status_code == 200
    assert not (await client.get(f'/api/containers/{cid}/job-monitors')).json()['monitors']


async def test_checkpoint_registers_outcome_atomically_and_poll_does_not_handle(client, managed, db):
    await publish(client, managed)
    job = await reserve(client, managed)
    assert len(db.execute('SELECT * FROM managed_job_monitors')) == 1
    body = checkpoint_body(state='completed', termination_verified=True, result_digest='b'*64)
    saved = await client.post(url(managed, job, 'checkpoint'), headers=managed['headers'], json=body)
    assert saved.status_code == 200, saved.text
    assert db.execute('SELECT handled_at FROM managed_job_outcomes')[0]['handled_at'] is None
    for _ in range(2):
        response = await client.post(f"/api/tasks/{managed['tid']}/job-outcomes/poll", headers=managed['headers'])
        assert len(response.json()['outcomes']) == 1
    assert db.execute('SELECT handled_at FROM managed_job_outcomes')[0]['handled_at'] is None


async def test_continuation_capability_is_fixed_and_revocation_permanent(client, managed, db):
    await publish(client, managed)
    secret = 'a'*43
    body = dict(job_key=str(uuid4()), continuation_contract='readonly_single_process_v1', continue_after_exit=True,
                continuation_capability_digest=hashlib.sha256(secret.encode()).hexdigest())
    job = await reserve(client, managed, **body)
    path = monitor_url(managed, job, 'continuation-heartbeat')
    args = {'capability':secret, 'launch_nonce':job['launch_nonce']}
    assert (await client.post(path,json=args)).status_code == 200
    assert (await client.post(path,json={**args,'capability':'b'*43})).status_code == 403
    invalid=await client.post(path,json={**args,'capability':'private-short-fixture'})
    assert invalid.status_code==422 and 'private-short-fixture' not in invalid.text
    db.execute("UPDATE worker_runs SET status='exited',ended_at=now() WHERE run_id=%s",(managed['rid'],))
    response = await client.post(path,json=args)
    assert response.status_code == 200, response.text
    assert response.json()['mutations_allowed'] is False
    db.execute('UPDATE tasks SET start_hold=true WHERE id=%s',(managed['tid'],))
    assert (await client.post(path,json=args)).status_code == 409
    db.execute('UPDATE tasks SET start_hold=false WHERE id=%s',(managed['tid'],))
    assert (await client.post(path,json=args)).status_code == 409
    assert db.execute('SELECT revoked_at FROM managed_job_monitors')[0]['revoked_at']
    assert (await client.post(monitor_url(managed,job,'observe'),json=observation(job))).status_code == 200


async def test_monitor_openapi_and_public_payload_exclude_capabilities(client, managed, db):
    await publish(client, managed)
    await reserve(client, managed)
    cid = db.execute('SELECT container_id FROM agents WHERE id=%s',(managed['aid'],))[0]['container_id']
    response = await client.get(f'/api/containers/{cid}/job-monitors')
    assert response.status_code == 200, response.text
    for private in ['capability_digest','purpose','command','stdout','context_digest']:
        assert private not in response.text
    spec = (await client.get('/openapi.json')).json()
    paths = {p:m for p,m in spec['paths'].items() if '/job-monitors' in p or '/job-outcomes' in p}
    assert len(paths) == 8
    for methods in paths.values():
        for method in methods.values():
            assert method['responses']['200']['content']['application/json']['schema']['$ref']


async def finish_worker(client, m):
    response = await client.post(f"/api/runs/{m['rid']}/finish",json={'status':'exited','exit_code':0})
    assert response.status_code == 200, response.text
    response = await client.post(f"/api/agents/{m['aid']}/wake-ack",
        json={'run_id':m['rid'],'release_lease':True,'lane':'work','kind':'released'})
    assert response.status_code == 200, response.text


async def candidate(client, managed, db):
    cid = db.execute('SELECT container_id FROM agents WHERE id=%s',(managed['aid'],))[0]['container_id']
    response = await client.get(f'/api/containers/{cid}/wake-scan?cooldown=0&min_idle=0')
    assert response.status_code == 200, response.text
    return next(c for c in response.json()['candidates'] if c['agent_id']==managed['aid'])


@pytest.mark.parametrize('runtime',['claude','codex'])
async def test_completion_selects_original_task_and_locked_claim_once(client,managed,db,runtime):
    db.execute("UPDATE tasks SET autonomy='on' WHERE id=%s",(managed['tid'],))
    db.execute('UPDATE worker_runs SET runtime=%s WHERE run_id=%s',(runtime,managed['rid']))
    await publish(client,managed)
    job = await reserve(client,managed)
    await finish_worker(client,managed)
    done = await client.post(monitor_url(managed,job,'observe'),json=observation(job))
    assert done.status_code == 200, done.text
    c = await candidate(client,managed,db)
    assert c['should_wake'] and c['completion']
    assert c['context_task_id'] == managed['tid']
    assert c['completion']['job_id'] == job['job_id']
    claim_url = f"/api/agents/{managed['aid']}/wake-claim"
    data = {'completion':c['completion']}
    db.execute('UPDATE tasks SET start_hold=true WHERE id=%s',(managed['tid'],))
    assert not (await client.post(claim_url,json=data)).json()['claimed']
    assert db.execute('SELECT attempts FROM managed_job_outcomes')[0]['attempts']==0
    db.execute('UPDATE tasks SET start_hold=false WHERE id=%s',(managed['tid'],))
    import asyncio
    attempts = await asyncio.gather(client.post(claim_url,json=data),client.post(claim_url,json=data))
    assert sum(r.json()['claimed'] for r in attempts)==1
    assert db.execute('SELECT attempts FROM managed_job_outcomes')[0]['attempts']==1
    assert db.execute('SELECT handled_at FROM managed_job_outcomes')[0]['handled_at'] is None


async def test_yield_waits_are_per_job_and_guidance_remains_actionable(client,managed,db):
    db.execute("UPDATE tasks SET autonomy='on' WHERE id=%s",(managed['tid'],))
    await publish(client,managed)
    secret = 'a'*43
    options = dict(continuation_contract='readonly_single_process_v1',continue_after_exit=True,
        continuation_capability_digest=hashlib.sha256(secret.encode()).hexdigest())
    jobs = [await reserve(client,managed,**options) for _ in range(2)]
    for job in jobs:
        yielded = await client.post(monitor_url(managed,job,'yield'), headers=managed['headers'],
            json={'context_digest':'d'*64})
        assert yielded.status_code==200, yielded.text
    assert (await client.get(f"/api/runs/{managed['rid']}/job-wait")).json()['waiting']
    await finish_worker(client,managed)
    db.execute('UPDATE agents SET auto_wake_interval_secs=60 WHERE id=%s',(managed['aid'],))
    db.execute('UPDATE agent_wake_state SET last_woken_at=%s WHERE agent_id=%s',(db.ago(120),managed['aid']))
    c = await candidate(client,managed,db)
    assert not c['should_wake'], c['reason']
    await client.post(monitor_url(managed,jobs[0],'observe'),json=observation(jobs[0]))
    assert len(db.execute('SELECT * FROM managed_job_waits'))==1
    assert (await candidate(client,managed,db))['should_wake']


async def test_post_exit_stop_revokes_grant_without_reopening_run(client,managed,db,make_agent):
    await publish(client,managed)
    secret='a'*43
    job = await reserve(client,managed,continuation_contract='readonly_single_process_v1',continue_after_exit=True,
        continuation_capability_digest=hashlib.sha256(secret.encode()).hexdigest())
    await finish_worker(client,managed)
    human = (await make_agent('Owner',kind='human'))['agent_id']
    response = await client.post(f"/api/runs/{managed['rid']}/stop",json={'actor_agent_id':str(human)})
    assert response.status_code==200 and response.json()['stop_requested'], response.text
    assert db.execute('SELECT status FROM worker_runs')[0]['status']=='exited'
    monitor=db.execute('SELECT * FROM managed_job_monitors')[0]
    assert monitor['revoked_at'] and monitor['suppress_wake']
    assert (await client.post(monitor_url(managed,job,'observe'),json=observation(job))).status_code==200
    assert not (await candidate(client,managed,db))['completion']


@pytest.mark.parametrize('route',['run','job'])
async def test_post_exit_stop_refuses_prepared_transfer_heartbeat_and_adoption(client,managed,db,make_agent,route):
    from test_gh312_job_recovery import successor
    from test_gh312_job_transfer import prepared, observed, adoption
    job, secret, _, transfer = await prepared(client, managed)
    new = await successor(client, managed)
    await observed(client, managed, db)  # The source run has ended; its history stays exited.
    human = (await make_agent('Stop owner', kind='human'))['agent_id']
    target = (f"/api/runs/{managed['rid']}/stop" if route == 'run'
              else monitor_url(managed, job, 'stop'))
    response = await client.post(target, json={'actor_agent_id': str(human)})
    assert response.status_code == 200, response.text
    source = db.execute('SELECT status,stop_requested_at FROM worker_runs WHERE run_id=%s', (managed['rid'],))[0]
    assert source['status'] != 'running' and source['stop_requested_at'] is None
    heartbeat = await client.post(url(managed, job, 'transfer/heartbeat'), headers={'X-Orcha-Run-Token': secret})
    assert heartbeat.status_code == 409 and 'managed_transfer_stopped' in heartbeat.text, heartbeat.text
    adopted = await client.post(url(managed, job, 'transfer/adopt'), headers=new['headers'],
                                json=adoption(job, secret, transfer))
    assert adopted.status_code == 409 and 'managed_transfer_stopped' in adopted.text, adopted.text
    assert str(db.execute('SELECT owner_run_id FROM managed_jobs')[0]['owner_run_id']) == managed['rid']


@pytest.mark.parametrize('gate',['hold','revision','assignment','verification','stop','budget','project'])
async def test_stale_completion_claim_never_spends_attempt(client,managed,db,gate):
    db.execute("UPDATE tasks SET autonomy='on' WHERE id=%s",(managed['tid'],))
    await publish(client,managed)
    job=await reserve(client,managed)
    await finish_worker(client,managed)
    await client.post(monitor_url(managed,job,'observe'),json=observation(job))
    c=await candidate(client,managed,db)
    assert c['completion']
    if gate=='hold':
        db.execute('UPDATE tasks SET human_hold_by=%s WHERE id=%s',(managed['aid'],managed['tid']))
    elif gate=='revision':
        db.execute('UPDATE tasks SET work_revision=work_revision+1 WHERE id=%s',(managed['tid'],))
    elif gate=='assignment':
        db.execute("UPDATE agent_tasks SET assignment_status='done' WHERE task_id=%s",(managed['tid'],))
    elif gate=='verification':
        db.execute("UPDATE tasks SET status='needs_verification' WHERE id=%s",(managed['tid'],))
    elif gate=='stop':
        db.execute('UPDATE worker_runs SET stop_requested_at=now() WHERE run_id=%s',(managed['rid'],))
    elif gate=='budget':
        cid=db.execute('SELECT container_id FROM agents WHERE id=%s',(managed['aid'],))[0]['container_id']
        db.execute('INSERT INTO agent_budgets(agent_id,container_id,monthly_limit_usd) VALUES (%s,%s,0)',
                   (managed['aid'],cid))
    else:
        db.execute("UPDATE containers SET status='paused'")
    response=await client.post(f"/api/agents/{managed['aid']}/wake-claim",json={'completion':c['completion']})
    assert response.status_code==200 and not response.json()['claimed'],response.text
    assert db.execute('SELECT attempts FROM managed_job_outcomes')[0]['attempts']==0


async def test_three_unhandled_completion_runs_exhaust_without_event_fallback(client,managed,db,make_agent):
    await make_agent('Review owner',kind='human')
    db.execute("UPDATE tasks SET autonomy='on' WHERE id=%s",(managed['tid'],))
    await publish(client,managed)
    job=await reserve(client,managed)
    await finish_worker(client,managed)
    await client.post(monitor_url(managed,job,'observe'),json=observation(job))
    for attempt in range(3):
        db.execute('UPDATE managed_job_outcomes SET next_attempt_at=%s',(db.ago(1),))
        c=await candidate(client,managed,db)
        assert c['should_wake'] and c['completion']
        claim=await client.post(f"/api/agents/{managed['aid']}/wake-claim",json={'completion':c['completion']})
        assert claim.json()['claimed'],claim.text
        token=(await client.post(f"/api/agents/{managed['aid']}/embodiment-tokens",
            json={'lane':'work','kind':'headless'})).json()['run_token']
        run=(await client.post(f"/api/agents/{managed['aid']}/runs",json={'task_id':managed['tid'],
            'token_id':token,'wake_event':'managed_command_completion'})).json()
        await finish_worker(client,{**managed,'rid':run['run_id']})
        assert db.execute('SELECT attempts FROM managed_job_outcomes')[0]['attempts']==attempt+1
    c=await candidate(client,managed,db)
    assert not c['completion'] and not c['should_wake'],c['reason']
    for _ in range(2):
        response=await client.post(monitor_url(managed,job,'reconcile'))
        assert response.status_code==200,response.text
    requests=db.execute("SELECT * FROM requests WHERE originating_task_id=%s",(managed['tid'],))
    assert len(requests)==1
    assert db.execute('SELECT handled_at FROM managed_job_outcomes')[0]['handled_at'] is None


async def test_capacity_refusal_returns_attempt_without_relaxing_launch_bound(
        client, managed, db, service, tmp_path, monkeypatch):
    from orcha_cli import notifier, notifier_wake_worker
    db.execute("UPDATE tasks SET autonomy='on' WHERE id=%s", (managed['tid'],))
    await publish(client, managed)
    job = await reserve(client, managed)
    await finish_worker(client, managed)
    assert (await client.post(monitor_url(managed, job, 'observe'), json=observation(job))).status_code == 200
    refusals = []
    def full_host(*args, **kwargs):
        kwargs['spawn_info']['deferred'] = True
        refusals.append(True)
        return False, 'Host concurrency capacity is full', None
    monkeypatch.setattr(notifier, 'spawn_headless', full_host)
    for _ in range(3):
        db.execute('UPDATE managed_job_outcomes SET next_attempt_at=%s', (db.ago(1),))
        db.execute('UPDATE agent_wake_state SET wake_lease_until=%s', (db.ago(1),))
        c = await candidate(client, managed, db)
        assert c['completion'] and c['should_wake'], c
        c['headless_cwd'] = str(tmp_path)
        assert notifier_wake_worker.spawn(service[0], c, prompt='Inspect saved result.',
            event='managed_command_completion', dry_run=False, quiet=True, lease_ttl=120,
            live_workers={}, services=notifier) is None
    assert len(refusals) == 3
    assert not db.execute("SELECT 1 FROM worker_runs WHERE status='running'")
    assert db.execute('SELECT attempts FROM managed_job_outcomes')[0]['attempts'] == 0
    assert not db.execute('SELECT 1 FROM managed_job_wake_receipts')
    release = monitor_url(managed, job, 'unlaunched-wake')
    # A lost claim reply is returned once; a replay is a no-op.
    db.execute('UPDATE managed_job_outcomes SET next_attempt_at=%s', (db.ago(1),))
    db.execute('UPDATE agent_wake_state SET wake_lease_until=%s', (db.ago(1),))
    c = await candidate(client, managed, db)
    claim_url = f"/api/agents/{managed['aid']}/wake-claim"
    assert (await client.post(claim_url, json={'completion': c['completion']})).json()['claimed']
    assert (await client.post(release, json=c['completion'])).json() == {'released': True}
    assert (await client.post(release, json=c['completion'])).json() == {'released': False}
    assert db.execute('SELECT attempts FROM managed_job_outcomes')[0]['attempts'] == 0
    # Once a worker starts, the admission is a durable launch and is never returned.
    db.execute('UPDATE managed_job_outcomes SET next_attempt_at=%s', (db.ago(1),))
    db.execute('UPDATE agent_wake_state SET wake_lease_until=%s', (db.ago(1),))
    c = await candidate(client, managed, db)
    assert c['completion'], c
    assert (await client.post(claim_url, json={'completion': c['completion']})).json()['claimed']
    token = (await client.post(f"/api/agents/{managed['aid']}/embodiment-tokens",
        json={'lane': 'work', 'kind': 'headless'})).json()['run_token']
    run = await client.post(f"/api/agents/{managed['aid']}/runs", json={'task_id': managed['tid'],
        'token_id': token, 'wake_event': 'managed_command_completion'})
    assert run.status_code == 201, run.text
    assert (await client.post(release, json=c['completion'])).json() == {'released': False}
    assert db.execute('SELECT attempts FROM managed_job_outcomes')[0]['attempts'] == 1
    mismatched = {**c['completion'], 'job_id': str(uuid4())}
    assert (await client.post(release, json=mismatched)).status_code == 409


async def test_completion_while_worker_active_is_received_without_competitor(client,managed,db):
    db.execute("UPDATE tasks SET autonomy='on' WHERE id=%s",(managed['tid'],))
    await publish(client,managed)
    job=await reserve(client,managed)
    response=await client.post(monitor_url(managed,job,'observe'),json=observation(job))
    assert response.status_code==200
    c=await candidate(client,managed,db)
    assert c['completion'] and not c['should_wake']
    assert not (await client.post(f"/api/agents/{managed['aid']}/wake-claim",json={'completion':c['completion']})).json()['claimed']
    assert len((await client.post(f"/api/tasks/{managed['tid']}/job-outcomes/poll",headers=managed['headers'])).json()['outcomes'])==1
    await finish_worker(client,managed)
    assert (await candidate(client,managed,db))['should_wake']


@pytest.mark.parametrize('sender_kind', ['human', 'ai'])
async def test_only_human_prompt_changes_completion_to_directed_work(
        client, managed, db, make_agent, sender_kind):
    db.execute("UPDATE tasks SET autonomy='on' WHERE id=%s", (managed['tid'],))
    await publish(client, managed)
    job = await reserve(client, managed)
    await finish_worker(client, managed)
    await client.post(monitor_url(managed, job, 'observe'), json=observation(job))
    sender = (await make_agent('Instruction sender', kind=sender_kind))['agent_id']
    response = await client.post(f"/api/agents/{managed['aid']}/prompt", json={
        'from_agent_id': sender, 'message': 'Inspect the saved result and continue.'})
    assert response.status_code == 201, response.text
    wake = await candidate(client, managed, db)
    assert wake['should_wake'] and wake['context_task_id'] == managed['tid']
    assert bool(wake['completion']) is (sender_kind != 'human')
    assert db.execute('SELECT handled_at FROM managed_job_outcomes')[0]['handled_at'] is None


@pytest.mark.parametrize('unsupported', ['generic', 'container', 'resident'])
async def test_continuation_cannot_expand_to_unsupported_execution(client, managed, db, unsupported):
    await publish(client, managed)
    body = dict(job_key=str(uuid4()), continuation_contract='readonly_single_process_v1',
        continue_after_exit=True, continuation_capability_digest=hashlib.sha256(b'a'*43).hexdigest())
    if unsupported == 'generic':
        body['continuation_contract'] = 'stop_before_transfer'
    elif unsupported == 'container':
        db.execute("UPDATE worker_runs SET sandbox_container_id='disposable-container' WHERE run_id=%s",
                   (managed['rid'],))
    else:
        db.execute("UPDATE worker_runs SET wake_kind='resident' WHERE run_id=%s", (managed['rid'],))
    response = await client.post(f"/api/tasks/{managed['tid']}/managed-jobs",
        headers=managed['headers'], json=body)
    assert response.status_code in {409, 422}, response.text
    assert not db.execute('SELECT * FROM managed_jobs')
    assert not db.execute('SELECT * FROM managed_job_monitors')
