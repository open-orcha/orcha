"""Real container/guard shutdown with a durable, path-identical workspace.

Uses an already-installed Orcha runner image; never starts Docker or pulls an
image. Only the disposable container created by each test may be removed.
"""

from pathlib import Path
import subprocess
import time
from uuid import uuid4

import pytest

from orcha_cli import job_sandbox, sandbox
from orcha_cli.job_store import JobStore, read_json


def available():
    return (sandbox.daemon_reachable()
            and sandbox._docker(['image', 'inspect', sandbox.DEFAULT_IMAGE], timeout=10).returncode == 0)


pytestmark = pytest.mark.skipif(not available(), reason='Docker and the installed Orcha runner image are required')


def eventually(read, seconds=30):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = read()
        if value:
            return value
        time.sleep(.1)
    raise AssertionError('Disposable container did not reach its expected state')


@pytest.mark.parametrize('finish', [False, True])
def test_guard_output_survives_actual_container_shutdown(tmp_path, finish):
    store = JobStore(tmp_path)
    job_id, run_id, nonce = (str(uuid4()) for _ in range(3))
    store.reserve(job_id, {'task_id': str(uuid4()), 'owner_run_id': run_id,
                          'launch_nonce': nonce, 'status': 'running', 'cwd': str(tmp_path)})
    directory = store.job_directory(job_id)
    # The guard itself runs in the real container. No API/token is needed for
    # this test of Docker exit and filesystem durability, which complement the
    # API/supervisor acceptance tests in test_gh312_job_sandbox.py.
    script = '''import os,sys,time
from orcha_cli.job_store import JobStore
from orcha_cli.job_sandbox import launch_identity
from orcha_cli.job_executor import run
store = JobStore(os.getcwd())
record = store.read(sys.argv[1])
store.update(sys.argv[1], record['version'], {'container': launch_identity(store)})
run({'base_cwd': os.getcwd(), 'cwd': os.getcwd(), 'job_id': sys.argv[1],
     'owner_run_id': sys.argv[2], 'launch_nonce': sys.argv[3],
     'until': time.monotonic()+120, 'prepare': time.monotonic()+60,
     'env': {'PATH': '/usr/bin:/bin'},
     'argv': [sys.executable, '-c', "import time;print('durable output',flush=True);open('started','w').write('once');time.sleep("+sys.argv[4]+")"]})
'''
    (tmp_path/'guard_test.py').write_text(script)
    cfg = tmp_path/'api.json'
    cfg.write_text('{}')
    source = Path(__file__).resolve().parents[2]/'orcha-cli'
    name = sandbox.new_container_name()
    argv = sandbox.build_docker_argv(
        ['env', 'PYTHONPATH=/orcha-test-source', 'python3', str(tmp_path/'guard_test.py'),
         job_id, run_id, nonce, '.1' if finish else '300'],
        cfg=sandbox.SandboxConfig(enabled=True), name=name, workspace=str(tmp_path),
        network='none', api_config_mount=str(cfg), interactive=True)
    # Mount source read-only before the image argument. Test only disposable data.
    index = argv.index(sandbox.DEFAULT_IMAGE)
    argv[index:index] = ['-v', f'{source}:/orcha-test-source:ro']
    proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    identity = None
    try:
        eventually(lambda: (tmp_path/'started').exists())
        evidence = job_sandbox.inspect_container(name, sandbox)
        assert evidence is not None
        identity = evidence['container_id']
        if finish:
            proc.wait(timeout=30)
            original = (directory/'result.json').read_bytes()
        else:
            job_sandbox.save_before_stop(evidence)
            assert sandbox._docker(['kill', '--signal', 'KILL', identity], timeout=15).returncode == 0
            proc.wait(timeout=30)
        observed = job_sandbox.inspect_container(name, sandbox, identifier=identity)
        assert job_sandbox.save_after_exit(observed)
        result = read_json(directory/'result.json')
        assert result['termination_verified']
        if finish:
            assert result['status'] == 'completed' and result['exit_code'] == 0
            assert (directory/'result.json').read_bytes() == original
        else:
            assert result['status'] == 'interrupted' and result['exit_code'] is None
        sandbox.remove(identity)
        assert job_sandbox.inspect_container(name, sandbox, identifier=identity) is None
        assert (directory/'stdout.log').read_text() == 'durable output\n'
        assert (tmp_path/'started').read_text() == 'once'
    finally:
        # The random name/ID belongs only to this disposable test invocation.
        sandbox.remove(identity or name, force=True)
        if proc.stdin:
            proc.stdin.close()
        proc.wait(timeout=30)
