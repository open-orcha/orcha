"""Task-scoped launch reservations, checkpoint CAS and read-only authority.

The local supervisor owns executable argv and private evidence. This service
never receives logs or executes a recorded command. Reservations are durable
launch fences even if a client disappears before reporting a process identity.
"""

import hashlib
from datetime import timedelta
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import Header, Request

from portal_backend import sql
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.identity_routes import require_machine_lane_member
from portal_backend.managed_job_service import authority_until, require_job_owner, run_limits
from portal_backend.managed_run_auth import conflict, require_managed_run
from portal_backend.schemas.managed_jobs import (
    ManagedJobAuthority, ManagedJobList, ManagedJobReserve, ManagedJobUpdate,
    ManagedJobView, ManagedLimitsView, ManagedRunLimits, ManagedJobReconcile,
    HostWorkerStopObserved, WorkerStopObservationView,
)
from portal_backend.workflow_evidence_service import _lock_context

TokenHeader = Annotated[str | None, Header(alias='X-Orcha-Run-Token')]


@app.post('/api/runs/{rid}/managed-limits', response_model=ManagedLimitsView)
def publish_managed_limits(rid: UUID, body: ManagedRunLimits, request: Request):
    """Notifier publication on the existing machine lane; fixed caps only shorten.

    This is the same local-daemon trust boundary as run start/finish, not an
    authenticated daemon credential. Managed worker controls use their token.
    """
    with db_cursor() as (conn, cur):
        run, task, _ = _lock_context(cur, str(rid))
        if not task:
            conflict('managed_task_required')
        require_machine_lane_member(cur, request, str(task['container_id']))
        if run['status'] != 'running' or run['lane'] != 'work':
            conflict('worker_no_longer_owns_task')
        if body.run_until > run['started_at'] + timedelta(days=1):
            conflict('managed_runtime_limit_too_large')
        if body.sandbox_until and body.sandbox_until > run['started_at'] + timedelta(days=1):
            conflict('managed_sandbox_limit_too_large')
        if run['sandbox_container_id'] and not body.sandbox_until:
            conflict('managed_sandbox_limit_required')
        cur.execute('SELECT * FROM managed_run_limits WHERE run_id=%s', (str(rid),))
        existing = cur.fetchone()
        if existing and (body.run_until > existing['run_until'] or (
                existing['sandbox_until'] and (not body.sandbox_until
                                               or body.sandbox_until > existing['sandbox_until']))):
            conflict('managed_runtime_limit_cannot_extend')
        cur.execute('INSERT INTO managed_run_limits(run_id,run_until,sandbox_until) VALUES (%s,%s,%s) '
                    'ON CONFLICT(run_id) DO UPDATE SET run_until=excluded.run_until,'
                    'sandbox_until=excluded.sandbox_until',
                    (str(rid), body.run_until, body.sandbox_until))
        conn.commit()
    return dict(run_id=rid, **body.model_dump())


@app.post('/api/tasks/{tid}/managed-jobs', response_model=ManagedJobView)
def reserve_managed_job(tid: UUID, body: ManagedJobReserve, request: Request,
                        x_orcha_run_token: TokenHeader = None):
    with db_cursor() as (conn, cur):
        run, task = require_managed_run(cur, str(tid), x_orcha_run_token, request)
        limits = run_limits(cur, run)
        if authority_until(cur, run, task, limits) <= sql.utcnow():
            conflict('managed_authority_expired')
        if body.continuation_contract != 'stop_before_transfer' and run['sandbox_container_id']:
            conflict('managed_isolation_requires_host')
        cur.execute('SELECT * FROM managed_jobs WHERE task_id=%s AND job_key=%s' + sql.for_update(),
                    (str(tid), str(body.job_key)))
        job = cur.fetchone()
        if job:
            # Return the original reservation/result, never renew its budget or
            # create a second process. The caller must inspect owner and state.
            if (body.max_transfers != job['max_transfers'] or body.max_elapsed_secs != job['max_elapsed_secs']
                    or body.continuation_contract != job['continuation_contract']):
                conflict('managed_reservation_conflict')
        else:
            cur.execute('SELECT generation FROM workflow_executions WHERE run_id=%s', (run['run_id'],))
            execution = cur.fetchone()
            now = sql.utcnow()
            cur.execute('INSERT INTO managed_jobs(job_id,task_id,job_key,launch_nonce,owner_run_id,'
                        'workflow_generation,budget_until,max_transfers,max_elapsed_secs,reserved_at,continuation_contract) '
                        'VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *',
                        (str(uuid4()), str(tid), str(body.job_key), str(uuid4()), run['run_id'],
                         execution['generation'] if execution else None,
                         now + timedelta(seconds=body.max_elapsed_secs), body.max_transfers,
                         body.max_elapsed_secs, now, body.continuation_contract))
            job = cur.fetchone()
        conn.commit()
    return job


@app.post('/api/runs/{rid}/managed-stop-observation', response_model=WorkerStopObservationView)
def observe_host_worker_stop(rid: UUID, body: HostWorkerStopObserved, request: Request):
    """Local daemon's positive Popen exit observation, separate from finish.

    Like run finish, this uses the existing machine lane. A terminal run alone
    never creates this receipt. Workflow observations use confirm-stopped.
    """
    from portal_backend.worker_stop_observations import record_stop
    with db_cursor() as (conn, cur):
        run, task, execution = _lock_context(cur, str(rid))
        if not task:
            conflict('managed_task_required')
        require_machine_lane_member(cur, request, str(task['container_id']))
        if (task.get('workflow_id') or execution or run['sandbox_container_id']
                or run['lane'] != 'work' or run['wake_kind'] != 'ephemeral'):
            conflict('managed_stop_requires_host_worker')
        if run['status'] == 'running' or not run['ended_at']:
            conflict('managed_source_run_not_ended')
        if run['pid'] != body.process_id:
            conflict('managed_worker_process_changed')
        receipt = record_stop(cur, str(rid), source='host_process',
                              process_id=body.process_id, exit_code=body.exit_code)
        conn.commit()
        return receipt


@app.get('/api/tasks/{tid}/managed-jobs', response_model=ManagedJobList)
def list_managed_jobs(tid: UUID, request: Request, x_orcha_run_token: TokenHeader = None):
    with db_cursor() as (_, cur):
        require_managed_run(cur, str(tid), x_orcha_run_token, request, enrol=False)
        cur.execute('SELECT * FROM managed_jobs WHERE task_id=%s ORDER BY reserved_at,job_id', (str(tid),))
        return dict(jobs=cur.fetchall())


@app.post('/api/tasks/{tid}/managed-jobs/{jid}/heartbeat', response_model=ManagedJobAuthority)
def managed_job_heartbeat(tid: UUID, jid: UUID, request: Request,
                          x_orcha_run_token: TokenHeader = None):
    """Confirm finite same-run authority without extending a lease or activity.

    An expired but unreleased scheduling lease permits supervision of this
    existing job only. Every authoritative mutation still requires a live lease.
    Any non-success response fences controls; local evidence remains writable.
    """
    with db_cursor() as (_, cur):
        run, task = require_managed_run(cur, str(tid), x_orcha_run_token, request,
                                       allow_lapsed=True, enrol=False, allow_frozen=True)
        limits = run_limits(cur, run)
        job = require_job_owner(cur, str(tid), str(jid), run)
        now = sql.utcnow()
        until = authority_until(cur, run, task, limits, job)
        if until <= now:
            conflict('managed_authority_expired')
        if job['state'] not in {'reserved', 'running'}:
            conflict('managed_job_not_live')
        cur.execute('SELECT wake_lease_until FROM agent_wake_state WHERE agent_id=%s', (run['agent_id'],))
        lane = cur.fetchone()
        lease = lane['wake_lease_until'] if lane and not task.get('workflow_id') else None
        active = bool(task.get('workflow_id') or (lease and lease > now))
        prepare = min([until] + ([lease] if lease else [])) - timedelta(seconds=60)
        return dict(server_time=now, run_id=run['run_id'], job_id=jid,
                    workflow_generation=job['workflow_generation'], token_valid=True,
                    stop_requested=False, on_hold=False, cancelled=False,
                    lease_until=lease, lease_active=active,
                    mutations_allowed=active and not limits['controls_frozen'],
                    authority_until=until, run_until=limits['run_until'],
                    sandbox_until=limits['sandbox_until'], budget_until=job['budget_until'],
                    prepare_at=prepare)


@app.post('/api/tasks/{tid}/managed-jobs/{jid}/checkpoint', response_model=ManagedJobView)
def update_managed_job(tid: UUID, jid: UUID, body: ManagedJobUpdate, request: Request,
                       x_orcha_run_token: TokenHeader = None):
    """Publish already-flushed evidence by owner/version CAS; retries are idempotent."""
    digest = hashlib.sha256(body.model_dump_json().encode()).hexdigest()
    with db_cursor() as (conn, cur):
        run, task = require_managed_run(cur, str(tid), x_orcha_run_token, request)
        limits = run_limits(cur, run)
        job = require_job_owner(cur, str(tid), str(jid), run)
        if authority_until(cur, run, task, limits) <= sql.utcnow():
            conflict('managed_authority_expired')
        cur.execute('SELECT payload_digest FROM managed_job_operations WHERE job_id=%s AND operation_id=%s',
                    (str(jid), str(body.operation_id)))
        operation = cur.fetchone()
        if operation:
            if operation['payload_digest'] != digest:
                conflict('managed_operation_conflict')
            return job
        if body.expected_version != job['version']:
            conflict('managed_checkpoint_version_changed')
        if body.checkpoint_version <= job['checkpoint_version']:
            conflict('managed_checkpoint_must_advance')
        allowed = {
            'reserved': {'reserved', 'running', 'completed', 'interrupted', 'unknown', 'exhausted'},
            'running': {'running', 'completed', 'interrupted', 'unknown', 'exhausted'},
            'unknown': {'unknown', 'completed', 'interrupted', 'exhausted'},
            'completed': {'completed'}, 'interrupted': {'interrupted'}, 'exhausted': {'exhausted'},
        }
        if body.state not in allowed[job['state']]:
            conflict('managed_job_transition_refused')
        if job['termination_verified'] and (not body.termination_verified or body.result_digest != job['result_digest']):
            conflict('managed_terminal_evidence_immutable')
        if body.state in {'reserved', 'running'} and job['budget_until'] <= sql.utcnow():
            conflict('managed_job_budget_exhausted')
        cur.execute('UPDATE managed_jobs SET version=version+1,state=%s,checkpoint_version=%s,'
                    'checkpoint_digest=%s,result_digest=%s,termination_verified=%s WHERE job_id=%s RETURNING *',
                    (body.state, body.checkpoint_version, body.checkpoint_digest, body.result_digest,
                     body.termination_verified, str(jid)))
        job = cur.fetchone()
        cur.execute('INSERT INTO managed_job_operations(job_id,operation_id,payload_digest) VALUES (%s,%s,%s)',
                    (str(jid), str(body.operation_id), digest))
        conn.commit()
    return job


@app.post('/api/tasks/{tid}/managed-jobs/{jid}/reconcile', response_model=ManagedJobView)
def reconcile_managed_job(tid: UUID, jid: UUID, body: ManagedJobReconcile, request: Request,
                          x_orcha_run_token: TokenHeader = None):
    """Import a flushed guard result after its owner has ended, never relaunch.

    The caller verifies the private files under the original supervisor lock.
    Like checkpoint publication, this API records evidence supplied by the
    authorized worker; hashes alone are not independent OS termination proof.
    """
    digest = hashlib.sha256(body.model_dump_json().encode()).hexdigest()
    with db_cursor() as (conn, cur):
        run, task = require_managed_run(cur, str(tid), x_orcha_run_token, request)
        limits = run_limits(cur, run)
        if authority_until(cur, run, task, limits) <= sql.utcnow():
            conflict('managed_authority_expired')
        # The shared graph/task prefix is already held. Lock the source run
        # before the job so this serializes with terminalization and adoption.
        cur.execute('SELECT * FROM worker_runs WHERE run_id=%s' + sql.for_update(),
                    (str(body.source_owner_run_id),))
        source = cur.fetchone()
        if (not source or str(source['task_id']) != str(tid)
                or source['status'] == 'running' or not source['ended_at']):
            conflict('managed_source_run_not_ended')
        cur.execute('SELECT * FROM managed_jobs WHERE job_id=%s AND task_id=%s' + sql.for_update(),
                    (str(jid), str(tid)))
        job = cur.fetchone()
        if not job:
            conflict('managed_job_unavailable')
        if (str(job['owner_run_id']) != str(body.source_owner_run_id)
                or str(job['launch_nonce']) != str(body.launch_nonce)):
            conflict('managed_recovery_identity_changed')
        cur.execute('SELECT payload_digest FROM managed_job_operations WHERE job_id=%s AND operation_id=%s',
                    (str(jid), str(body.operation_id)))
        operation = cur.fetchone()
        if operation:
            if operation['payload_digest'] != digest:
                conflict('managed_operation_conflict')
            return job
        if body.expected_version != job['version'] or body.checkpoint_version <= job['checkpoint_version']:
            conflict('managed_checkpoint_version_changed')
        if (job['termination_verified'] and (job['state'] != body.state
                                             or job['result_digest'] != body.result_digest)):
            conflict('managed_terminal_evidence_immutable')
        if job['state'] in {'completed', 'interrupted', 'exhausted'} and job['state'] != body.state:
            conflict('managed_job_transition_refused')
        cur.execute('UPDATE managed_jobs SET version=version+1,state=%s,checkpoint_version=%s,'
                    'checkpoint_digest=%s,result_digest=%s,termination_verified=true '
                    'WHERE job_id=%s RETURNING *',
                    (body.state, body.checkpoint_version, body.checkpoint_digest,
                     body.result_digest, str(jid)))
        job = cur.fetchone()
        cur.execute('INSERT INTO managed_job_operations(job_id,operation_id,payload_digest) VALUES (%s,%s,%s)',
                    (str(jid), str(body.operation_id), digest))
        conn.commit()
    return job
