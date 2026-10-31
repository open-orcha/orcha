"""Durable completion receipts. Callers hold graph/task/run/lane before jobs.

Observation is evidence, never permission to execute. Reading or delivering an
outcome never consumes it; only exact current-worker handling does that.
"""

import hashlib
from datetime import timedelta
from uuid import UUID, uuid4, uuid5

from portal_backend import sql
from portal_backend.managed_run_auth import conflict
from portal_backend.schemas.job_monitors import JobOutcome, ObservationReceipt
from portal_backend.task_autonomy_service import task_completion_blockers
from portal_backend.workflow_evidence_service import _lock_context
from portal_backend.workflow_review_handoff import current_plan_approved


def one(cur, query, args=()):
    cur.execute(query, args)
    return cur.fetchone()


def lock_monitor(cur, tid, jid):
    initial = one(cur, 'SELECT owner_run_id FROM managed_jobs WHERE job_id=%s AND task_id=%s', (jid, tid))
    if not initial:
        conflict('managed_job_unavailable')
    run, task, execution = _lock_context(cur, initial['owner_run_id'])
    one(cur, 'SELECT * FROM agent_wake_state WHERE agent_id=%s' + sql.for_update(), (run['agent_id'],))
    job = one(cur, 'SELECT * FROM managed_jobs WHERE job_id=%s' + sql.for_update(), (jid,))
    if str(job['owner_run_id']) != str(run['run_id']):
        conflict('managed_job_owner_changed')
    monitor = one(cur, 'SELECT * FROM managed_job_monitors WHERE job_id=%s' + sql.for_update(), (jid,))
    if not monitor:
        conflict('managed_monitor_unavailable')
    return run, task, job, monitor


def register_monitor(cur, run, task, job, body, limits):
    existing = one(cur, 'SELECT * FROM managed_job_monitors WHERE job_id=%s', (job['job_id'],))
    if existing:
        if (existing['continue_after_exit'] != body.continue_after_exit
                or existing['capability_digest'] != body.continuation_capability_digest):
            conflict('managed_monitor_registration_conflict')
        return
    if body.continue_after_exit and (body.continuation_contract != 'readonly_single_process_v1'
            or task.get('workflow_id') or run['sandbox_container_id'] or run['wake_kind'] != 'ephemeral'):
        conflict('managed_continuation_requires_isolated_host')
    cur.execute('''INSERT INTO managed_job_monitors
        (job_id,agent_id,launch_run_id,work_revision,continue_after_exit,capability_digest,execution_until)
        VALUES (%s,%s,%s,%s,%s,%s,%s)''',
        (job['job_id'], run['agent_id'], run['run_id'], task['work_revision'], body.continue_after_exit,
         body.continuation_capability_digest, min(limits['run_until'], job['budget_until'])))


def latest_outcome(cur, jid):
    return one(cur, '''SELECT o.* FROM managed_job_outcomes o JOIN managed_job_monitors m ON m.job_id=o.job_id
                      AND m.outcome_revision=o.revision WHERE o.job_id=%s''', (jid,))


def record_outcome(cur, job):
    """Commit alongside checkpoint/evidence. Only stronger evidence advances."""
    if job['state'] in {'reserved', 'running'}:
        return None
    monitor = one(cur, 'SELECT * FROM managed_job_monitors WHERE job_id=%s' + sql.for_update(), (job['job_id'],))
    if not monitor:
        return None  # Pre-migration records remain recoverable through the old path.
    previous = latest_outcome(cur, job['job_id'])
    if previous and (previous['termination_verified'] or not job['termination_verified']):
        return previous
    revision = monitor['outcome_revision'] + 1
    # Unknown termination is always uncertainty, including an unverified budget exit.
    verified = bool(job['termination_verified'])
    cur.execute('''INSERT INTO managed_job_outcomes(job_id,revision,state,result_digest,termination_verified,reason)
        VALUES (%s,%s,%s,%s,%s,%s) RETURNING *''',
        (job['job_id'], revision, job['state'] if verified else 'unknown',
         job['result_digest'] if verified else None, verified,
         'result_saved' if verified else 'evidence_unavailable'))
    outcome = cur.fetchone()
    cur.execute('UPDATE managed_job_monitors SET outcome_revision=%s WHERE job_id=%s', (revision, job['job_id']))
    cur.execute('DELETE FROM managed_job_waits WHERE job_id=%s', (job['job_id'],))
    return outcome


def observe(cur, job, body):
    digest = hashlib.sha256(body.model_dump_json().encode()).hexdigest()
    saved = one(cur, 'SELECT * FROM managed_job_monitor_operations WHERE job_id=%s AND operation_id=%s',
                (job['job_id'], str(body.operation_id)))
    if saved:
        if saved['payload_digest'] != digest:
            conflict('managed_observation_conflict')
        return saved['receipt']
    if (str(job['owner_run_id']) != str(body.owner_run_id)
            or str(job['launch_nonce']) != str(body.launch_nonce)):
        conflict('managed_recovery_identity_changed')
    if body.state in {'reserved', 'running'}:
        conflict('managed_observation_requires_outcome')
    if job['termination_verified']:
        if (not body.termination_verified or job['result_digest'] != body.result_digest
                or job['state'] != body.state):
            conflict('managed_terminal_evidence_immutable')
    elif body.expected_version != job['version'] or body.checkpoint_version <= job['checkpoint_version']:
        conflict('managed_checkpoint_version_changed')
    else:
        cur.execute('''UPDATE managed_jobs SET version=version+1,state=%s,checkpoint_version=%s,
            checkpoint_digest=%s,result_digest=%s,termination_verified=%s WHERE job_id=%s RETURNING *''',
            (body.state, body.checkpoint_version, body.checkpoint_digest, body.result_digest,
             body.termination_verified, job['job_id']))
        job = cur.fetchone()
    outcome = record_outcome(cur, job)
    receipt = ObservationReceipt(job=job, outcome=outcome).model_dump(mode='json')
    cur.execute('INSERT INTO managed_job_monitor_operations(job_id,operation_id,payload_digest,receipt) '
                'VALUES (%s,%s,%s,%s)', (job['job_id'], str(body.operation_id), digest, sql.json_param(receipt)))
    return receipt


def revoke(cur, jid, reason, *, suppress=False):
    cur.execute('''UPDATE managed_job_monitors SET revoked_at=COALESCE(revoked_at,now()),
        stop_reason=COALESCE(stop_reason,%s),suppress_wake=(suppress_wake OR %s)
        WHERE job_id=%s RETURNING *''', (reason, suppress, jid))
    return cur.fetchone()


def revoke_run(cur, rid):
    cur.execute('''UPDATE managed_job_monitors SET revoked_at=COALESCE(revoked_at,now()),
        stop_reason=COALESCE(stop_reason,'explicit_stop'),suppress_wake=true
        WHERE launch_run_id=%s RETURNING job_id''', (rid,))
    return len(cur.fetchall())


def execution_refusal(cur, run, task, job, monitor):
    if monitor['revoked_at']:
        return 'revoked'
    if (not monitor['continue_after_exit'] or str(run['run_id']) != str(monitor['launch_run_id'])
            or task.get('workflow_id') or run['sandbox_container_id'] or run['wake_kind'] != 'ephemeral'):
        return 'unsupported_continuation'
    if run['stop_requested_at']:
        return 'explicit_stop'
    if (task_completion_blockers(task) or task.get('human_hold_by') or task.get('awaiting_loop_decision')
            or task['work_revision'] != monitor['work_revision']):
        return 'task_unavailable'
    agent = one(cur, '''SELECT a.terminated_at,c.status FROM agents a JOIN containers c ON c.id=a.container_id
        WHERE a.id=%s''', (monitor['agent_id'],))
    if not agent or agent['terminated_at'] or agent['status'] != 'active':
        return 'project_unavailable'
    if not one(cur, '''SELECT 1 FROM agent_tasks WHERE task_id=%s AND agent_id=%s
        AND assignment_status IN ('assigned','accepted','working')''', (task['id'], monitor['agent_id'])):
        return 'assignment_changed'
    limits = one(cur, 'SELECT * FROM managed_run_limits WHERE run_id=%s', (monitor['launch_run_id'],))
    if not limits or min(monitor['execution_until'], limits['run_until'], job['budget_until']) <= sql.utcnow():
        return 'deadline_reached'
    if job['state'] not in {'reserved', 'running'}:
        return 'job_not_live'
    return None


def task_waiting(cur, tid, aid, *, source_run_id=None):
    params = [tid, aid]
    source = ''
    if source_run_id:
        source = ' AND w.source_run_id=%s'
        params.append(source_run_id)
    return bool(one(cur, '''SELECT 1 FROM managed_job_waits w
        JOIN managed_jobs j ON j.job_id=w.job_id JOIN managed_job_monitors m ON m.job_id=j.job_id
        JOIN tasks t ON t.id=j.task_id WHERE j.task_id=%s AND m.agent_id=%s
          AND w.work_revision=t.work_revision AND m.revoked_at IS NULL
          AND j.state IN ('reserved','running')''' + source + ' LIMIT 1', tuple(params)))


def register_unexpected_waits(cur, run):
    """An ended source's pre-authorized jobs suppress only its recovery trigger."""
    cur.execute('''INSERT INTO managed_job_waits(job_id,source_run_id,work_revision)
        SELECT m.job_id,%s,m.work_revision FROM managed_job_monitors m
        JOIN managed_jobs j ON j.job_id=m.job_id JOIN tasks t ON t.id=j.task_id
        WHERE m.launch_run_id=%s AND m.continue_after_exit=true AND m.revoked_at IS NULL
          AND j.state IN ('reserved','running') AND t.work_revision=m.work_revision
        ON CONFLICT(job_id) DO NOTHING''', (run['run_id'], run['run_id']))


def completion_eligible(cur, aid, reason, *, locked=False):
    """Exact task admission; agent policy/lease/budget checks remain with caller."""
    if str(reason.agent_id) != str(aid):
        return False
    if locked:
        _, task, job, monitor = lock_monitor(cur, str(reason.task_id), str(reason.job_id))
    else:
        task = one(cur, 'SELECT * FROM tasks WHERE id=%s', (str(reason.task_id),))
        job = one(cur, 'SELECT * FROM managed_jobs WHERE job_id=%s', (str(reason.job_id),))
        monitor = one(cur, 'SELECT * FROM managed_job_monitors WHERE job_id=%s', (str(reason.job_id),))
    if (not task or not job or not monitor or str(job['task_id']) != str(task['id'])
            or str(monitor['agent_id']) != str(aid) or monitor['suppress_wake']
            or task['work_revision'] != reason.work_revision or monitor['work_revision'] != reason.work_revision
            or task_completion_blockers(task) or task.get('human_hold_by') or task.get('awaiting_loop_decision')):
        return False
    source = one(cur, 'SELECT stop_requested_at FROM worker_runs WHERE run_id=%s', (monitor['launch_run_id'],))
    policy = one(cur, '''SELECT a.terminated_at,c.status,c.wakes_enabled,r.wake_enabled
        FROM agents a JOIN containers c ON c.id=a.container_id
        LEFT JOIN agent_reachability r ON r.agent_id=a.id WHERE a.id=%s''', (aid,))
    if (not source or source['stop_requested_at'] or not policy or policy['terminated_at']
            or policy['status'] != 'active' or not policy['wakes_enabled'] or policy['wake_enabled'] is False):
        return False
    if not one(cur, '''SELECT 1 FROM agent_tasks WHERE task_id=%s AND agent_id=%s
        AND assignment_status IN ('assigned','accepted','working')''', (task['id'], aid)):
        return False
    if task.get('autonomy') != 'on' and not current_plan_approved(cur, task):
        return False
    if one(cur, '''SELECT 1 FROM task_dependencies d JOIN tasks p ON p.id=d.depends_on_id
        WHERE d.task_id=%s AND p.status NOT IN ('completed','cancelled') LIMIT 1''', (task['id'],)):
        return False
    outcome = latest_outcome(cur, job['job_id'])
    if (not outcome or outcome['revision'] != reason.outcome_revision or outcome['handled_at']
            or outcome['attempts'] >= 3 or outcome['next_attempt_at'] > sql.utcnow()):
        return False
    expected = uuid5(UUID(str(job['job_id'])), f"completion:{outcome['revision']}:{outcome['attempts']}")
    if reason.operation_id != expected:
        return False
    if task.get('workflow_id'):
        from portal_backend.workflow_continuation import eligible, automatic_attempts, LIMIT, DELAY_SECONDS
        execution = one(cur, '''SELECT * FROM workflow_executions WHERE task_id=%s AND claimant_id=%s
            ORDER BY generation DESC LIMIT 1''', (task['id'], aid))
        if (not eligible(cur, execution, aid) or automatic_attempts(cur, execution) >= LIMIT
                or execution['worker_stopped_at'] + timedelta(seconds=DELAY_SECONDS) > sql.utcnow()):
            return False
        schedule = one(cur, 'SELECT * FROM agent_self_wake WHERE agent_id=%s AND task_id=%s', (aid, task['id']))
        if schedule and schedule['resume_at'] > sql.utcnow():
            return False
    return True


def consume_attempt(cur, reason, admission_id=None):
    """Record one admitted launch; returns its identity, or None when nothing was admitted."""
    admission_id = str(admission_id or uuid4())
    cur.execute('''INSERT INTO managed_job_wake_receipts(admission_id,job_id,outcome_revision,operation_id)
        VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING RETURNING admission_id''',
        (admission_id, str(reason.job_id), reason.outcome_revision, str(reason.operation_id)))
    if not cur.fetchone():
        return None
    outcome = latest_outcome(cur, str(reason.job_id))
    cur.execute('''UPDATE managed_job_outcomes SET attempts=attempts+1,next_attempt_at=%s
        WHERE job_id=%s AND revision=%s''',
        (sql.utcnow() + timedelta(seconds=(30, 120, 300)[outcome['attempts']]), str(reason.job_id), reason.outcome_revision))
    return admission_id


def release_unlaunched_attempt(cur, reason, agent_id):
    """Return an admission that started no worker (host capacity or lost claim reply).

Only the exact launch identity granted to this agent can be returned, only while
it is the latest admission, and never once any work-lane worker has started for
the agent since it. A returned identity stays recorded, so a replay or another
launcher's refusal can never release a later admission; a lost release keeps
the attempt spent.
"""
    receipt = one(cur, '''SELECT admitted_at FROM managed_job_wake_receipts WHERE admission_id=%s
        AND job_id=%s AND outcome_revision=%s AND operation_id=%s AND released_at IS NULL''',
        (str(reason.admission_id), str(reason.job_id), reason.outcome_revision, str(reason.operation_id)))
    outcome = latest_outcome(cur, str(reason.job_id))
    if (str(reason.agent_id) != str(agent_id) or not receipt or not outcome
            or outcome['revision'] != reason.outcome_revision or outcome['attempts'] < 1
            or reason.operation_id != uuid5(UUID(str(reason.job_id)),
                                            f"completion:{outcome['revision']}:{outcome['attempts'] - 1}")):
        return False
    started = one(cur, '''SELECT started_at FROM worker_runs WHERE agent_id=%s AND lane='work'
        ORDER BY started_at DESC LIMIT 1''', (str(agent_id),))
    if started and started['started_at'] >= receipt['admitted_at']:
        return False
    cur.execute('UPDATE managed_job_wake_receipts SET released_at=%s WHERE admission_id=%s',
                (sql.utcnow(), str(reason.admission_id)))
    cur.execute('''UPDATE managed_job_outcomes SET attempts=attempts-1 WHERE job_id=%s AND revision=%s
        AND attempts=%s''', (str(reason.job_id), reason.outcome_revision, outcome['attempts']))
    return True


def select_completion(cur, aid):
    from portal_backend.schemas.job_monitors import CompletionReason
    cur.execute('''SELECT j.task_id,m.*,o.revision,o.attempts FROM managed_job_monitors m
        JOIN managed_jobs j ON j.job_id=m.job_id JOIN managed_job_outcomes o
        ON o.job_id=m.job_id AND o.revision=m.outcome_revision WHERE m.agent_id=%s
        AND m.suppress_wake=false AND o.handled_at IS NULL AND o.attempts<3
        AND o.next_attempt_at<=now() ORDER BY o.created_at,m.job_id''', (aid,))
    for row in cur.fetchall():
        reason = CompletionReason(task_id=row['task_id'], agent_id=aid, work_revision=row['work_revision'],
            job_id=row['job_id'], outcome_revision=row['revision'],
            operation_id=uuid5(UUID(str(row['job_id'])), f"completion:{row['revision']}:{row['attempts']}"))
        if completion_eligible(cur, aid, reason):
            return reason
    return None


def waiting_event_ids(cur, aid, delivered_ts):
    """Hold only source-run recovery directives, never guidance or answers."""
    cur.execute('''SELECT id,ts,payload FROM agent_events WHERE event_key=%s AND ts>%s
                   AND event_name='task_assigned' ''', (aid, delivered_ts))
    held = set()
    for event in cur.fetchall():
        payload = event['payload'] or {}
        if payload.get('task_id'):
            sources = one(cur, '''SELECT MAX(r.started_at) AS source_started_at FROM managed_job_monitors m
                JOIN managed_jobs j ON j.job_id=m.job_id JOIN worker_runs r ON r.run_id=m.launch_run_id
                JOIN tasks t ON t.id=j.task_id WHERE j.task_id=%s AND m.agent_id=%s
                AND m.work_revision=t.work_revision AND (m.suppress_wake=true OR EXISTS
                (SELECT 1 FROM managed_job_waits w WHERE w.job_id=m.job_id) OR EXISTS
                (SELECT 1 FROM managed_job_outcomes o WHERE o.job_id=m.job_id
                 AND o.revision=m.outcome_revision AND o.handled_at IS NULL))''', (payload['task_id'],aid))
            if sources and sources['source_started_at'] and event['ts'] <= sources['source_started_at'].timestamp():
                held.add(event['id'])
                continue
        if (payload.get('reason') == 'notifier_restart_recovery' and payload.get('interrupted_run_id')
                and payload.get('task_id') and task_waiting(cur, payload['task_id'], aid,
                    source_run_id=payload['interrupted_run_id'])):
            held.add(event['id'])
    return held


def has_pending_monitor_work(cur, aid):
    return bool(one(cur, '''SELECT 1 FROM managed_job_monitors m JOIN managed_jobs j ON j.job_id=m.job_id
        JOIN tasks t ON t.id=j.task_id LEFT JOIN managed_job_outcomes o
        ON o.job_id=m.job_id AND o.revision=m.outcome_revision WHERE m.agent_id=%s
        AND t.status='in_progress' AND t.work_revision=m.work_revision AND
        (EXISTS(SELECT 1 FROM managed_job_waits w WHERE w.job_id=m.job_id)
         OR (o.revision IS NOT NULL AND o.handled_at IS NULL)) LIMIT 1''', (aid,)))


def notify_exhausted(cur, run):
    """Only after the last admitted worker exits without handling the outcome."""
    if not run.get('task_id'):
        return
    cur.execute('''SELECT o.job_id,o.revision FROM managed_job_outcomes o JOIN managed_job_monitors m
        ON m.job_id=o.job_id AND m.outcome_revision=o.revision JOIN managed_jobs j ON j.job_id=m.job_id
        WHERE j.task_id=%s AND m.agent_id=%s AND o.attempts=3 AND o.handled_at IS NULL
        AND o.exhaustion_notified_at IS NULL''', (run['task_id'], run['agent_id']))
    outcomes = cur.fetchall()
    if not outcomes:
        return
    task = one(cur, 'SELECT title,container_id FROM tasks WHERE id=%s', (run['task_id'],))
    from portal_backend.org_chart import route_via_manager, stamp_routing
    from portal_backend.guards import find_actionable_human
    from portal_backend.events import publish_event
    from portal_backend.agent_status import log_event
    aid, cid = str(run['agent_id']), str(task['container_id'])
    recipient, routing = route_via_manager(cur, cid, aid)
    recipient = recipient or find_actionable_human(cur, cid)
    message = (f'The saved command result for “{task["title"]}” still needs attention after three resume attempts. '
               'The result and progress are preserved. Please review the task and give direction.')
    for outcome in outcomes:
        cur.execute('UPDATE managed_job_outcomes SET exhaustion_notified_at=now() WHERE job_id=%s AND revision=%s',
                    (outcome['job_id'], outcome['revision']))
    cur.execute('INSERT INTO task_messages(task_id,author_id,body) VALUES (%s,NULL,%s)', (run['task_id'],message))
    if recipient:
        cur.execute('''INSERT INTO requests(container_id,type,requester_id,target_id,priority,status,payload,
            expires_at,chain_depth,originating_task_id) VALUES (%s,'info',%s,%s,100,'open',%s,%s,0,%s) RETURNING id''',
            (cid,aid,recipient,message,sql.from_now(7*86400),run['task_id']))
        rid = str(cur.fetchone()['id'])
        stamp_routing(cur,rid,routing)
        log_event(cur,cid,'system',None,'request',rid,'created',{'reason':'managed_completion_limit'})
        publish_event(cur,cid,str(recipient),'request_created',
            {'request_id':rid,'type':'info','from_agent_id':aid,'preview':message[:120]})
