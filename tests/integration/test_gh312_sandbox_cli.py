"""Real container CLI/API acceptance; model tool selection is tested on the host."""

import asyncio
import json
import os
from pathlib import Path
import subprocess
import time

import pytest

from orcha_cli import sandbox
from test_gh312_job_supervisor import service
from test_gh312_managed_jobs import publish
from test_gh312_managed_messages import managed
from test_gh312_sandbox_lifecycle import available


pytestmark = pytest.mark.skipif(
    not available(), reason='Docker and the installed Orcha runner image are required',
)


async def until(read, seconds=30):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = read()
        if value:
            return value
        await asyncio.sleep(.1)
    raise AssertionError('Disposable container did not reach its expected step')


async def test_container_cli_receives_guidance_once_and_retains_result(
    client, managed, service, make_agent, db, tmp_path,
):
    human = (await make_agent('Container acceptance owner', kind='human'))['agent_id']
    name = sandbox.new_container_name()
    db.execute('UPDATE worker_runs SET sandbox_container_id=%s WHERE run_id=%s', (name, managed['rid']))
    await publish(client, managed, seconds=600, sandbox=580)
    await client.post(f"/api/agents/{managed['aid']}/wake-renew",
                      json={'lease_ttl': 600, 'run_id': managed['rid']})
    (tmp_path / '.claude').mkdir(mode=0o700)
    config = tmp_path / '.claude' / 'orcha.json'
    config.write_text(json.dumps({
        'api_base_url': service[0].replace('127.0.0.1', 'host.docker.internal'),
        'runtime': 'native',
    }))
    sandbox.ensure_agent_home(tmp_path)
    (tmp_path / 'slow.py').write_text(
        "import time\nwith open('launches','a') as f: f.write('once\\n')\n"
        "print('container command output',flush=True)\ntime.sleep(240)\n"
    )
    # Invoke the shipped CLI in the real runner, including subprocess pipes,
    # Docker-to-host HTTP, durable mounts and the Linux process guard. Only the
    # model's choice of tools is deterministic here; host tests use both models.
    (tmp_path / 'driver.py').write_text('''import json,subprocess,sys,time
from pathlib import Path
def call(*args):
    p=subprocess.run([sys.executable,'-m','orcha_cli','job','--task',sys.argv[1],*args],
                     capture_output=True,text=True,timeout=120)
    if p.returncode: raise RuntimeError('CLI acceptance call failed: '+args[0])
    return json.loads(p.stdout)
call('status')
args=('start','--key','container-acceptance','--purpose','Container acceptance',
      '--max-seconds','300','--',sys.executable,'slow.py')
job=call(*args)['job_id']
assert call(*args)['job_id']==job
Path('waiting').touch()
page=call('wait',job,'--seconds','100')
assert page['reason']=='guidance'
Path('delivered').touch()
message=page['messages'][0]['message_id']
Path('applied').write_text('once\\n')
call('handled',message,'--outcome','applied')
call('handled',message,'--outcome','applied')
call('stop',job)
end=time.monotonic()+20
while time.monotonic()<end:
    result=call('status',job)['jobs'][0]
    if result.get('termination_verified'):
        assert result['status']=='interrupted'
        Path('acceptance.json').write_text(json.dumps({'job_id':job,'status':result['status']}))
        break
    time.sleep(.1)
else: raise RuntimeError('Command did not stop')
''')
    argv = sandbox.build_docker_argv(
        ['env', 'PYTHONPATH=/orcha-test-source', 'python3', str(tmp_path / 'driver.py'), managed['tid']],
        cfg=sandbox.SandboxConfig(enabled=True), name=name, workspace=str(tmp_path),
        network='bridge', api_config_mount=str(config),
    )
    source = Path(__file__).resolve().parents[2] / 'orcha-cli'
    index = argv.index(sandbox.DEFAULT_IMAGE)
    argv[index:index] = ['--add-host', 'host.docker.internal:host-gateway',
                        '-v', f'{source}:/orcha-test-source:ro']
    log = tmp_path / 'private-driver.log'
    log.touch(mode=0o600)
    with log.open('wb') as output:
        process = subprocess.Popen(argv, env={**os.environ, 'ORCHA_RUN_TOKEN': managed['token']},
                                   stdout=output, stderr=subprocess.STDOUT)
    try:
        await until(lambda: (tmp_path / 'waiting').exists())
        await asyncio.sleep(18)
        posted_at = time.monotonic()
        response = await client.post(f"/api/tasks/{managed['tid']}/messages", json={
            'author_agent_id': human, 'body': 'Record this acceptance instruction once and stop the command.',
        })
        assert response.status_code == 201
        await until(lambda: (tmp_path / 'delivered').exists(), 15)
        latency = time.monotonic() - posted_at
        assert latency < 15
        await until(lambda: process.poll() is not None)
        assert process.returncode == 0, 'Inspect the private disposable-container log'
        assert (tmp_path / 'launches').read_text() == (tmp_path / 'applied').read_text() == 'once\n'
        receipts = db.execute('SELECT handled_at FROM managed_message_receipts WHERE message_id=%s',
                              (response.json()['message_id'],))
        assert len(receipts) == 1 and receipts[0]['handled_at'] is not None
        assert len(db.execute('SELECT job_id FROM managed_jobs WHERE task_id=%s', (managed['tid'],))) == 1
        result = json.loads((tmp_path / 'acceptance.json').read_text())
        directory = tmp_path / '.claude' / '.orcha-jobs' / result['job_id']
        original = (directory / 'result.json').read_bytes()
        sandbox.remove(name)
        assert sandbox.probe(name) is None
        assert (directory / 'result.json').read_bytes() == original
        assert (directory / 'stdout.log').read_text() == 'container command output\n'
        (tmp_path / 'acceptance.json').write_text(json.dumps({
            **result, 'guidance_delivery_seconds': latency, 'command_launches': 1,
            'handled_receipts': 1, 'guidance_applications': 1,
        }))
    finally:
        await client.post(f"/api/embodiment-tokens/{managed['token']}/revoke", json={})
        sandbox.remove(name, force=True)
        await asyncio.to_thread(process.wait, timeout=30)
