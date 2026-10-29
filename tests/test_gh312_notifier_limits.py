"""The actual notifier publishes fixed caps and uses exact-run scheduling."""

import subprocess
import sys
import time
from datetime import datetime
from types import SimpleNamespace

from fastapi.testclient import TestClient

from orcha_cli import notifier, notifier_managed_limits
from portal_backend.application import app
from test_gh312_managed_messages import managed


def test_deadline_retry_keeps_original_caps(tmp_path):
    worker = {'run_id': 'test-run', 'hard_deadline': 2000, 'launch_started_ts': 1000,
              'sandbox_container_id': 'test-sandbox', 'base_cwd': str(tmp_path),
              'respawn_ctx': {'task_id': 'test-task'}}
    calls = []
    def post(url, body):
        calls.append((url, body))
        return None if len(calls) == 1 else body
    service = SimpleNamespace(_post_json=post)
    assert not notifier_managed_limits.publish_limits('http://local', worker, service)
    worker['hard_deadline'] = 9000  # a later retry must not slide either cap
    assert notifier_managed_limits.publish_limits('http://local', worker, service)
    assert calls[0] == calls[1]
    notifier_managed_limits.publish_limits('http://local', worker, service)
    assert len(calls) == 2
    assert datetime.fromisoformat(calls[0][1]['run_until']).timestamp() == 2000
    assert datetime.fromisoformat(calls[0][1]['sandbox_until']).timestamp() == 8200


async def test_real_notifier_renews_then_releases_managed_run(client, managed, db, monkeypatch, tmp_path):
    from portal_backend import sql
    api = TestClient(app)
    calls = []
    def post(url, body, **kwargs):
        response = api.post(url.removeprefix('http://local'), json=body)
        calls.append((url, body, response.status_code))
        assert response.status_code < 400, response.text
        return response.json()
    monkeypatch.setattr(notifier, '_post_json', post)
    # Actual child lifetime; only model startup is replaced by a tiny Python process.
    proc = subprocess.Popen([sys.executable, '-c', 'import sys; sys.stdin.read()'], stdin=subprocess.PIPE)
    try:
        worker = {'proc': proc, 'run_id': managed['rid'], 'run_token': managed['token'],
                  'hard_deadline': time.time()+600, 'last_progress_ts': time.time(),
                  'last_size': 0, 'log_path': None, 'base_cwd': str(tmp_path),
                  'worktree': None, 'respawn_ctx': {'task_id': managed['tid'], 'model_runtime': 'codex'}}
        live = {managed['aid']: worker}
        db.execute('UPDATE worker_runs SET managed_commands=true WHERE run_id=%s', (managed['rid'],))
        before = db.execute('SELECT wake_lease_until FROM agent_wake_state')[0]['wake_lease_until']
        notifier.reap_workers('http://local', live, quiet=True)
        renewals = [(body, status) for path, body, status in calls if path.endswith('/wake-renew')]
        assert renewals and renewals[0][0].get('run_id') == managed['rid']
        assert worker['managed_limits_published'] and not worker['lease_renewal_failed']
        assert worker['scheduling_lease_until']
        assert db.execute('SELECT run_until FROM managed_run_limits')[0]['run_until'] > sql.utcnow()
        assert db.execute('SELECT wake_lease_until FROM agent_wake_state')[0]['wake_lease_until'] != before
        proc.stdin.close()
        proc.wait(timeout=5)
        notifier.reap_workers('http://local', live, quiet=True)
        assert not live
        assert db.execute('SELECT wake_lease_until FROM agent_wake_state')[0]['wake_lease_until'] is None
        assert all(body.get('run_id') == managed['rid'] for path, body, _ in calls if path.endswith('/wake-ack'))
    finally:
        if proc.poll() is None:
            proc.terminate()
            proc.wait(timeout=5)
        api.close()
