"""Optional managed-check submission gate: failed jobs never call Orcha /done."""
import json
import os
from pathlib import Path
from uuid import uuid4

import pytest

from orcha_cli.cli_job import submit_after_successful_job
from orcha_cli.job_store import JobStorageError


class EvidenceStore:
    def __init__(self, directory, job, result):
        self.directory = Path(directory) / job['job_id']
        self.directory.mkdir(mode=0o700)
        self.job = job
        (self.directory / 'result.json').write_text(json.dumps(result), encoding='utf-8')
        os.chmod(self.directory / 'result.json', 0o600)

    def read(self, job_id):
        assert job_id == self.job['job_id']
        return {
            'job_id': self.job['job_id'],
            'task_id': self.job['task_id'],
            'launch_nonce': self.job['launch_nonce'],
            'owner_run_id': self.job['owner_run_id'],
            'status': 'completed',
        }

    def job_directory(self, job_id):
        assert job_id == self.job['job_id']
        return self.directory


class TaskAPI:
    """Return a saved managed-job identity and route /done through the real app."""
    def __init__(self, client, job, headers):
        self.client, self.job, self.headers = client, job, headers
        self.done_calls = 0

    def request(self, suffix, body=None, *, method='POST', timeout=None):
        if suffix == 'managed-jobs' and method == 'GET':
            return {'jobs': [self.job]}
        if suffix == 'done':
            self.done_calls += 1
            response = self.client.post(
                f"/api/tasks/{self.job['task_id']}/done",
                json=body,
                headers=self.headers,
            )
            assert response.status_code == 200, response.text
            return response.json()
        raise AssertionError(f'unexpected API operation: {method} {suffix}')


def job_evidence(task_id, exit_code):
    job_id, nonce, owner = str(uuid4()), 'launch-nonce', 'run-owner'
    job = {
        'job_id': job_id, 'task_id': task_id, 'launch_nonce': nonce,
        'owner_run_id': owner, 'state': 'completed', 'budget_until': 'later',
        'transfers_used': 0,
    }
    result = {
        'job_id': job_id, 'launch_nonce': nonce, 'owner_run_id': owner,
        'status': 'completed', 'exit_code': exit_code, 'signal': None,
        'termination_verified': True,
    }
    return job, result


async def _task_state(client, container_id, task_id):
    snapshot = await client.get(f'/api/containers/{container_id}')
    assert snapshot.status_code == 200, snapshot.text
    return next(task['status'] for task in snapshot.json()['tasks'] if task['id'] == task_id)


async def test_failed_managed_acceptance_does_not_submit_task(
    tmp_path, client, container, make_agent, make_task, work_headers
):
    agent = await make_agent('grf-worker', 'eng')
    task = await make_task('acceptance-gated task', 'checks pass', assignee_alias='grf-worker')
    task_id = task['task_id']
    job, result = job_evidence(task_id, 17)
    store = EvidenceStore(tmp_path, job, result)
    api = TaskAPI(client, job, await work_headers(agent['agent_id']))

    with pytest.raises(JobStorageError, match='verified successful exit'):
        submit_after_successful_job(api, store, job['job_id'], agent['agent_id'], 'Completed work')

    assert api.done_calls == 0
    assert await _task_state(client, container['id'], task_id) == 'in_progress'


async def test_successful_managed_acceptance_uses_normal_human_review_route(
    tmp_path, client, container, make_agent, make_task, work_headers
):
    agent = await make_agent('grf-worker', 'eng')
    task = await make_task('acceptance-gated task', 'checks pass', assignee_alias='grf-worker')
    task_id = task['task_id']
    job, result = job_evidence(task_id, 0)
    store = EvidenceStore(tmp_path, job, result)
    api = TaskAPI(client, job, await work_headers(agent['agent_id']))

    response = submit_after_successful_job(api, store, job['job_id'], agent['agent_id'], 'Checks passed')

    assert api.done_calls == 1
    assert response['status'] == 'needs_verification'
    assert await _task_state(client, container['id'], task_id) == 'needs_verification'
