"""Checkpoint replacement uses real admission, stop receipts and exact cleanup."""
import pathlib
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import main
from portal_backend import sql
from portal_backend.model_policy import DEFAULT_MODEL
from orcha_cli import notifier_checkpoint, notifier_workflow

RETIRED = 'claude-fable-5-1'

@pytest.mark.parametrize('model, failure', [(RETIRED, mode) for mode in ('spawn', 'deferred', 'lost', 'unusable', 'competing')] + [(DEFAULT_MODEL, 'spawn')])
async def test_failed_checkpoint_releases_the_new_claim(client, make_agent, make_task, db, monkeypatch, model, failure):
    aid = (await make_agent('CheckpointReview', 'engineer'))['agent_id']
    tid = (await make_task('Checkpoint review task', 'Review done', assignee_alias='CheckpointReview'))['task_id']
    db.execute('UPDATE agents SET model=%s WHERE id=%s', (model, aid))
    db.execute('INSERT INTO agent_wake_state(agent_id,wake_lease_until) VALUES (%s,%s)', (aid, sql.from_now(600)))
    response = await client.post(f'/api/agents/{aid}/runs', json={'wake_kind':'ephemeral', 'lane':'work', 'pid':123456789, 'task_id':tid})
    assert response.status_code == 201, response.text
    rid = response.json()['run_id']
    api = TestClient(main.app)
    calls = []
    def post(url, body, *args, **kwargs):
        r = api.post(url.replace('http://review',''), json=body)
        calls.append((url, body, r.status_code, r.json()))
        assert r.status_code < 300, (url,r.text)
        data = r.json()
        if url.endswith('/wake-claim'):
            assert data['claimed']
            if failure == 'competing':
                db.execute('UPDATE agent_wake_state SET wake_lease_until=%s WHERE agent_id=%s', (sql.ago(1), aid))
                competitor = api.post(f'/api/agents/{aid}/wake-claim', json={}).json()
                assert competitor['claimed']
            if failure in {'lost', 'competing'}:
                return None  # server committed; the launcher did not receive the response
            if failure == 'unusable':
                return {'claimed': True}
        return data
    def get(url, **kwargs):
        r = api.get(url.replace('http://review',''))
        return r.json() if r.status_code < 300 else None
    monkeypatch.setattr(notifier_workflow,'runner_post',post)
    process = SimpleNamespace(pid=123456789,returncode=0,poll=lambda:0)
    worker = {'proc':process,'run_id':rid,'agent_id':aid,'cap':1200,
              'task_worktree':False,'lane':'work','respawn_ctx':{'model':model,'model_runtime':'claude','task_id':tid}}
    live = {aid:worker}
    def failed_spawn(*args, **kwargs):
        if failure == 'deferred':
            kwargs['spawn_info']['deferred'] = True
        return False, 'simulated failed spawn', None
    services = SimpleNamespace(HARD_CAP_MIN_SECS=1200,HARD_CAP_RESPAWN_MAX=3,
        _post_json=post,_get_json=get,_kill_worker=lambda *a,**k:None,
        _capture_diff=lambda *a,**k:'',
        _finish_run=lambda api,rid,status,code,*a:bool(post(f'{api}/api/runs/{rid}/finish',{'status':status,'exit_code':code})),
        _reap_sandbox_artifacts=lambda *a:None,_revoke_or_defer=lambda *a:None,
        _mint_embodiment_token=lambda *a:None,_build_persona=lambda *a,**k:'',
        time=time,pathlib=pathlib,spawn_headless=failed_spawn,
        _teardown_worktree=lambda *a:None,_retire_headless=lambda api,live,aid:live.pop(aid,None))
    notifier_checkpoint.checkpoint_and_respawn('http://review',aid,worker,live,True,services)
    if failure in {'spawn', 'deferred'}:
        assert aid not in live
    else:
        assert worker['respawns'] == services.HARD_CAP_RESPAWN_MAX
    retry = await client.post(f'/api/agents/{aid}/wake-claim', json={})
    if failure == 'competing':
        assert not retry.json()['claimed']  # stale cleanup preserved the new claimant
        assert any(c[3].get('reason') == 'worker_owner_changed' for c in calls)
    else:
        assert retry.json()['claimed'], retry.json()  # immediate retry, never wait for TTL
    assert db.execute('SELECT model FROM agents WHERE id=%s', (aid,))[0]['model'] == DEFAULT_MODEL
