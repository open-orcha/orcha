"""Guidance contract plus real CLI/API/storage seams, without detached processes.

The supervisor launch is captured, then a bounded foreground read-only leaf is
run explicitly. This tests operation identity and receipts, not OS containment
or whether a model follows the prose. All storage and the API DB are fixtures.
"""

import concurrent.futures
import hashlib
import io
import json
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest

from orcha_cli import cli_job
from orcha_cli.job_api import JobAPI, JobAPIError
from orcha_cli.job_guidance import startup_guidance
from orcha_cli.job_store import JobStore, atomic_json
from orcha_cli.notifier_wake_prompts import build_wake_prompt
from test_gh312_job_recovery import successor
from test_gh312_job_supervisor import service  # noqa: F401
from test_gh312_managed_jobs import checkpoint_body, publish, url
from test_gh312_managed_messages import managed  # noqa: F401


def assert_correction_guidance(text):
    # These are the worker-facing decision requirements, not implementation
    # snapshots: deleting the correction or any boundary must fail this check.
    for required in (
        'completed record cannot be relaunched',
        'corrected read-only check can be a distinct operation',
        'already-authorized work', 'verify the original completed failure and termination',
        'handle its exact outcome', 'intended check did not run',
        'no relevant side effects occurred', 'A failed exit alone is not that evidence',
        'Verify the corrected executable, paths or setup',
        'stable corrective key and the original job reference in private progress',
        'On restart, inspect and reuse that corrective key',
        'Keep the original terminal record and result unchanged',
        'No renewed human permission', 'live, uncertain, interrupted or exhausted',
        'successful or destructive work', 'budget resets', 'stop/hold or lost authority',
        'explicit human restriction', 'precise missing decision',
    ):
        assert required in text


def test_generated_correction_contract_preserves_private_evidence(tmp_path):
    tid, jid = str(uuid4()), str(uuid4())
    store = JobStore(tmp_path)
    store.reserve(jid, dict(task_id=tid, cwd=str(tmp_path), status='completed',
                           purpose='private purpose', command='private argv'))
    private_result = store.job_directory(jid) / 'result.json'
    private_result.write_text('private result')
    text = startup_guidance(tmp_path, tid)
    assert_correction_guidance(text)
    assert jid in text
    assert all(value not in text for value in ('private purpose', 'private argv', 'private result'))
    assert private_result.read_text() == 'private result'


@pytest.mark.parametrize('runtime', ['claude', 'codex'])
def test_wake_delivers_correction_and_preserves_plan_gates(tmp_path, monkeypatch, runtime):
    from orcha_cli import notifier_wake_worker
    from test_worktree_routing import _wake_services, _spawn, _Proc
    posts, spawned = [], []
    services = _wake_services(posts, spawned)
    tid = str(uuid4())
    candidate = dict(agent_id='agent-1', alias='builder', headless_cwd=str(tmp_path),
                     context_task_id=tid, pending_events=1, model_runtime=runtime,
                     task_autonomy='off', task_autonomy_revision=1)
    wake = build_wake_prompt(candidate)
    assert 'request human approval for your plan before implementation and for finished work' in wake
    assert "current approval records and thread" in wake
    assert 'existing valid human plan approval covers continued work' in wake
    assert 'Do not request the same permission again' in wake
    assert 'Changed scope, withdrawn approval or an explicit human restriction' in wake
    assert 'Dependencies, holds, scheduling, stop-work instructions' in wake
    services._provision_task_worktree = lambda *a: (str(tmp_path), 'fixture-branch')
    services._build_persona = lambda *a, **kw: wake
    monkeypatch.setattr(notifier_wake_worker, 'carry_previous_checkout', lambda *a, **kw: True)

    def spawn(*args, **kwargs):
        assert kwargs['runtime'] == runtime
        assert wake in kwargs['system_prompt']
        assert_correction_guidance(kwargs['system_prompt'])
        spawned.append(kwargs)
        return True, 'fixture worker', _Proc()

    services.spawn_headless = spawn
    assert _spawn(candidate, services)['sent']
    assert len(spawned) == 1


@pytest.mark.parametrize('runtime', ['claude', 'codex'])
def test_checkpoint_delivers_same_correction_contract(tmp_path, runtime):
    from orcha_cli.notifier_checkpoint import checkpoint_and_respawn
    from test_worktree_routing import _wake_services, _Proc
    posts, spawned = [], []
    services = _wake_services(posts, spawned)
    services.time = time
    services._get_json = lambda *a: {}
    services._kill_worker = lambda *a, **kw: None
    services._capture_diff = lambda *a: None
    services._finish_run = lambda *a: False
    tid = str(uuid4())
    worker = dict(proc=SimpleNamespace(pid=123, poll=lambda: 0), run_id='fixture-ended',
                  base_cwd=str(tmp_path), worktree=str(tmp_path), task_worktree=True,
                  respawn_ctx=dict(task_id=tid, model_runtime=runtime))

    def spawn(*args, **kwargs):
        assert kwargs['runtime'] == runtime
        assert_correction_guidance(kwargs['system_prompt'])
        spawned.append(kwargs)
        return True, 'fixture worker', _Proc()

    services.spawn_headless = spawn
    live = {}
    checkpoint_and_respawn('http://fixture.invalid', 'agent-1', worker, live, True, services)
    assert len(spawned) == 1 and live['agent-1']['respawns'] == 1


@pytest.fixture
def captured_supervisors(monkeypatch):
    configs = []

    class Input(io.BytesIO):
        def close(self):
            configs.append(json.loads(self.getvalue()))
            super().close()

    # Replace only this module's process leaf; the check below remains a real,
    # foreground subprocess with a finite timeout and the parent's process group.
    monkeypatch.setattr(cli_job, 'subprocess', SimpleNamespace(
        Popen=lambda *a, **kw: SimpleNamespace(stdin=Input()),
        PIPE=subprocess.PIPE, DEVNULL=subprocess.DEVNULL))
    return configs


async def complete_leaf(client, m, store, config):
    leaf = subprocess.run(config['argv'], cwd=config['cwd'], env=config['env'],
                          capture_output=True, timeout=5)
    jid = config['job_id']
    record = store.read(jid)
    result = dict(job_id=jid, launch_nonce=record['launch_nonce'],
                  owner_run_id=record['owner_run_id'], status='completed',
                  termination_verified=True, exit_code=leaf.returncode, signal=None,
                  reason='command_exited')
    directory = store.job_directory(jid)
    atomic_json(directory / 'result.json', result)
    digest = hashlib.sha256((directory / 'result.json').read_bytes()).hexdigest()
    response = await client.post(url(m, {'job_id': jid}, 'checkpoint'), headers=m['headers'],
        json=checkpoint_body(state='completed', termination_verified=True, result_digest=digest))
    assert response.status_code == 200, response.text
    store.update(jid, record['version'], dict(status='completed', termination_verified=True,
                                             result_saved=True, server_version=response.json()['version']))
    return leaf


@pytest.mark.parametrize('runtime', ['claude', 'codex'])
async def test_wrong_path_correction_restart_duplicate_receipts_preserve_original(
        client, managed, db, service, tmp_path, captured_supervisors, make_agent, runtime):
    await publish(client, managed)
    human = await make_agent('Plan owner', kind='human')
    posted = await client.post(f"/api/tasks/{managed['tid']}/messages", json={
        'author_agent_id': managed['aid'], 'body': 'Plan: read the fixture and report its contents.'})
    assert posted.status_code == 201 and posted.json()['plan_auto_approved'] is False
    approved = await client.post('/api/decisions', json={
        'subject_type': 'plan_approval', 'subject_id': managed['tid'], 'decision': 'approve',
        'actor_agent_id': human['agent_id'], 'target_agent_id': managed['aid']})
    assert approved.status_code == 201, approved.text
    approvals = db.execute('SELECT * FROM task_approval_records')
    assert len(approvals) == 1 and approvals[0]['actor_kind'] == 'human'
    db.execute('UPDATE worker_runs SET runtime=%s WHERE run_id=%s', (runtime, managed['rid']))
    api = JobAPI(service[0], managed['token'], managed['tid'])
    store = JobStore(tmp_path)
    target = tmp_path / 'verified-input.txt'
    target.write_text('read-only fixture')
    code = "from pathlib import Path; import sys; print(Path(sys.argv[1]).read_text())"

    def start(current, key, path):
        return cli_job.start_job(current, JobStore(tmp_path), key=key, purpose='Read fixture',
            argv=[sys.executable, '-c', code, str(path)], cwd=tmp_path)

    failed = start(api, 'read-input', tmp_path / 'wrong-input.txt')
    leaf = await complete_leaf(client, managed, store, captured_supervisors[0])
    assert leaf.returncode != 0 and b'FileNotFoundError' in leaf.stderr and not leaf.stdout
    original_dir = store.job_directory(failed['job_id'])
    original = [(original_dir / name).read_bytes() for name in ('record.json', 'result.json')]
    receipt = cli_job.handle_result(api, store, failed['job_id'], 1, 'applied', 'Observed wrong input path.')
    assert cli_job.handle_result(api, store, failed['job_id'], 1, 'applied', 'Observed wrong input path.') == receipt
    # Changed argv cannot reopen the original terminal operation.
    assert start(api, 'read-input', target)['exit_code'] == leaf.returncode
    assert len(captured_supervisors) == 1

    assert_correction_guidance(startup_guidance(tmp_path, managed['tid']))
    atomic_json(original_dir / 'context.json', {
        'completed_steps': ['Verified missing input; no intended read or side effects.'],
        'remaining_steps': [f"Correction for {failed['job_id']}: inspect read-input-corrected-path, then use its result."],
    })
    assert target.is_file() and Path(sys.executable).is_file()
    # Simultaneous duplicate requests share the real local and server fences.
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(start, JobAPI(service[0], managed['token'], managed['tid']),
                               'read-input-corrected-path', target) for _ in range(2)]
        corrections = [future.result(timeout=5) for future in futures]
    corrected = corrections[0]
    assert corrected['job_id'] != failed['job_id']
    assert corrections[1]['job_id'] == corrected['job_id']
    assert len(captured_supervisors) == 2
    leaf = await complete_leaf(client, managed, store, captured_supervisors[1])
    assert leaf.returncode == 0 and leaf.stdout.strip() == b'read-only fixture'

    newer = await successor(client, managed)
    resumed = JobAPI(service[0], newer['token'], newer['tid'])
    assert start(resumed, 'read-input-corrected-path', target)['exit_code'] == 0
    for _ in range(2):
        outcomes = resumed.request('job-outcomes/poll', {})['outcomes']
        assert [(x['job_id'], x['revision']) for x in outcomes] == [(corrected['job_id'], 1)]
    receipt = cli_job.handle_result(resumed, JobStore(tmp_path), corrected['job_id'], 1, 'applied', 'Used read result.')
    assert cli_job.handle_result(resumed, JobStore(tmp_path), corrected['job_id'], 1, 'applied', 'Used read result.') == receipt
    assert resumed.request('job-outcomes/poll', {})['outcomes'] == []
    assert len(captured_supervisors) == 2
    assert [(original_dir / name).read_bytes() for name in ('record.json', 'result.json')] == original
    assert len(db.execute('SELECT * FROM managed_jobs')) == 2
    assert len(db.execute('SELECT * FROM managed_job_outcomes WHERE handled_at IS NOT NULL')) == 2
    assert db.execute('SELECT * FROM requests') == []  # no product-generated approval request
    assert db.execute('SELECT * FROM task_approval_records') == approvals


@pytest.mark.parametrize('state', ['unknown', 'interrupted', 'exhausted', 'completed'])
async def test_guidance_does_not_reopen_terminal_or_uncertain_operations(
        client, managed, service, tmp_path, captured_supervisors, state):
    await publish(client, managed)
    api = JobAPI(service[0], managed['token'], managed['tid'])
    store = JobStore(tmp_path)
    args = dict(key='existing-operation', purpose='Fence fixture', argv=[sys.executable, '-V'], cwd=tmp_path)
    first = cli_job.start_job(api, store, **args)
    store.update(first['job_id'], 0, {'status': state})
    before = (store.job_directory(first['job_id']) / 'record.json').read_bytes()
    for _ in range(2):
        assert cli_job.start_job(api, JobStore(tmp_path), **args)['job_id'] == first['job_id']
    assert len(captured_supervisors) == 1
    assert (store.job_directory(first['job_id']) / 'record.json').read_bytes() == before


@pytest.mark.parametrize('gate', ['hold', 'stop', 'revoke', 'deadline'])
async def test_distinct_correction_still_requires_current_authority(
        client, managed, db, service, tmp_path, captured_supervisors, gate):
    await publish(client, managed)
    if gate == 'hold':
        db.execute('UPDATE tasks SET start_hold=true WHERE id=%s', (managed['tid'],))
    elif gate == 'stop':
        db.execute('UPDATE worker_runs SET stop_requested_at=now() WHERE run_id=%s', (managed['rid'],))
    elif gate == 'revoke':
        db.execute('UPDATE embodiment_tokens SET revoked_at=now() WHERE run_token=%s', (managed['token'],))
    else:
        db.execute('UPDATE managed_run_limits SET run_until=%s', (db.ago(1),))
    with pytest.raises(JobAPIError):
        cli_job.start_job(JobAPI(service[0], managed['token'], managed['tid']), JobStore(tmp_path),
            key='corrected-path', purpose='Read-only correction', argv=[sys.executable, '-V'], cwd=tmp_path)
    assert captured_supervisors == []
    assert db.execute('SELECT * FROM managed_jobs') == []
