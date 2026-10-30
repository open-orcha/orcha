"""Opt-in acceptance against installed model programs and a disposable service.

Set ORCHA_TEST_LIVE_RUNTIMES=1 to use the locally authenticated Claude and Codex
programs. Logs stay in pytest's private temporary directory, never in outputs.
No production Orcha service, agent identity, database or task is used.
"""

import asyncio
import json
import os
from pathlib import Path
import shutil
import sys
import time

import pytest

from orcha_cli import notifier
from orcha_cli.job_guidance import startup_guidance
from orcha_cli.job_store import JobStore, read_json
from test_gh312_job_supervisor import service
from test_gh312_managed_jobs import publish
from test_gh312_managed_messages import managed


pytestmark = pytest.mark.skipif(
    os.environ.get('ORCHA_TEST_LIVE_RUNTIMES') != '1',
    reason='Opt in to actual locally authenticated Claude/Codex execution',
)


def trace_rows(path):
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines()]


async def until(read, seconds=150):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = read()
        if value:
            return value
        await asyncio.sleep(.1)
    raise AssertionError('Actual runtime did not reach the expected test step')


@pytest.mark.parametrize('runtime', ['claude', 'codex'])
@pytest.mark.parametrize('launch_mode', ['ordinary', 'workflow'])
async def test_actual_runtime_startup_wait_and_guidance(
    client, managed, service, make_agent, db, tmp_path, monkeypatch, runtime, launch_mode,
):
    assert shutil.which(runtime), f'{runtime} must be installed for this opt-in test'
    # Only this disposable test identity is inherited by the model program.
    for key in tuple(os.environ):
        if key.startswith(('ORCHA_', 'GH_', 'GITHUB_')):
            monkeypatch.delenv(key)
    monkeypatch.delenv('CLAUDECODE', raising=False)
    # The app's code-mode helper is adjacent to its real executable. A PATH
    # symlink without that sibling is not a complete CLI installation.
    if runtime == 'codex':
        monkeypatch.setenv('ORCHA_CODEX_EXEC', str(Path(shutil.which(runtime)).resolve()))
    workflow_launch = None
    if launch_mode == 'workflow':
        from portal_backend import workflow_service
        from test_workflow_local_launch import Project
        monkeypatch.setattr(workflow_service, 'WORKFLOWS_INTEGRATED', True)
        project = Project(client)
        await project.start('serial', [('check', project.ann, [])])
        launch = await project.reserve(project.ann, 'check')
        workflow_launch = {**launch, 'agent_id': project.ann, 'api_base': service[0]}
        managed = {'rid': launch['run_id'], 'aid': project.ann,
                   'tid': project.tasks['check'], 'token': None}
        human = project.owner
    else:
        await publish(client, managed, seconds=600)
        human = (await make_agent('Acceptance owner', kind='human'))['agent_id']
        await client.post(f"/api/agents/{managed['aid']}/wake-renew",
                          json={'lease_ttl': 600, 'run_id': managed['rid']})
    db.execute('UPDATE worker_runs SET runtime=%s WHERE run_id=%s', (runtime, managed['rid']))
    config_dir = tmp_path / '.claude'
    config_dir.mkdir(mode=0o700)
    (config_dir / 'orcha.json').write_text(json.dumps({'api_base_url': service[0], 'runtime': 'native'}))
    source = str(Path(__file__).resolve().parents[2] / 'orcha-cli')
    trace = tmp_path / 'tools.jsonl'
    trace.touch(mode=0o600)
    wrapper = tmp_path / 'orcha'
    # Record call/return timing only. Never persist the environment or raw args.
    wrapper.write_text(f'''#!{sys.executable}
import json,os,subprocess,sys,time
from pathlib import Path
args=sys.argv[1:]
action=next((a for a in args if a in ['status','start','wait','handled','stop']), 'other')
def record(**data):
    with open({str(trace)!r}, 'a') as f:
        f.write(json.dumps(dict(action=action,time=time.monotonic(),**data))+'\\n')
record(phase='start')
env=dict(os.environ, PYTHONPATH={source!r})
p=subprocess.run([sys.executable,'-m','orcha_cli',*args],env=env,capture_output=True,text=True)
try: result=json.loads(p.stdout)
except ValueError: result={{}}
record(phase='return',reason=result.get('reason'),exit_code=p.returncode)
sys.stdout.write(p.stdout);sys.stderr.write(p.stderr);sys.exit(p.returncode)
''')
    wrapper.chmod(0o700)
    (tmp_path / 'slow.py').write_text(
        "import time\nwith open('launches','a') as f: f.write('once\\n')\n"
        "print('acceptance command running',flush=True)\ntime.sleep(240)\n"
    )
    log = tmp_path / f'{runtime}.jsonl'
    log.touch(mode=0o600)
    flags = ('--setting-sources project --strict-mcp-config --mcp-config {"mcpServers":{}} '
             '--no-session-persistence --max-turns 16 --tools Bash,Read,Write'
             if runtime == 'claude' else '--ignore-user-config --ignore-rules --ephemeral')
    prompt = (
        'Run this isolated acceptance check only. Do not access other projects, agents, '
        'services, plugins or accounts. The startup guidance below describes the real CLI. '
        f'For this test replace bare orcha with the exact executable {wrapper}. '
        'Inspect status, then start one command with key runtime-acceptance and purpose '
        f'acceptance-check: {sys.executable} slow.py. Use --max-seconds 300. '
        'Call job wait with --seconds 100 and the enclosing tool settings from startup guidance. '
        'Guidance will arrive after at least 18 seconds in that wait. Keep polling the same '
        'shell session if the tool yields; do not replace it. Apply the received guidance '
        'once and record handled, then stop the job and inspect its saved terminal status. '
        'Finish with a short confirmation. Never print environment variables or credentials.'
    )
    sent, _, process = notifier.spawn_headless(
        str(tmp_path), prompt, flags, False, alias='Managed worker', runtime=runtime,
        system_prompt=startup_guidance(tmp_path, managed['tid']),
        run_token=managed['token'], log_path=log, workflow_launch=workflow_launch,
    )
    assert sent and process is not None
    store = JobStore(tmp_path)
    try:
        if workflow_launch:
            await until(lambda: db.execute('SELECT status FROM worker_runs WHERE run_id=%s',
                                            (managed['rid'],))[0]['status'] == 'running', 20)
            # The real inert bootstrap activates before exec. The notifier
            # publishes limits after that acknowledgment, just as in production.
            await publish(client, managed, seconds=600)
            managed['token'] = db.execute(
                'SELECT run_token FROM embodiment_tokens WHERE run_id=%s AND revoked_at IS NULL',
                (managed['rid'],),
            )[0]['run_token']
            row = db.execute('SELECT pid FROM worker_runs WHERE run_id=%s', (managed['rid'],))[0]
            assert row['pid'] == process.pid
        first_wait = await until(lambda: next((r for r in trace_rows(trace)
                                               if r['action'] == 'wait' and r['phase'] == 'start'), None))
        # Exceeds Codex's normal initial shell-tool yield. Receipt latency is
        # measured at the CLI return, separately from subsequent model reasoning.
        await asyncio.sleep(max(0, first_wait['time'] + 18 - time.monotonic()))
        posted_at = time.monotonic()
        response = await client.post(f"/api/tasks/{managed['tid']}/messages", json={
            'author_agent_id': human,
            'body': 'Append exactly one line, guidance-applied, to applied.txt in this test directory; '
                    'then record this message handled with outcome applied. Stop the managed command.',
        })
        assert response.status_code == 201
        mid = response.json()['message_id']
        delivered = await until(lambda: next((r for r in trace_rows(trace)
                                              if r['action'] == 'wait' and r.get('reason') == 'guidance'), None), 15)
        assert delivered['time'] - posted_at < 15
        assert delivered['time'] - first_wait['time'] >= 18
        await until(lambda: process.poll() is not None)
        assert process.returncode == 0, f'{runtime} exited unsuccessfully; inspect private test log'
        assert (tmp_path / 'launches').read_text() == 'once\n'
        assert (tmp_path / 'applied.txt').read_text() == 'guidance-applied\n'
        receipts = db.execute('SELECT * FROM managed_message_receipts WHERE message_id=%s', (mid,))
        assert len(receipts) == 1 and receipts[0]['handled_at'] is not None
        jobs = db.execute('SELECT job_id FROM managed_jobs WHERE task_id=%s', (managed['tid'],))
        assert len(jobs) == 1
        result_path = store.job_directory(str(jobs[0]['job_id'])) / 'result.json'
        await until(result_path.exists, 20)
        saved = read_json(result_path)
        assert saved['termination_verified'] and saved['status'] == 'interrupted'
        # No repeated command launch or parallel CLI wait during a yielded tool.
        rows = trace_rows(trace)
        assert len([r for r in rows if r['action'] == 'start' and r['phase'] == 'start']) == 1
        wait_open = False
        for row in rows:
            if row['action'] == 'wait':
                assert wait_open == (row['phase'] == 'return')
                wait_open = row['phase'] == 'start'
        if runtime == 'claude':
            calls = []
            for line in log.read_text().splitlines():
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if event.get('type') == 'assistant':
                    calls.extend(part.get('input', {}) for part in event.get('message', {}).get('content', [])
                                 if part.get('type') == 'tool_use' and part.get('name') == 'Bash')
            waits = [call for call in calls if ' wait ' in call.get('command', '')]
            assert waits and all(call.get('timeout', 0) >= 120000 for call in waits)
        from orcha_cli.job_store import atomic_json
        atomic_json(tmp_path / 'acceptance.json', {
            'runtime': runtime, 'launch_mode': launch_mode,
            'wait_seconds': delivered['time'] - first_wait['time'],
            'guidance_delivery_seconds': delivered['time'] - posted_at,
            'command_launches': 1, 'handled_receipts': 1, 'guidance_applications': 1,
            'terminal_status': saved['status'], 'termination_verified': saved['termination_verified'],
        })
    finally:
        # Revoke only the disposable credential; real supervisors stop commands.
        if managed['token']:
            await client.post(f"/api/embodiment-tokens/{managed['token']}/revoke", json={})
        if process.poll() is None:
            await asyncio.to_thread(notifier._kill_worker, process, graceful=True)
