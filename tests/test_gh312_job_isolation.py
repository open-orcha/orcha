"""Exercise the actual OS sandbox through the real command guard, not a label."""

import json
import os
import socket
import subprocess
import sys
from pathlib import Path

import pytest

from orcha_cli.cli_job import start_job, request_control
from orcha_cli.job_api import JobAPI
from orcha_cli.job_isolation import CONTRACT
from orcha_cli.job_store import JobStorageError, JobStore
from test_gh312_job_supervisor import service, eventually, result, running
from test_gh312_managed_messages import managed
from test_gh312_managed_jobs import publish, reserve


async def test_contract_is_immutable_and_container_cannot_claim_host_isolation(client, managed, db):
    await publish(client, managed)
    job = await reserve(client, managed, continuation_contract=CONTRACT)
    response = await client.post(f"/api/tasks/{managed['tid']}/managed-jobs", headers=managed['headers'],
                                 json={'job_key': job['job_key']})
    assert response.status_code == 409
    assert db.execute('SELECT continuation_contract FROM managed_jobs')[0]['continuation_contract'] == CONTRACT
    db.execute("UPDATE worker_runs SET sandbox_container_id='temporary-test-container' WHERE run_id=%s", (managed['rid'],))
    await publish(client, managed, seconds=1100, sandbox=1000)
    response = await client.post(f"/api/tasks/{managed['tid']}/managed-jobs", headers=managed['headers'],
                                 json={'job_key': job['job_key'], 'continuation_contract': CONTRACT})
    assert response.status_code == 409


async def test_unavailable_isolation_refuses_before_reserving(client, managed, service, tmp_path, monkeypatch, db):
    from orcha_cli import job_isolation
    await publish(client, managed)
    api = JobAPI(service[0], managed['token'], managed['tid'])
    monkeypatch.setattr(job_isolation, 'EXECUTABLE', str(tmp_path / 'unavailable'))
    with pytest.raises(JobStorageError, match='require'):
        start_job(api, JobStore(tmp_path), key='refused', purpose='Isolated test',
                  argv=['true'], cwd=tmp_path, isolate=True)
    assert db.execute('SELECT * FROM managed_jobs') == []


@pytest.mark.skipif(sys.platform != 'darwin', reason='Seatbelt contract is explicitly macOS only')
async def test_actual_isolation_denies_shared_effects_and_retains_private_output(client, managed, service, tmp_path):
    await publish(client, managed)
    store = JobStore(tmp_path)
    api = JobAPI(service[0], managed['token'], managed['tid'])
    shared = tmp_path / 'shared'
    shared.write_text('original')
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    listener.listen()
    unix = socket.socket(socket.AF_UNIX)
    # macOS sockaddr_un is short; keep the test socket out of pytest's long root.
    import tempfile
    with tempfile.TemporaryDirectory(prefix='job-socket-') as socket_dir:
        unix_path = str(Path(socket_dir) / 'sock')
        unix.bind(unix_path)
        unix.listen()
        victim = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(60)'])
        jid = None
        try:
            code = f'''import os,socket,subprocess,json,time
from pathlib import Path
scratch=Path(os.environ['ORCHA_JOB_SCRATCH'])
shared=Path({str(shared)!r})
denied=[]
def refuses(name,action):
    try: action()
    except OSError: denied.append(name)
    else: raise AssertionError(name+' was allowed')
assert shared.read_text()=='original'
refuses('shared write',lambda:shared.write_text('changed'))
refuses('network',lambda:socket.create_connection(('127.0.0.1',{listener.getsockname()[1]})))
def connect_unix():
    s=socket.socket(socket.AF_UNIX);s.connect({unix_path!r})
refuses('unix socket',connect_unix)
refuses('child process',lambda:subprocess.run(['/usr/bin/true'],check=True))
refuses('signal',lambda:os.kill({victim.pid},15))
refuses('hard link',lambda:os.link(shared,scratch/'hardlink'))
os.symlink(shared,scratch/'symlink')
refuses('symlink escape',lambda:(scratch/'symlink').write_text('changed'))
refuses('control file',lambda:(scratch.parent/'daemon-stop.json').write_text('changed'))
(scratch/'output.json').write_text(json.dumps(denied))
print('isolated result')
time.sleep(.3)
'''
            job = start_job(api, store, key='isolated', purpose='Private isolated check',
                            argv=[sys.executable, '-c', code], cwd=tmp_path, isolate=True)
            jid = job['job_id']
            saved = eventually(lambda: result(store, jid))
            assert saved['status'] == 'completed' and saved['exit_code'] == 0, saved
            assert saved['termination_verified']
            directory = store.job_directory(jid)
            denied = json.loads((directory/'scratch'/'output.json').read_text())
            assert len(denied) == 8
            assert shared.read_text() == 'original' and victim.poll() is None
            assert running(store, jid)['continuation_contract'] == CONTRACT
            assert store.read(jid)['continuation'] == CONTRACT
            assert 'isolated result' in (directory/'stdout.log').read_text()
            assert start_job(api, store, key='isolated', purpose='Retry', argv=['false'],
                             cwd=tmp_path, isolate=True)['job_id'] == jid
        finally:
            await client.post(f"/api/embodiment-tokens/{managed['token']}/revoke", json={})
            if jid:
                eventually(lambda: result(store, jid))
            victim.terminate()
            victim.wait(timeout=3)
            listener.close()
            unix.close()


@pytest.mark.skipif(sys.platform != 'darwin', reason='Seatbelt contract is explicitly macOS only')
async def test_isolated_command_is_still_stopped_by_current_guard(client, managed, service, tmp_path):
    await publish(client, managed)
    store = JobStore(tmp_path)
    api = JobAPI(service[0], managed['token'], managed['tid'])
    job = start_job(api, store, key='isolated-stop', purpose='Private isolated check', isolate=True,
                    argv=[sys.executable, '-c', 'import time;time.sleep(60)'], cwd=tmp_path)
    jid = job['job_id']
    try:
        eventually(lambda: running(store, jid))
        request_control(api, store, jid, 'stop')
        saved = eventually(lambda: result(store, jid))
        assert saved['termination_verified'] and saved['status'] == 'interrupted'
    finally:
        await client.post(f"/api/embodiment-tokens/{managed['token']}/revoke", json={})
        eventually(lambda: result(store, jid))
