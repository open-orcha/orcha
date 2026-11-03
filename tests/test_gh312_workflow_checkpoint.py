"""Real workflow stop -> continuation -> inert bootstrap, with model leaf replaced."""

import json
import pathlib
import subprocess
import sys
import time
from types import SimpleNamespace

import httpx
import pytest

from orcha_cli.job_api import JobAPI
from orcha_cli.job_store import JobStore
from orcha_cli.cli_job import start_job
from orcha_cli.notifier_reaper import reap_workers
from orcha_cli import notifier_workflow, workflow_bootstrap
from test_gh312_job_supervisor import service, eventually, result, running
from test_gh312_managed_jobs import publish
from test_gh312_notifier_jobs import worker_record
from test_workflow_local_launch import Project


@pytest.mark.parametrize('runtime,hold,forced', [('claude', False, False), ('codex', False, True), ('codex', True, False)])
async def test_workflow_checkpoint_uses_confirmed_exit_and_bootstrap_not_legacy_token(client, db, monkeypatch, service, tmp_path, runtime, hold, forced):
    from portal_backend import workflow_service as ws
    monkeypatch.setattr(ws, 'WORKFLOWS_INTEGRATED', True)
    project = Project(client)
    await project.start('serial', [('build', project.ann, [])])
    db.execute("UPDATE tasks SET autonomy='on' WHERE id=%s", (project.tasks['build'],))
    launch = await project.reserve(project.ann, 'build')
    activation = await project.activate(project.ann, launch)
    old = {'aid':project.ann, 'tid':project.tasks['build'], 'rid':launch['run_id'],
           'token':activation['run_token'], 'headers':{'X-Orcha-Run-Token':activation['run_token']}}
    await publish(client, old, seconds=120)
    store = JobStore(tmp_path)
    api = JobAPI(service[0], old['token'], old['tid'])
    # This command finishes before the checkpoint; a still-running one is
    # retained (see the next test) and pauses automatic continuation instead.
    jid = start_job(api, store, key='workflow-command', purpose='Workflow check', cwd=tmp_path,
                    argv=[sys.executable, '-c', 'print("workflow check done")'])['job_id']
    child = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(60)'])
    children = [child]
    db.execute('UPDATE worker_runs SET pid=%s WHERE run_id=%s', (child.pid, old['rid']))
    worker = worker_record(old, store, proc=child, hard_deadline=time.time()+60, cap=120,
                           agent_id=old['aid'], respawns=0, workflow=True,
                           workflow_generation=launch['generation'], run_token=None)
    worker['respawn_ctx']['model_runtime'] = runtime
    worker['respawn_ctx']['alias'] = 'workflow-test'
    live = {old['aid']:worker}
    with httpx.Client(timeout=5) as http:
        def post(url, body):
            response = http.post(url, json=body)
            assert response.status_code < 300, response.text
            return response.json()
        def kill(proc, **kwargs):
            assert (store.job_directory(jid)/'handoff.json').exists()
            assert result(store, jid)['status'] == 'completed'
            assert not (store.job_directory(jid)/'daemon-stop.json').exists()
            (proc.kill if forced else proc.terminate)()
            proc.wait(timeout=3)
            if hold:
                db.execute('UPDATE tasks SET start_hold=true WHERE id=%s', (old['tid'],))
        from orcha_cli.notifier_checkpoint import checkpoint_and_respawn
        services = SimpleNamespace(
            _post_json=post, _get_json=lambda url:http.get(url).json(),
            _kill_worker=kill, _capture_diff=lambda cwd:'',
            _finish_run=lambda base,rid,status,code,*a,**kw:post(base+f'/api/runs/{rid}/finish', {'status':status,'exit_code':code, **kw}),
            _build_persona=lambda *a,**kw:'Worker context',
            time=time, pathlib=pathlib, HARD_CAP_MIN_SECS=120, HARD_CAP_RESPAWN_MAX=3,
            WAKE_LEASE_TTL_SECS=180, _pump_one=lambda *a:None)
        services._checkpoint_and_respawn = lambda base,aid,w,live,quiet: checkpoint_and_respawn(base,aid,w,live,quiet,services)
        try:
            eventually(lambda: result(store, jid))
            eventually(lambda: db.execute('SELECT state FROM managed_jobs WHERE job_id=%s',
                                          (jid,))[0]['state'] not in ('reserved', 'running'))
            # With no unsettled command there is no early handoff; this is the cap itself.
            services._checkpoint_and_respawn(service[0], old['aid'], worker, live, True)
            assert result(store, jid)['status'] == 'completed'
            observations = db.execute('SELECT * FROM worker_stop_observations WHERE run_id=%s', (old['rid'],))
            assert len(observations) == 1 and observations[0]['generation'] == launch['generation']
            schedules = db.execute('SELECT * FROM agent_self_wake WHERE agent_id=%s', (old['aid'],))
            assert worker['workflow_checkpoint_finished']
            assert live[old['aid']] is worker  # Normal completion retires it; no immediate spawn.
            if hold:
                assert not schedules
                assert len(db.execute('SELECT * FROM worker_runs WHERE agent_id=%s', (old['aid'],))) == 1
            else:
                assert len(schedules) == 1 and str(schedules[0]['auto_continue_run_id']) == old['rid']
                # Advance only the disposable schedule, then use the real normal
                # continuation adapter and bootstrap, replacing the model leaf.
                db.execute('UPDATE agent_self_wake SET resume_at=%s WHERE id=%s', (db.ago(1), schedules[0]['id']))
                candidate = {'agent_id':old['aid'], 'context_task_id':old['tid'],
                             'workflow_continue_run_id':old['rid'], 'automatic_schedule_id':str(schedules[0]['id'])}
                next_launch = notifier_workflow.reserve_candidate(service[0], candidate)
                assert next_launch and next_launch['generation'] > launch['generation']
                config = {**next_launch, 'command':[sys.executable, '-c', 'import time;time.sleep(60)']}
                proc = subprocess.Popen([sys.executable, str(pathlib.Path(workflow_bootstrap.__file__).resolve())],
                                         stdin=subprocess.PIPE, text=True)
                children.append(proc)
                proc.stdin.write(json.dumps(config)); proc.stdin.close()
                eventually(lambda: db.execute('SELECT status FROM worker_runs WHERE run_id=%s',
                                               (next_launch['run_id'],))[0]['status'] == 'running')
                assert len(db.execute('SELECT * FROM managed_jobs')) == 1
                permits = db.execute('SELECT operation_key FROM workflow_launch_permits WHERE run_id=%s', (next_launch['run_id'],))
                assert permits[0]['operation_key'] == 'auto-continue:' + old['rid']
                assert not db.execute('SELECT * FROM agent_self_wake WHERE agent_id=%s', (old['aid'],))
        finally:
            for proc in children:
                if proc.poll() is None:
                    proc.terminate(); proc.wait(timeout=3)
            db.execute('UPDATE worker_runs SET stop_requested_at=%s', (db.ago(0),))
            eventually(lambda: result(store, jid), seconds=12)


async def test_workflow_checkpoint_keeps_running_command_and_wakes_step_on_completion(client, db, monkeypatch, service, tmp_path):
    from portal_backend import workflow_service as ws
    from portal_backend import workflow_continuation
    from test_gh388_job_monitors import candidate
    monkeypatch.setattr(ws, 'WORKFLOWS_INTEGRATED', True)
    monkeypatch.setattr(workflow_continuation, 'DELAY_SECONDS', 0)
    project = Project(client)
    await project.start('serial', [('build', project.ann, [])])
    db.execute("UPDATE tasks SET autonomy='on' WHERE id=%s", (project.tasks['build'],))
    launch = await project.reserve(project.ann, 'build')
    activation = await project.activate(project.ann, launch)
    old = {'aid':project.ann, 'tid':project.tasks['build'], 'rid':launch['run_id'],
           'token':activation['run_token'], 'headers':{'X-Orcha-Run-Token':activation['run_token']}}
    await publish(client, old, seconds=120)
    store = JobStore(tmp_path)
    api = JobAPI(service[0], old['token'], old['tid'])
    finish = tmp_path/'finish'
    code = (f"import time;from pathlib import Path\nwhile not Path({str(finish)!r}).exists():time.sleep(.05)\n"
            "print('12 passed')")
    jid = start_job(api, store, key='workflow-tests', purpose='Workflow test run', cwd=tmp_path,
                    argv=[sys.executable, '-c', code])['job_id']
    child = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(60)'])
    db.execute('UPDATE worker_runs SET pid=%s WHERE run_id=%s', (child.pid, old['rid']))
    worker = worker_record(old, store, proc=child, hard_deadline=time.time()+60, cap=120,
                           agent_id=old['aid'], respawns=0, workflow=True,
                           workflow_generation=launch['generation'], run_token=None)
    live = {old['aid']:worker}
    with httpx.Client(timeout=5) as http:
        def post(url, body):
            response = http.post(url, json=body)
            assert response.status_code < 300, response.text
            return response.json()
        def kill(proc, **kwargs):
            assert not (store.job_directory(jid)/'daemon-stop.json').exists()
            assert not result(store, jid)
            proc.terminate()
            proc.wait(timeout=3)
        from orcha_cli.notifier_checkpoint import checkpoint_and_respawn
        services = SimpleNamespace(
            _post_json=post, _get_json=lambda url:http.get(url).json(),
            _kill_worker=kill, _capture_diff=lambda cwd:'',
            _finish_run=lambda base,rid,status,code,*a,**kw:post(base+f'/api/runs/{rid}/finish', {'status':status,'exit_code':code, **kw}),
            _build_persona=lambda *a,**kw:'Worker context',
            time=time, pathlib=pathlib, HARD_CAP_MIN_SECS=120, HARD_CAP_RESPAWN_MAX=3,
            WAKE_LEASE_TTL_SECS=180, _pump_one=lambda *a:None)
        services._checkpoint_and_respawn = lambda base,aid,w,live,quiet: checkpoint_and_respawn(base,aid,w,live,quiet,services)
        try:
            process = eventually(lambda: running(store, jid))
            reap_workers(service[0], live, True, 300, {}, {}, services)  # Unsettled command: early checkpoint.
            assert worker['workflow_checkpoint_finished']
            assert running(store, jid) == process and not result(store, jid)
            monitor = db.execute('SELECT * FROM managed_job_monitors WHERE job_id=%s', (jid,))[0]
            assert not monitor['revoked_at'] and not monitor['stop_reason']
            # The step waits for its command instead of starting a duplicate continuation.
            assert not db.execute('SELECT * FROM agent_self_wake WHERE agent_id=%s', (old['aid'],))
            # Cross several supervisor check-ins after the step's credential is retired.
            time.sleep(5)
            assert running(store, jid) == process and not result(store, jid)
            finish.write_text('finish')
            saved = eventually(lambda: result(store, jid), seconds=12)
            assert saved['status'] == 'completed' and saved['exit_code'] == 0
            assert '12 passed' in (store.job_directory(jid)/'stdout.log').read_text()
            eventually(lambda: db.execute('SELECT * FROM managed_job_outcomes'), seconds=8)
            c = await candidate(client, {'aid': old['aid']}, db)
            assert c['should_wake'] and c['completion'] and c['context_task_id'] == old['tid']
        finally:
            if child.poll() is None:
                child.terminate(); child.wait(timeout=3)
            if not result(store, jid):
                finish.write_text('finish')
            eventually(lambda: result(store, jid), seconds=12)


async def test_managed_workflow_checkpoints_keep_existing_durable_automatic_limit(client, monkeypatch):
    from test_workflow_continuation import setup, finish, resume, row
    from test_gh312_managed_jobs import reserve
    project, current = await setup(client)
    for attempt in range(4):
        owner = {'aid':project.ann, 'tid':project.tasks['design'], 'rid':current['run_id'],
                 'headers':{'X-Orcha-Run-Token':current['token']}}
        await publish(client, owner)
        await reserve(client, owner)
        await finish(project, current, status='killed', exit_code=-15,
                     kill_reason=json.dumps({'cause':'managed_checkpoint'}))
        if attempt < 3:
            assert row(project)
            current = await resume(project, current, monkeypatch)
        else:
            assert row(project) is None
            from portal_backend.database import db_cursor
            with db_cursor() as (_, cur):
                cur.execute("SELECT COUNT(*) AS n FROM requests WHERE requester_id=%s AND status='open'", (project.ann,))
                assert cur.fetchone()['n'] == 1
