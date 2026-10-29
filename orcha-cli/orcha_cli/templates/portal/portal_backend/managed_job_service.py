"""Finite authority for supervised jobs. Polling never writes liveness activity."""

from datetime import timedelta

from portal_backend import sql
from portal_backend.managed_run_auth import conflict
from portal_backend.stranded_runs import (
    SANDBOX_STRANDED_EXTRA_SECS, STRANDED_RUN_SECS, managed_activity,
)


def run_limits(cur, run):
    cur.execute('SELECT * FROM managed_run_limits WHERE run_id=%s', (run['run_id'],))
    limits = cur.fetchone()
    if not limits or (run['sandbox_container_id'] and not limits['sandbox_until']):
        conflict('managed_runtime_limits_not_published')
    return limits


def authority_until(cur, run, task, limits, job=None):
    caps = [limits['run_until']]
    if limits['sandbox_until']:
        caps.append(limits['sandbox_until'])
    if job:
        caps.append(job['budget_until'])
    if not task.get('workflow_id'):
        extra = SANDBOX_STRANDED_EXTRA_SECS if run['sandbox_container_id'] else 0
        caps.append(managed_activity(cur, run['run_id'])
                    + timedelta(seconds=STRANDED_RUN_SECS + extra))
    return min(caps)


def require_job_owner(cur, tid, jid, run):
    cur.execute('SELECT * FROM managed_jobs WHERE task_id=%s AND job_id=%s' + sql.for_update(),
                (tid, jid))
    job = cur.fetchone()
    if not job:
        conflict('managed_job_unavailable')
    if str(job['owner_run_id']) != str(run['run_id']):
        conflict('managed_job_owner_changed')
    return job
