"""Container disposition uses inspected identity, never a missing Docker client.

These tests stub Docker only; private files, shutdown coordination, result
validation, task API and recovery publication use their real implementations.
"""

import json
import time
from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import uuid4

import pytest

from orcha_cli import job_sandbox, notifier_embodiment, sandbox
from orcha_cli.job_store import JobStore, JobStorageError, atomic_json, read_json
from orcha_cli.job_evidence import verified_result
from orcha_cli.job_recovery import recover_result
from orcha_cli.job_api import JobAPI
from orcha_cli.cli_job import current_job, summary
from test_gh312_job_supervisor import service
from test_gh312_managed_messages import managed
from test_gh312_managed_jobs import publish, reserve
from test_gh312_job_recovery import successor


def stamp(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat()


def setup_record(tmp_path, job=None):
    store = JobStore(tmp_path)
    now = time.time()
    job = job or {'job_id': str(uuid4()), 'task_id': str(uuid4()), 'owner_run_id': str(uuid4()),
                  'launch_nonce': str(uuid4())}
    record = store.reserve(job['job_id'], {
        **job, 'status': 'running', 'cwd': str(tmp_path),
        'container': {'name': 'orcha-run-test', 'id_prefix': 'a'*12,
                      'workspace': str(store.root.parent.parent), 'recorded_at': now},
    })
    payload = {'Id': 'a'*64, 'State': {'Status': 'running', 'Running': True, 'Paused': False,
               'Restarting': False, 'StartedAt': stamp(now-600), 'FinishedAt': stamp(0),
               'ExitCode': 0, 'OOMKilled': False},
               'Config': {'Labels': {'orcha.managed': '1', 'orcha.container_name': 'orcha-run-test'},
                          'Env': ['ORCHA_WORKSPACE_ROOT='+str(store.root.parent.parent),
                                  'PRIVATE_FIXTURE=never-persist']},
               'Mounts': [{'Type': 'bind', 'Source': str(store.root.parent.parent),
                           'Destination': str(store.root.parent.parent), 'RW': True}]}
    directory = store.job_directory(record['job_id'])
    (directory/'stdout.log').write_text('private output survives')
    return store, record, payload


def docker_boundary(payload, calls, *, fails_stop=False):
    def docker(argv, **kwargs):
        calls.append(argv)
        if argv[0] == 'inspect':
            return SimpleNamespace(returncode=0, stdout=json.dumps([payload]))
        if argv[0] == 'stop' and not fails_stop:
            payload['State'].update(Status='exited', Running=False, FinishedAt=stamp(time.time()), ExitCode=137)
        return SimpleNamespace(returncode=0, stdout='')
    return docker


@pytest.mark.parametrize('failure', ['running', 'paused', 'restarting', 'created', 'new_id', 'restart', 'wrong_mount', 'missing'])
def test_unverified_container_keeps_launch_fence(tmp_path, monkeypatch, failure):
    store, record, payload = setup_record(tmp_path)
    payload['State'].update(Status='exited', Running=False, FinishedAt=stamp(time.time()))
    if failure == 'running':
        payload['State'].update(Status='running', Running=True)
    elif failure in {'paused', 'restarting'}:
        payload['State'][failure.title()] = True
    elif failure == 'created':
        payload['State']['Status'] = 'created'
    elif failure == 'new_id':
        payload['Id'] = 'b'*64
    elif failure == 'restart':
        payload['State']['StartedAt'] = stamp(time.time()+1)
    elif failure == 'wrong_mount':
        payload['Mounts'][0]['Source'] = '/different-workspace'
    monkeypatch.setattr(sandbox, '_docker', docker_boundary(payload, []))
    evidence = job_sandbox.inspect_container('orcha-run-test', sandbox) if failure != 'missing' else None
    assert not job_sandbox.save_after_exit(evidence)
    assert not (store.job_directory(record['job_id'])/'result.json').exists()
    with store.locked():
        assert store.retains_worktree(tmp_path)


def test_completion_path_saves_before_stop_and_before_remove(tmp_path, monkeypatch):
    store, record, payload = setup_record(tmp_path)
    calls = []
    leaf = docker_boundary(payload, calls)
    directory = store.job_directory(record['job_id'])
    def checked(argv, **kwargs):
        if argv[0] == 'stop':
            assert (directory/'container-handoff.json').exists()
            assert argv[-1] == payload['Id']
        if argv[0] == 'rm':
            assert read_json(directory/'result.json')['termination_verified']
            assert '-f' not in argv and '-v' not in argv
        return leaf(argv, **kwargs)
    monkeypatch.setattr(sandbox, '_docker', checked)
    worker = {'run_id': record['owner_run_id'], 'base_cwd': str(tmp_path), 'sandbox_container_id': 'orcha-run-test'}
    notifier_embodiment.reap_sandbox_artifacts(worker, sandbox_mod=sandbox)
    result = read_json(directory/'result.json')
    assert result['status'] == 'interrupted' and result['exit_code'] is None
    assert result['signal'] is None  # Container exit 137 is not a command exit code.
    assert verified_result(directory, record, result)
    assert any(c[0] == 'rm' for c in calls)
    assert (directory/'stdout.log').read_text() == 'private output survives'
    assert all('never-persist' not in p.read_text() for p in directory.glob('*.json'))
    with store.locked():
        assert not store.retains_worktree(tmp_path)
    before = (directory/'result.json').read_bytes()
    evidence = job_sandbox.inspect_container('orcha-run-test', sandbox)
    assert job_sandbox.save_after_exit(evidence)
    assert (directory/'result.json').read_bytes() == before


@pytest.mark.parametrize('failure', ['stop_fails', 'name_reused', 'missing_launch_identity'])
def test_cleanup_refuses_unconfirmed_disposition(tmp_path, monkeypatch, failure):
    store, record, payload = setup_record(tmp_path)
    if failure == 'name_reused':
        payload['Id'] = 'b'*64
    elif failure == 'missing_launch_identity':
        record.pop('container')
        atomic_json(store.job_directory(record['job_id'])/'record.json', record)
    calls = []
    monkeypatch.setattr(sandbox, '_docker', docker_boundary(payload, calls, fails_stop=True))
    worker = {'run_id': record['owner_run_id'], 'base_cwd': str(tmp_path), 'sandbox_container_id': 'orcha-run-test'}
    notifier_embodiment.reap_sandbox_artifacts(worker, sandbox_mod=sandbox)
    assert worker['managed_disposition_unknown']
    assert not any(c[0] == 'rm' for c in calls)
    if failure != 'stop_fails':
        assert not any(c[0] == 'stop' for c in calls)


def test_rowless_orphan_saves_private_handoff_and_exit(tmp_path, monkeypatch):
    from orcha_cli import notifier_orphan_cleanup
    store, record, payload = setup_record(tmp_path)
    calls = []
    monkeypatch.setattr(sandbox, '_docker', docker_boundary(payload, calls))
    monkeypatch.setattr(sandbox, 'daemon_reachable', lambda: True)
    monkeypatch.setattr(sandbox, 'managed_containers', lambda cid: ['orcha-run-test'])
    services = SimpleNamespace(_get_json=lambda url: {'runs': []})
    assert notifier_orphan_cleanup.reap_orphaned_runs('http://unused', 'project', services=services) == 0
    directory = store.job_directory(record['job_id'])
    assert read_json(directory/'container-handoff.json')['saved_at'] < read_json(directory/'result.json')['finished_at']
    assert store.read(record['job_id'])['status'] == 'interrupted'
    assert not any(c[0] == 'rm' for c in calls)


def test_completed_guard_result_is_preserved_and_proof_tampering_refused(tmp_path, monkeypatch):
    store, record, payload = setup_record(tmp_path)
    payload['State'].update(Status='exited', Running=False, FinishedAt=stamp(time.time()))
    monkeypatch.setattr(sandbox, '_docker', docker_boundary(payload, []))
    evidence = job_sandbox.inspect_container('orcha-run-test', sandbox)
    directory = store.job_directory(record['job_id'])
    result = {k: record[k] for k in ('job_id', 'owner_run_id', 'launch_nonce')}
    result.update(status='completed', termination_verified=True, exit_code=0, signal=None, reason='command_exited')
    atomic_json(directory/'result.json', result)
    original = (directory/'result.json').read_bytes()
    assert job_sandbox.save_after_exit(evidence)
    assert (directory/'result.json').read_bytes() == original
    # A claimed container result with a different proof does not become trusted.
    altered = {**result, 'status': 'interrupted', 'exit_code': None, 'termination_source': 'container_exit',
               'container_evidence_digest': '0'*64}
    atomic_json(directory/'container-exit.json', evidence)
    assert not verified_result(directory, record, altered)


async def test_successor_imports_observed_container_exit_without_guessing_command_code(client, managed, service, tmp_path):
    await publish(client, managed)
    job = await reserve(client, managed)
    store, record, payload = setup_record(tmp_path, job)
    payload['State'].update(Status='exited', Running=False, FinishedAt=stamp(time.time()))
    evidence = job_sandbox.inspect_container('orcha-run-test', SimpleNamespace(_docker=docker_boundary(payload, [])))
    assert job_sandbox.save_after_exit(evidence)
    new = await successor(client, managed)
    api = JobAPI(service[0], new['token'], new['tid'])
    saved = recover_result(api, store, current_job(api, job['job_id']))
    assert saved['state'] == 'interrupted' and saved['termination_verified']
    assert summary(store, saved)['exit_code'] is None
    assert saved['launch_nonce'] == job['launch_nonce'] and saved['transfers_used'] == 0


def test_launch_refuses_non_durable_workspace_before_reserving(tmp_path, monkeypatch):
    store = JobStore(tmp_path)
    monkeypatch.setenv('ORCHA_SANDBOX_CONTAINER', 'orcha-run-test')
    monkeypatch.setenv('ORCHA_WORKSPACE_ROOT', '/different-root')
    monkeypatch.setattr(job_sandbox.sys, 'platform', 'linux')
    monkeypatch.setattr(job_sandbox.socket, 'gethostname', lambda: 'a'*12)
    with pytest.raises(JobStorageError):
        job_sandbox.launch_identity(store)


def test_linux_group_observation_needs_no_ps_and_fails_closed(tmp_path):
    from orcha_cli.job_identity import linux_group_live
    for pid, state, group in [(21, 'Z', 10), (22, 'S', 20)]:
        (tmp_path/str(pid)).mkdir()
        (tmp_path/str(pid)/'stat').write_text(f'{pid} (command with ) in name) {state} 1 {group} 0')
    assert linux_group_live(10, tmp_path) is False
    assert linux_group_live(20, tmp_path) is True
    (tmp_path/'23').mkdir()  # Enumeration may race a process's disappearance.
    assert linux_group_live(10, tmp_path) is False
    (tmp_path/'23'/'stat').write_text('unparseable')
    assert linux_group_live(10, tmp_path) is None


def test_deadline_sweep_cannot_stop_reused_container_name(tmp_path, monkeypatch):
    from collections import Counter
    from orcha_cli import notifier_orphan_cleanup
    store, record, payload = setup_record(tmp_path)
    payload['Id'] = 'b'*64
    payload['State']['StartedAt'] = stamp(time.time()-10000)
    calls = []
    monkeypatch.setattr(sandbox, '_docker', docker_boundary(payload, calls))
    monkeypatch.setattr(notifier_orphan_cleanup.notifier_managed_jobs, 'prepare', lambda *a, **k: False)
    worker = {'run_id': record['owner_run_id'], 'base_cwd': str(tmp_path), 'sandbox_container_id': 'orcha-run-test'}
    assert notifier_orphan_cleanup._reconcile_sandbox_run(
        'http://unused', worker, 'orcha-run-test', checkout_users=Counter(),
        unknown_checkout_users=0, services=SimpleNamespace()) == 0
    assert not any(c[0] == 'stop' for c in calls)
