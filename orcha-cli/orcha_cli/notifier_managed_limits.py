"""Publish fixed deadlines once per worker; retries never slide the run cap."""

from datetime import datetime, timezone

from .sandbox import SandboxConfig


def publish_limits(api_base, worker, services):
    if worker.get('managed_limits_published'):
        return True
    if (not worker.get('run_id') or not worker.get('hard_deadline')
            or not (worker.get('respawn_ctx') or {}).get('task_id')
            or worker.get('lane', 'work') != 'work'):
        return False
    run_until = worker.setdefault('managed_run_until', worker['hard_deadline'])
    body = {'run_until': datetime.fromtimestamp(run_until, timezone.utc).isoformat()}
    if worker.get('sandbox_container_id'):
        if not worker.get('launch_started_ts'):
            # A reconstructed worker needs the original container start; never
            # grant it a fresh sandbox lifetime measured from adoption.
            return False
        if 'managed_sandbox_until' not in worker:
            config = SandboxConfig.load(worker.get('base_cwd') or worker.get('worktree') or '.')
            worker['managed_sandbox_until'] = worker['launch_started_ts'] + config.max_runtime_secs
        body['sandbox_until'] = datetime.fromtimestamp(worker['managed_sandbox_until'], timezone.utc).isoformat()
    response = services._post_json(f"{api_base}/api/runs/{worker['run_id']}/managed-limits", body)
    worker['managed_limits_published'] = bool(response and response.get('run_until'))
    return worker['managed_limits_published']
