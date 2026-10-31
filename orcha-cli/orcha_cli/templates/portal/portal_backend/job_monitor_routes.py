"""Monitor discovery and late evidence use the existing local machine boundary.

These operations cannot start a process or authorize a task. Worker mutations
still require the current task/run/generation. The continuation secret grants
only finite supervision of its original isolated command.
"""

import hashlib
import hmac
from datetime import timedelta
from typing import Annotated
from uuid import UUID

from fastapi import Header, HTTPException, Query, Request

from portal_backend import sql
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_kind
from portal_backend.identity_routes import require_machine_lane_member, trusted_actor
from portal_backend.job_monitor_service import (
    execution_refusal, latest_outcome, lock_monitor, observe, one, revoke,
)
from portal_backend.managed_run_auth import conflict, require_managed_run
from portal_backend.schemas.job_monitors import (
    ContinuationHeartbeat, HandleOutcome, JobMonitor, JobObservation, JobOutcome,
    JobStop, JobStopReceipt, JobWaitReceipt, JobYield, MonitorPage,
    ObservationReceipt, OutcomePage, RunJobWait,
)
from portal_backend.schemas.managed_jobs import ManagedJobAuthority

TokenHeader = Annotated[str | None, Header(alias='X-Orcha-Run-Token')]


@app.get('/api/runs/{rid}/job-wait', response_model=RunJobWait)
def run_job_wait(rid: UUID, request: Request):
    from portal_backend.workflow_evidence_service import _lock_context
    from portal_backend.job_monitor_service import task_waiting
    with db_cursor() as (_, cur):
        run, task, _ = _lock_context(cur, str(rid))
        if not task:
            return dict(waiting=False)
        require_machine_lane_member(cur, request, str(task['container_id']))
        return dict(waiting=task_waiting(cur, str(task['id']), str(run['agent_id']), source_run_id=str(rid)))


@app.post('/api/runs/{rid}/job-exit', response_model=RunJobWait)
def prepare_job_exit(rid: UUID, request: Request):
    """Original notifier records the source exit; never grants new authority."""
    from portal_backend.workflow_evidence_service import _lock_context
    from portal_backend.job_monitor_service import register_unexpected_waits
    with db_cursor() as (conn, cur):
        run, task, _ = _lock_context(cur, str(rid))
        if not task:
            return dict(waiting=False)
        require_machine_lane_member(cur, request, str(task['container_id']))
        cur.execute('SELECT job_id FROM managed_job_monitors WHERE launch_run_id=%s AND continue_after_exit=true', (str(rid),))
        ids = [r['job_id'] for r in cur.fetchall()]
        retained = []
        for jid in ids:
            source, _, job, monitor = lock_monitor(cur, str(task['id']), str(jid))
            refusal = execution_refusal(cur, source, task, job, monitor)
            if refusal:
                revoke(cur, str(jid), refusal, suppress=refusal == 'explicit_stop')
            else:
                retained.append(jid)
        register_unexpected_waits(cur, run)
        conn.commit()
        return dict(waiting=bool(retained), retained_job_ids=retained)


@app.get('/api/containers/{cid}/job-monitors', response_model=MonitorPage)
def list_monitors(cid: UUID, request: Request, after: UUID | None = None,
                  limit: int = Query(default=50, ge=1, le=100)):
    """Keyset pages include handled uncertainty until termination is verified."""
    with db_cursor(readonly=True) as (_, cur):
        require_machine_lane_member(cur, request, str(cid))
        params = [str(cid)]
        cursor = ''
        if after:
            cursor = ' AND m.job_id>%s'
            params.append(str(after))
        params.append(limit + 1)
        cur.execute('''SELECT m.* FROM managed_job_monitors m JOIN managed_jobs j ON j.job_id=m.job_id
            JOIN tasks t ON t.id=j.task_id LEFT JOIN managed_job_outcomes o
            ON o.job_id=m.job_id AND o.revision=m.outcome_revision
            WHERE t.container_id=%s AND (j.termination_verified=false OR o.handled_at IS NULL)'''
            + cursor + ' ORDER BY m.job_id LIMIT %s', tuple(params))
        rows = cur.fetchall()
        monitors = []
        for m in rows[:limit]:
            job = one(cur, 'SELECT * FROM managed_jobs WHERE job_id=%s', (m['job_id'],))
            monitors.append(JobMonitor(job=job, outcome=latest_outcome(cur, m['job_id']), **m))
        return dict(monitors=monitors, next_after=rows[limit-1]['job_id'] if len(rows) > limit else None)


@app.post('/api/tasks/{tid}/job-monitors/{jid}/observe', response_model=ObservationReceipt)
def observe_job(tid: UUID, jid: UUID, body: JobObservation, request: Request):
    """Accept already-saved evidence after expiry, pause or worker revocation.

Exact retries return the stored receipt, including after later observations.
No raw evidence is accepted and no execution authority is restored.
"""
    with db_cursor() as (conn, cur):
        _, task, job, _ = lock_monitor(cur, str(tid), str(jid))
        require_machine_lane_member(cur, request, str(task['container_id']))
        result = observe(cur, job, body)
        conn.commit()
        return result


@app.post('/api/tasks/{tid}/job-monitors/{jid}/reconcile', response_model=JobMonitor)
def reconcile_monitor(tid: UUID, jid: UUID, request: Request):
    """Bounded daemon maintenance; no launching, signalling or receipt consumption."""
    from portal_backend.job_monitor_service import notify_exhausted, register_unexpected_waits
    with db_cursor() as (conn, cur):
        run, task, job, monitor = lock_monitor(cur, str(tid), str(jid))
        require_machine_lane_member(cur, request, str(task['container_id']))
        if monitor['continue_after_exit'] and job['state'] in {'reserved','running'}:
            refusal = execution_refusal(cur, run, task, job, monitor)
            if refusal:
                monitor = revoke(cur, str(jid), refusal, suppress=refusal == 'explicit_stop')
            elif run['status'] != 'running':
                register_unexpected_waits(cur, run)
        if not one(cur, "SELECT 1 FROM worker_runs WHERE agent_id=%s AND lane='work' AND status='running'",
                   (monitor['agent_id'],)):
            notify_exhausted(cur, run)
        conn.commit()
        return JobMonitor(job=job, outcome=latest_outcome(cur, str(jid)), **monitor)


@app.post('/api/tasks/{tid}/job-monitors/{jid}/continuation-heartbeat', response_model=ManagedJobAuthority)
def continuation_heartbeat(tid: UUID, jid: UUID, body: ContinuationHeartbeat, request: Request):
    refused = None
    with db_cursor() as (conn, cur):
        run, task, job, monitor = lock_monitor(cur, str(tid), str(jid))
        require_machine_lane_member(cur, request, str(task['container_id']))
        if (str(body.launch_nonce) != str(job['launch_nonce'])
                or not hmac.compare_digest(hashlib.sha256(body.capability.encode()).hexdigest(),
                                           monitor['capability_digest'] or '')):
            raise HTTPException(403, 'Original supervisor capability required')
        refused = execution_refusal(cur, run, task, job, monitor)
        if refused:
            revoke(cur, str(jid), refused, suppress=refused == 'explicit_stop')
        else:
            now = sql.utcnow()
            limits = one(cur, 'SELECT * FROM managed_run_limits WHERE run_id=%s', (monitor['launch_run_id'],))
            until = min(monitor['execution_until'], limits['run_until'], job['budget_until'])
            result = dict(server_time=now, run_id=monitor['launch_run_id'], job_id=jid,
                workflow_generation=None, token_valid=True, stop_requested=False, on_hold=False,
                cancelled=False, lease_until=None, lease_active=False, mutations_allowed=False,
                authority_until=until, run_until=until, sandbox_until=None, budget_until=job['budget_until'],
                prepare_at=until-timedelta(seconds=60))
        conn.commit()  # Revocation must survive the refusal response.
    if refused:
        conflict('managed_continuation_revoked')
    return result


@app.post('/api/tasks/{tid}/job-monitors/{jid}/stop', response_model=JobStopReceipt)
def stop_job(tid: UUID, jid: UUID, body: JobStop, request: Request, x_orcha_run_token: TokenHeader = None):
    with db_cursor() as (conn, cur):
        if x_orcha_run_token:
            require_managed_run(cur, str(tid), x_orcha_run_token, request)
        _, task, _, _ = lock_monitor(cur, str(tid), str(jid))
        if not x_orcha_run_token:
            actor = trusted_actor(cur, request, str(task['container_id']),
                                  str(body.actor_agent_id) if body.actor_agent_id else None)
            require_kind(cur, actor, ('human',))
        monitor = revoke(cur, str(jid), 'explicit_stop', suppress=True)
        conn.commit()
        return monitor


@app.post('/api/tasks/{tid}/job-monitors/{jid}/yield', response_model=JobWaitReceipt)
def yield_job(tid: UUID, jid: UUID, body: JobYield, request: Request, x_orcha_run_token: TokenHeader = None):
    with db_cursor() as (conn, cur):
        run, task = require_managed_run(cur, str(tid), x_orcha_run_token, request)
        source, _, job, monitor = lock_monitor(cur, str(tid), str(jid))
        if str(monitor['agent_id']) != str(run['agent_id']) or execution_refusal(cur, source, task, job, monitor):
            conflict('managed_job_not_waitable')
        cur.execute('''INSERT INTO managed_job_waits(job_id,source_run_id,work_revision,context_digest)
            VALUES (%s,%s,%s,%s) ON CONFLICT(job_id) DO UPDATE SET source_run_id=excluded.source_run_id,
            work_revision=excluded.work_revision,context_digest=excluded.context_digest RETURNING *''',
            (str(jid), run['run_id'], task['work_revision'], body.context_digest))
        result = cur.fetchone()
        conn.commit()
        return result


@app.post('/api/tasks/{tid}/job-outcomes/poll', response_model=OutcomePage)
def poll_outcomes(tid: UUID, request: Request, x_orcha_run_token: TokenHeader = None):
    with db_cursor() as (conn, cur):
        run, task = require_managed_run(cur, str(tid), x_orcha_run_token, request)
        cur.execute('''UPDATE managed_job_outcomes SET received_run_id=%s,received_at=now()
            WHERE handled_at IS NULL AND job_id IN (SELECT m.job_id FROM managed_job_monitors m
            JOIN managed_jobs j ON j.job_id=m.job_id WHERE j.task_id=%s AND m.agent_id=%s
            AND m.work_revision=%s AND m.outcome_revision=managed_job_outcomes.revision) RETURNING *''',
            (run['run_id'], str(tid), run['agent_id'], task['work_revision']))
        result = cur.fetchall()
        conn.commit()
        return dict(outcomes=result)


@app.post('/api/tasks/{tid}/job-outcomes/{jid}/handled', response_model=JobOutcome)
def handle_outcome(tid: UUID, jid: UUID, body: HandleOutcome, request: Request, x_orcha_run_token: TokenHeader = None):
    digest = hashlib.sha256(body.model_dump_json().encode()).hexdigest()
    with db_cursor() as (conn, cur):
        run, task = require_managed_run(cur, str(tid), x_orcha_run_token, request)
        _, _, _, monitor = lock_monitor(cur, str(tid), str(jid))
        if str(monitor['agent_id']) != str(run['agent_id']) or monitor['work_revision'] != task['work_revision']:
            conflict('managed_outcome_assignment_changed')
        outcome = latest_outcome(cur, str(jid))
        if not outcome or body.revision != outcome['revision'] or body.result_digest != outcome['result_digest']:
            conflict('managed_outcome_changed')
        if outcome['handled_at']:
            if outcome['handling_digest'] != digest:
                conflict('managed_handling_conflict')
            return outcome
        if (body.disposition == 'applied') != bool(outcome['termination_verified']):
            conflict('managed_outcome_resolution_required')
        cur.execute('''UPDATE managed_job_outcomes SET handled_run_id=%s,handled_at=now(),handling_digest=%s,
            disposition=%s,handling_note=%s WHERE job_id=%s AND revision=%s RETURNING *''',
            (run['run_id'], digest, body.disposition, body.note, str(jid), body.revision))
        outcome = cur.fetchone()
        conn.commit()
        return outcome
