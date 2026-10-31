"""Bounded, explicitly planned transfer; no authority inferred from worker exit.

The original supervisor holds the unpersisted transfer capability. It verifies
its retained guard before preparing and again before adoption. The API records
those supplied evidence hashes, not an independent OS proof. Old controls are
frozen across the whole run. A transfer heartbeat can only maintain the original
fixed deadline; only atomic adoption admits a new run's finite authority.
"""

import hashlib
import hmac
from typing import Annotated
from uuid import UUID

from fastapi import Header, Request

from portal_backend import sql
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.managed_job_service import authority_until, require_job_owner, run_limits
from portal_backend.managed_run_auth import conflict, require_managed_run
from portal_backend.schemas.managed_jobs import (
    ManagedJobView, ManagedTransferAdopt, ManagedTransferAuthority,
    ManagedTransferPrepare, ManagedTransferView,
)
from portal_backend.task_autonomy_service import task_completion_blockers
from portal_backend.workflow_evidence_service import _lock_context

TokenHeader = Annotated[str | None, Header(alias='X-Orcha-Run-Token')]


def capability_matches(transfer, capability):
    return bool(capability and hmac.compare_digest(
        transfer['capability_digest'], hashlib.sha256(capability.encode()).hexdigest()))


def require_transfer_safe(cur, task, source, transfer):
    """Safety gates remain live even between old exit and successor activation."""
    if (source['stop_requested_at'] or task.get('human_hold_by')
            or task.get('awaiting_loop_decision') or task_completion_blockers(task)):
        conflict('managed_transfer_stopped')
    # GH #388: a post-exit stop leaves the ended run's history untouched and
    # records the disposition on the job monitor instead. Every suppressing
    # revocation (explicit stop, cancellation, finished project) is final.
    cur.execute('SELECT suppress_wake FROM managed_job_monitors WHERE job_id=%s', (transfer['job_id'],))
    monitor = cur.fetchone()
    if monitor and monitor['suppress_wake']:
        conflict('managed_transfer_stopped')
    cur.execute('SELECT a.terminated_at,c.status FROM agents a JOIN containers c ON c.id=a.container_id '
                'WHERE a.id=%s', (source['agent_id'],))
    agent = cur.fetchone()
    if not agent or agent['terminated_at'] or agent['status'] != 'active':
        conflict('managed_transfer_project_unavailable')
    cur.execute("SELECT 1 FROM agent_tasks WHERE task_id=%s AND agent_id=%s "
                "AND assignment_status IN ('assigned','accepted','working')",
                (task['id'], source['agent_id']))
    if not cur.fetchone():
        conflict('managed_transfer_unassigned')
    if task.get('workflow_id'):
        cur.execute('SELECT status FROM workflows WHERE id=%s', (task['workflow_id'],))
        workflow = cur.fetchone()
        cur.execute('SELECT * FROM workflow_executions WHERE id=%s', (transfer['execution_id'],))
        execution = cur.fetchone()
        if (not workflow or workflow['status'] != 'active' or not execution
                or execution['state'] not in {'reserved', 'running'}
                or execution['generation_revoked_at']):
            conflict('managed_transfer_workflow_stopped')


@app.post('/api/tasks/{tid}/managed-jobs/{jid}/transfer/prepare', response_model=ManagedTransferView)
def prepare_transfer(tid: UUID, jid: UUID, body: ManagedTransferPrepare, request: Request,
                     x_orcha_run_token: TokenHeader = None):
    with db_cursor() as (conn, cur):
        # Preparation of another job in this same run is permitted after the
        # first freeze. No other worker mutation receives this exception.
        run, task = require_managed_run(cur, str(tid), x_orcha_run_token, request, allow_frozen=True)
        limits = run_limits(cur, run)
        job = require_job_owner(cur, str(tid), str(jid), run)
        cur.execute('SELECT * FROM managed_job_transfers WHERE job_id=%s AND source_run_id=%s',
                    (str(jid), run['run_id']))
        existing = cur.fetchone()
        if existing:
            if any(str(existing[k]) != str(getattr(body, k)) for k in
                   ('transfer_id', 'launch_nonce', 'proof_digest', 'capability_digest')):
                conflict('managed_transfer_conflict')
            return existing
        if (run['sandbox_container_id'] or job['continuation_contract'] != 'readonly_single_process_v1'
                or job['state'] != 'running' or job['termination_verified']):
            conflict('managed_transfer_not_eligible')
        if job['version'] != body.expected_version or str(job['launch_nonce']) != str(body.launch_nonce):
            conflict('managed_transfer_identity_changed')
        if job['transfers_used'] >= job['max_transfers']:
            conflict('managed_transfer_budget_exhausted')
        until = authority_until(cur, run, task, limits, job)
        if until <= sql.utcnow():
            conflict('managed_authority_expired')
        cur.execute('SELECT id,generation FROM workflow_executions WHERE run_id=%s', (run['run_id'],))
        execution = cur.fetchone()
        cur.execute('UPDATE managed_run_limits SET controls_frozen=true WHERE run_id=%s', (run['run_id'],))
        cur.execute('INSERT INTO managed_job_transfers(transfer_id,job_id,source_run_id,execution_id,'
                    'generation,launch_nonce,proof_digest,capability_digest,authority_until) '
                    'VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *',
                    (str(body.transfer_id), str(jid), run['run_id'], execution['id'] if execution else None,
                     execution['generation'] if execution else None, str(body.launch_nonce),
                     body.proof_digest, body.capability_digest, until))
        transfer = cur.fetchone()
        conn.commit()
        return transfer


@app.post('/api/tasks/{tid}/managed-jobs/{jid}/transfer/heartbeat', response_model=ManagedTransferAuthority)
def transfer_heartbeat(tid: UUID, jid: UUID, request: Request,
                       x_orcha_run_token: TokenHeader = None):
    # The header is a transfer-only capability here, NOT a revoked worker token.
    # Lookup is read-only; all authority is rechecked after the graph lock.
    digest = hashlib.sha256((x_orcha_run_token or '').encode()).hexdigest()
    with db_cursor() as (_, cur):
        cur.execute('SELECT * FROM managed_job_transfers WHERE job_id=%s AND capability_digest=%s',
                    (str(jid), digest))
        transfer = cur.fetchone()
        if not transfer:
            conflict('managed_transfer_unavailable')
        source, task, _ = _lock_context(cur, transfer['source_run_id'])
        if not task or str(task['id']) != str(tid):
            conflict('managed_transfer_unavailable')
        cur.execute('SELECT * FROM managed_job_transfers WHERE transfer_id=%s' + sql.for_update(),
                    (transfer['transfer_id'],))
        transfer = cur.fetchone()
        job = require_job_owner(cur, str(tid), str(jid), source)
        require_transfer_safe(cur, task, source, transfer)
        # A later shortened runtime limit still wins. Neither daemon activity,
        # lease renewal nor successful transfer polling can extend this cap.
        limits = run_limits(cur, source)
        until = min(transfer['authority_until'], authority_until(cur, source, task, limits, job))
        if transfer['adopted_run_id'] or until <= sql.utcnow() or job['state'] != 'running':
            conflict('managed_transfer_expired')
        return dict(server_time=sql.utcnow(), authority_until=until, budget_until=job['budget_until'],
                    source_run_id=source['run_id'], job_id=jid, transfer_id=transfer['transfer_id'])


@app.post('/api/tasks/{tid}/managed-jobs/{jid}/transfer/adopt', response_model=ManagedJobView)
def adopt_transfer(tid: UUID, jid: UUID, body: ManagedTransferAdopt, request: Request,
                   x_orcha_run_token: TokenHeader = None):
    digest = hashlib.sha256(body.model_dump_json().encode()).hexdigest()
    with db_cursor() as (conn, cur):
        run, task = require_managed_run(cur, str(tid), x_orcha_run_token, request)
        limits = run_limits(cur, run)
        cur.execute('SELECT * FROM managed_job_transfers WHERE transfer_id=%s AND job_id=%s',
                    (str(body.transfer_id), str(jid)))
        transfer = cur.fetchone()
        if not transfer or not capability_matches(transfer, body.capability):
            conflict('managed_transfer_unavailable')
        # Shared graph/task prefix is held. Exact old run -> transfer -> job.
        cur.execute('SELECT * FROM worker_runs WHERE run_id=%s' + sql.for_update(),
                    (transfer['source_run_id'],))
        source = cur.fetchone()
        cur.execute('SELECT * FROM managed_job_transfers WHERE transfer_id=%s' + sql.for_update(),
                    (str(body.transfer_id),))
        transfer = cur.fetchone()
        cur.execute('SELECT * FROM managed_jobs WHERE job_id=%s AND task_id=%s' + sql.for_update(),
                    (str(jid), str(tid)))
        job = cur.fetchone()
        if not job or str(source['task_id']) != str(tid):
            conflict('managed_transfer_unavailable')
        if transfer['adopted_run_id']:
            if (str(transfer['adopted_run_id']) != str(run['run_id'])
                    or transfer['payload_digest'] != digest or str(job['owner_run_id']) != str(run['run_id'])):
                conflict('managed_transfer_already_adopted')
            return job
        require_transfer_safe(cur, task, source, transfer)
        if source['status'] == 'running' or not source['ended_at']:
            conflict('managed_source_run_not_ended')
        cur.execute('SELECT * FROM worker_stop_observations WHERE run_id=%s', (source['run_id'],))
        stopped = cur.fetchone()
        if (not stopped or any(str(stopped[k]) != str(transfer[v]) for k, v in
                              [('execution_id', 'execution_id'), ('generation', 'generation')])):
            conflict('managed_positive_worker_exit_required')
        if (str(job['owner_run_id']) != str(source['run_id']) or job['version'] != body.expected_version
                or str(body.launch_nonce) != str(job['launch_nonce'])
                or body.proof_digest != transfer['proof_digest']):
            conflict('managed_transfer_identity_changed')
        if run['sandbox_container_id'] or job['state'] != 'running' or job['termination_verified']:
            conflict('managed_transfer_not_eligible')
        if job['transfers_used'] >= job['max_transfers']:
            conflict('managed_transfer_budget_exhausted')
        if (transfer['authority_until'] <= sql.utcnow()
                or authority_until(cur, source, task, run_limits(cur, source), job) <= sql.utcnow()
                or authority_until(cur, run, task, limits, job) <= sql.utcnow()):
            conflict('managed_authority_expired')
        cur.execute('SELECT id,generation FROM workflow_executions WHERE run_id=%s', (run['run_id'],))
        execution = cur.fetchone()
        if transfer['execution_id'] and (not execution or str(execution['id']) != str(transfer['execution_id'])
                                          or execution['generation'] <= transfer['generation']):
            conflict('managed_transfer_generation_changed')
        cur.execute('UPDATE managed_jobs SET owner_run_id=%s,workflow_generation=%s,'
                    'transfers_used=transfers_used+1,version=version+1 WHERE job_id=%s RETURNING *',
                    (run['run_id'], execution['generation'] if execution else None, str(jid)))
        job = cur.fetchone()
        cur.execute('UPDATE managed_job_transfers SET adopted_run_id=%s,operation_id=%s,payload_digest=%s '
                    'WHERE transfer_id=%s', (run['run_id'], str(body.operation_id), digest, str(body.transfer_id)))
        conn.commit()
        return job
