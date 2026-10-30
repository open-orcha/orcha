"""Real command processes, durable evidence and HTTP/DB authority boundaries."""

import asyncio
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
import uvicorn

from orcha_cli.cli_job import start_job, wait_for_job, request_control
from orcha_cli.job_api import JobAPI, JobAPIError, AuthorityClock
from orcha_cli.job_executor import minimal_environment
from orcha_cli.job_identity import same_process
from orcha_cli.job_store import JobStore, read_json
from orcha_cli.job_supervisor import module_environment
from test_gh312_managed_messages import managed
from test_gh312_managed_jobs import publish


def eventually(read, seconds=8):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = read()
        if value:
            return value
        time.sleep(0.05)
    raise AssertionError('Temporary command did not reach the expected state')


@pytest.fixture
def service():
    from portal_backend.application import app
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    server = uvicorn.Server(uvicorn.Config(app, log_level='error', lifespan='off'))
    thread = threading.Thread(target=lambda: server.run(sockets=[sock]), daemon=True)
    thread.start()
    eventually(lambda: server.started)
    yield f'http://127.0.0.1:{sock.getsockname()[1]}', server
    server.should_exit = True
    thread.join(timeout=4)
    sock.close()


@pytest.fixture
async def jobs(client, managed, tmp_path, service):
    await publish(client, managed, seconds=120)
    api = JobAPI(service[0], managed['token'], managed['tid'])
    store = JobStore(tmp_path)
    created = []
    def launch(code, key='operation'):
        job = start_job(api, store, key=key, purpose='Temporary acceptance command',
                        argv=[sys.executable, '-c', code], cwd=tmp_path, max_seconds=90)
        created.append(job['job_id'])
        return job['job_id']
    yield api, store, launch
    # Tear down only the disposable worker token. The real guards stop children.
    await client.post(f"/api/embodiment-tokens/{managed['token']}/revoke", json={})
    for jid in set(created):
        directory = store.job_directory(jid)
        eventually(lambda: (directory/'result.json').exists() or (directory/'guard-error.json').exists()
                   or store.read(jid)['status'] == 'unknown', seconds=18)


def result(store, jid):
    path = store.job_directory(jid) / 'result.json'
    return read_json(path) if path.exists() else None


def running(store, jid):
    path = store.job_directory(jid) / 'process.json'
    return read_json(path) if path.exists() else None


async def test_real_command_one_launch_private_result_and_control_environment(jobs, tmp_path, monkeypatch):
    api, store, launch = jobs
    monkeypatch.setenv('ORCHA_RUN_TOKEN', 'private-control-fixture')
    monkeypatch.setenv('AWS_SECRET_ACCESS_KEY', 'private-provider-fixture')
    code = "import os,time;open('launches','a').write('once\\n');print('private-log-fixture');assert 'ORCHA_RUN_TOKEN' not in os.environ;assert 'AWS_SECRET_ACCESS_KEY' not in os.environ;time.sleep(.4)"
    jid = launch(code)
    assert launch(code) == jid
    observed = eventually(lambda: result(store, jid))
    assert observed['exit_code'] == 0, observed
    assert observed['status'] == 'completed' and observed['termination_verified']
    assert (tmp_path/'launches').read_text() == 'once\n'
    assert launch(code) == jid
    eventually(lambda: store.read(jid)['status'] == 'completed')
    record = store.read(jid)
    assert record['result_saved'] and record['termination_verified']
    assert 'private-log-fixture' in (store.job_directory(jid)/'stdout.log').read_text()
    for path in store.root.rglob('*.json'):
        assert 'private-log-fixture' not in path.read_text()
        assert 'private-control-fixture' not in path.read_text()
        assert 'private-provider-fixture' not in path.read_text()
    with store.locked():
        assert not store.retains_worktree(tmp_path)


async def test_first_heartbeat_failure_retries_same_reservation_once(jobs, tmp_path, monkeypatch, db):
    from fastapi import HTTPException
    from portal_backend.application import app
    api, store, launch = jobs
    route = next(r for r in app.routes if getattr(r, 'path', '').endswith('/{jid}/heartbeat'))
    original = route.dependant.call
    def unavailable(*args, **kwargs):
        raise HTTPException(503, 'Temporary first-contact outage')
    monkeypatch.setattr(route.dependant, 'call', unavailable)
    code = "import time;open('launches','a').write('once');time.sleep(.2)"
    jid = launch(code)
    eventually(lambda: store.read(jid)['status'] == 'not_started')
    directory = store.job_directory(jid)
    assert not (directory / 'process.json').exists()
    assert not (tmp_path / 'launches').exists()
    original_record = store.read(jid)
    assert db.execute('SELECT version,state FROM managed_jobs') == [{'version': 0, 'state': 'reserved'}]
    monkeypatch.setattr(route.dependant, 'call', original)
    # A failure may still be releasing its controller lock; a bounded same-key
    # retry is safe, including concurrent callers after the service returns.
    eventually(lambda: (launch(code), store.read(jid)['status'] != 'not_started')[1])
    assert launch(code) == jid
    assert eventually(lambda: result(store, jid))['exit_code'] == 0
    assert (tmp_path / 'launches').read_text() == 'once'
    saved = store.read(jid)
    assert saved['launch_nonce'] == original_record['launch_nonce']
    assert saved['budget_until'] == original_record['budget_until']
    assert saved['launch_attempt'] != original_record['launch_attempt']


async def test_uncertain_launch_is_never_retried_from_missing_process_file(jobs, tmp_path, monkeypatch):
    from fastapi import HTTPException
    from portal_backend.application import app
    api, store, launch = jobs
    route = next(r for r in app.routes if getattr(r, 'path', '').endswith('/{jid}/checkpoint'))
    def unavailable(*args, **kwargs):
        raise HTTPException(503, 'Unknown checkpoint commit outcome')
    monkeypatch.setattr(route.dependant, 'call', unavailable)
    jid = launch("open('must-not-start','w').write('bad')")
    eventually(lambda: store.read(jid)['status'] == 'unknown')
    first = store.read(jid)
    assert not (store.job_directory(jid) / 'process.json').exists()
    assert launch("open('must-not-start','w').write('bad')") == jid
    assert store.read(jid)['launch_attempt'] == first['launch_attempt']
    assert not (tmp_path / 'must-not-start').exists()


async def test_wait_delivers_guidance_and_explicit_receipt_once(jobs, managed, client, db):
    api, store, launch = jobs
    jid = launch('import time;time.sleep(30)')
    eventually(lambda: running(store, jid))
    async def post_guidance():
        await asyncio.sleep(.4)
        response = await client.post(f"/api/tasks/{managed['tid']}/messages",
                                     json={'body': 'Check the output before continuing.'})
        assert response.status_code == 201
        return response.json()['message_id']
    before = time.monotonic()
    posted = asyncio.create_task(post_guidance())
    page = await asyncio.to_thread(wait_for_job, api, store, jid, 10)
    mid = await posted
    assert time.monotonic() - before < 15
    assert page['reason'] == 'guidance'
    assert page['messages'][0]['message_id'] == mid
    guidance = read_json(store.job_directory(jid)/'guidance.json')
    assert guidance['pending_messages'][0]['message_id'] == mid
    assert guidance['handled_position'] is None
    body = {'outcome': 'applied'}
    assert not api.request(f'managed-messages/{mid}/handled', body)['already_handled']
    assert api.request(f'managed-messages/{mid}/handled', body)['already_handled']
    assert len(db.execute('SELECT * FROM managed_message_receipts WHERE handled_at IS NOT NULL')) == 1
    request_control(api, store, jid, 'stop')
    assert eventually(lambda: result(store, jid))['status'] == 'interrupted'


async def test_handoff_keeps_declared_outputs_and_progress_without_log_contents(jobs, tmp_path):
    api, store, _ = jobs
    record = start_job(
        api, store, key='output-handoff', purpose='Check declared output',
        argv=[sys.executable, '-c', "print('private-output-sentinel',flush=True)"],
        cwd=tmp_path, ports=[8080], artifacts=['report.json'],
    )
    jid = record['job_id']
    saved = eventually(lambda: result(store, jid))
    assert saved['exit_code'] == 0
    checkpoint = read_json(store.job_directory(jid) / 'mechanical.json')
    assert checkpoint['ports'] == [8080] and checkpoint['artifacts'] == ['report.json']
    assert checkpoint['output_progress']['stdout']['bytes'] == len('private-output-sentinel\n')
    assert checkpoint['output_progress']['stdout']['modified_at'] > 0
    assert 'private-output-sentinel' not in json.dumps(checkpoint)
    # Retrying the same launch does not alter its original declarations.
    assert start_job(api, store, key='output-handoff', purpose='Retry', argv=['false'],
                     cwd=tmp_path, ports=[9090])['job_id'] == jid
    assert store.read(jid)['ports'] == [8080]


@pytest.mark.parametrize('metadata', [{'ports': [0]}, {'ports': [65536]},
                                    {'artifacts': ['../outside']}, {'artifacts': ['/outside']}])
def test_invalid_output_declarations_refused_before_reservation(tmp_path, metadata):
    class NoReservation:
        def request(self, *args, **kwargs):
            pytest.fail('Invalid declarations must not create a launch fence')
    with pytest.raises(ValueError):
        start_job(NoReservation(), JobStore(tmp_path), key='invalid', purpose='Invalid',
                  argv=['true'], cwd=tmp_path, **metadata)


async def test_supervisor_sigkill_pipe_guard_saves_then_stops(jobs):
    api, store, launch = jobs
    jid = launch('import time;time.sleep(30)')
    process = eventually(lambda: running(store, jid))
    supervisor = store.read(jid)['supervisor']
    assert same_process(supervisor)
    os.kill(supervisor['pid'], signal.SIGKILL)
    saved = eventually(lambda: result(store, jid))
    assert saved['reason'] == 'supervisor_disconnected'
    assert saved['termination_verified']
    assert not same_process(process['process'])
    checkpoint = read_json(store.job_directory(jid)/'mechanical.json')
    assert checkpoint['reason'] == 'supervisor_disconnected'
    assert checkpoint['saved_monotonic'] < time.monotonic()
    # A crashed controller leaves its launch fence; it never starts again.
    assert launch('raise SystemExit("must not run")') == jid


@pytest.mark.parametrize('cause', ['hold', 'revoke', 'owner'])
async def test_authority_loss_stops_original_group(jobs, managed, db, cause):
    api, store, launch = jobs
    jid = launch('import time;time.sleep(30)')
    process = eventually(lambda: running(store, jid))
    if cause == 'hold':
        db.execute('UPDATE tasks SET start_hold=true WHERE id=%s', (managed['tid'],))
    elif cause == 'revoke':
        db.execute('UPDATE embodiment_tokens SET revoked_at=now() WHERE run_token=%s', (managed['token'],))
    else:
        db.execute("UPDATE worker_runs SET status='orphaned' WHERE run_id=%s", (managed['rid'],))
    saved = eventually(lambda: result(store, jid))
    assert saved['termination_verified'] and saved['status'] == 'interrupted'
    assert not same_process(process['process'])
    with pytest.raises(JobAPIError):
        request_control(api, store, jid, 'checkpoint')


async def test_lease_lapse_keeps_existing_job_but_refuses_controls(jobs, managed, db):
    api, store, launch = jobs
    jid = launch('import time;time.sleep(30)')
    process = eventually(lambda: running(store, jid))
    db.execute('UPDATE agent_wake_state SET wake_lease_until=%s WHERE agent_id=%s', (db.ago(1), managed['aid']))
    with pytest.raises(JobAPIError):
        request_control(api, store, jid, 'stop')
    time.sleep(3)
    assert same_process(process['process'])
    assert not result(store, jid)
    assert not api.heartbeat(jid)['mutations_allowed']


async def test_unavailable_api_stops_at_last_confirmed_deadline(client, managed, tmp_path, service):
    await publish(client, managed, seconds=4)
    api = JobAPI(service[0], managed['token'], managed['tid'])
    store = JobStore(tmp_path)
    job = start_job(api, store, key='deadline', purpose='Temporary deadline check',
                    argv=[sys.executable, '-c', 'import time;time.sleep(30)'], cwd=tmp_path)
    jid = job['job_id']
    process = eventually(lambda: running(store, jid))
    service[1].should_exit = True
    saved = eventually(lambda: result(store, jid))
    assert saved['termination_verified']
    assert not same_process(process['process'])
    checkpoint = read_json(store.job_directory(jid)/'mechanical.json')
    assert checkpoint['saved_monotonic'] <= checkpoint['authority_until_monotonic'] + .2


def test_authority_clock_never_slides_fixed_cap(monkeypatch):
    now = datetime.now(timezone.utc)
    def stamp(seconds):
        return (now+timedelta(seconds=seconds)).isoformat()
    response = dict(run_id='run', job_id='job', token_valid=True, stop_requested=False,
                    on_hold=False, cancelled=False, server_time=stamp(0), authority_until=stamp(20),
                    run_until=stamp(30), sandbox_until=None, budget_until=stamp(40),
                    prepare_at=stamp(-40), mutations_allowed=True)
    monkeypatch.setattr(time, 'monotonic', lambda: 100)
    clock = AuthorityClock('run', 'job').confirm(response, 100)
    assert clock.until == 120 and clock.fixed == 130
    response.update(server_time=stamp(10), authority_until=stamp(200), run_until=stamp(300))
    clock.confirm(response, 110)
    assert clock.until == 130 and clock.fixed == 130
    with pytest.raises(JobAPIError):
        clock.confirm({**response, 'run_id': 'other'}, 111)


def test_transport_total_timeout_and_one_inflight_request():
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    class Slow(BaseHTTPRequestHandler):
        def do_POST(self):
            time.sleep(1)
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Slow)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    api = JobAPI(f'http://127.0.0.1:{server.server_port}', 'private-fixture', str(uuid4()), timeout=.1)
    before = time.monotonic()
    with pytest.raises(JobAPIError):
        api.request('managed-messages/poll')
    assert time.monotonic() - before < .3
    server.shutdown()
    server.server_close()


@pytest.mark.parametrize('runtime', ['claude', 'codex'])
async def test_actual_cli_wait_beyond_default_tool_duration_and_interrupted_wait(jobs, managed, tmp_path, service, db, runtime):
    api, store, launch = jobs
    db.execute('UPDATE worker_runs SET runtime=%s WHERE run_id=%s', (runtime, managed['rid']))
    (tmp_path / '.claude' / 'orcha.json').write_text(json.dumps({'api_base_url': service[0]}))
    jid = launch('import time;time.sleep(60)')
    process = eventually(lambda: running(store, jid))
    env = {**module_environment(), 'ORCHA_RUN_TOKEN': managed['token']}
    argv = [sys.executable, '-m', 'orcha_cli', 'job', '--task', managed['tid'],
            '--base-cwd', str(tmp_path), 'wait', jid, '--seconds', '12']
    first = subprocess.Popen(argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    time.sleep(.5)
    first.terminate()
    first.communicate(timeout=3)
    assert same_process(process['process'])
    before = time.monotonic()
    completed = await asyncio.to_thread(subprocess.run, argv, env=env, capture_output=True, timeout=16)
    assert completed.returncode == 0, completed.stderr.decode()
    assert 12 <= time.monotonic() - before < 16
    assert json.loads(completed.stdout)['reason'] == 'wait_complete'
    assert same_process(process['process'])
    request_control(api, store, jid, 'stop')


async def test_concurrent_starts_share_server_and_local_launch_fence(jobs, tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    api, store, launch = jobs
    # Every caller has its own bounded transport, just like separate CLI calls.
    def call(_):
        client = JobAPI(api.url.geturl(), api.token, api.task_id)
        return start_job(client, store, key='race', purpose='Concurrent launch test',
                         argv=[sys.executable, '-c', "import time;open('count','a').write('once\\n');time.sleep(.4)"],
                         cwd=tmp_path)
    with ThreadPoolExecutor(max_workers=4) as pool:
        starts = list(pool.map(call, range(4)))
    assert len({job['job_id'] for job in starts}) == 1
    saved = eventually(lambda: result(store, starts[0]['job_id']))
    assert saved['exit_code'] == 0
    assert (tmp_path/'count').read_text() == 'once\n'


async def test_crash_after_local_reservation_never_relaunches(jobs, tmp_path, monkeypatch):
    from orcha_cli import cli_job
    api, store, launch = jobs
    def failed_spawn(*args, **kwargs):
        raise OSError('simulated unavailable supervisor')
    args = dict(key='crash', purpose='Reservation crash check', argv=[sys.executable, '-c', 'raise SystemExit(99)'], cwd=tmp_path)
    with monkeypatch.context() as patch:
        patch.setattr(cli_job.subprocess, 'Popen', failed_spawn)
        with pytest.raises(OSError):
            start_job(api, store, **args)
    again = start_job(api, store, **args)
    assert again['status'] == 'reserved'
    assert not (store.job_directory(again['job_id'])/'launch-started').exists()


async def test_completed_leader_does_not_leave_descendant_running(jobs, tmp_path):
    api, store, launch = jobs
    jid = launch("import subprocess,sys,pathlib;p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)']);pathlib.Path('descendant').write_text(str(p.pid))")
    saved = eventually(lambda: result(store, jid))
    assert saved['termination_verified']
    from orcha_cli.job_identity import process_identity
    assert process_identity(int((tmp_path/'descendant').read_text())) is None


async def test_saved_pid_is_never_used_to_signal_unrelated_process(jobs, tmp_path):
    from orcha_cli.cli_job import summary
    from orcha_cli.job_identity import process_identity
    from orcha_cli.job_store import atomic_json
    api, store, launch = jobs
    jid = launch('import time;time.sleep(30)')
    eventually(lambda: running(store, jid))
    eventually(lambda: store.read(jid)['status'] == 'running'
               and store.read(jid)['server_version'] >= 2)
    unrelated = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(30)'])
    try:
        local = store.read(jid)
        local['supervisor'] = {**process_identity(unrelated.pid), 'boot': 'different-boot'}
        atomic_json(store.job_directory(jid)/'record.json', local)
        job = api.request('managed-jobs', method='GET')['jobs'][0]
        assert summary(store, job)['status'] == 'unknown'
        request_control(api, store, jid, 'stop')
        assert eventually(lambda: result(store, jid))['termination_verified']
        assert unrelated.poll() is None
    finally:
        unrelated.terminate()
        unrelated.wait(timeout=3)
