"""Bounded, durable continuation of approved unfinished Workflow work (GH #380).

Mutations run under the caller's graph -> workflow -> task -> execution locks.
Selection is read-only. Launch permits are the sole attempt counter.
"""
import json
from datetime import timedelta
from uuid import uuid4

from portal_backend import sql
from portal_backend.agent_status import log_event
from portal_backend.events import publish_event
from portal_backend.workflow_review_handoff import current_plan_approved
from portal_backend.workflow_scheduling import _time

LIMIT = 3
DELAY_SECONDS = 120


def one(cur, query, args):
    cur.execute(query, args)
    return cur.fetchone()


def automatic_attempts(cur, execution):
    cur.execute("SELECT operation_key FROM workflow_launch_permits WHERE execution_id=%s ORDER BY generation DESC",
                (execution['id'],))
    count = 0
    for permit in cur.fetchall():
        if not permit['operation_key'].startswith('auto-continue:'):
            break
        count += 1
    return count


def eligible(cur, execution, aid):
    """Same policy at confirmed stop, selection and locked reservation."""
    e = execution
    # Evidence finalization revokes the old generation even on a normal exit.
    # Continuation creates a new generation; stop intents and task state forbid restart.
    if (not e or e['state'] not in {'running', 'recovery_needed'}
            or not e['worker_stopped_at'] or e['first_stop_at']
            or str(e['claimant_id']) != str(aid)):
        return False
    t = one(cur, 'SELECT * FROM tasks WHERE id=%s', (e['task_id'],))
    w = one(cur, 'SELECT * FROM workflows WHERE id=%s', (e['workflow_id'],))
    c = one(cur, 'SELECT status FROM containers WHERE id=%s', (w['container_id'],))
    if (c['status'] != 'active' or w['status'] != 'active' or not w['launch_enabled']
            or t['status'] != 'in_progress' or t['work_revision'] != e['work_revision']
            or t.get('awaiting_owner_decision') or t.get('awaiting_loop_decision')
            or t.get('human_hold_by') or t.get('start_hold')):
        return False
    if not one(cur, """SELECT 1 FROM agent_tasks at JOIN agents a ON a.id=at.agent_id
            WHERE at.task_id=%s AND at.agent_id=%s AND a.kind='ai' AND a.terminated_at IS NULL
              AND at.assignment_status IN ('assigned','accepted','working')""", (t['id'], aid)):
        return False
    if one(cur, 'SELECT 1 FROM workflow_stop_intents WHERE execution_id=%s AND generation=%s',
           (e['id'], e['generation'])):
        return False
    # Only the active side may continue: a reviewer or an author correcting feedback.
    if one(cur, """SELECT 1 FROM workflow_review_handoffs
            WHERE (source_task_id=%s AND source_work_revision=%s AND phase IN ('source_stopping','review','review_stopping','clean'))
               OR (review_task_id=%s AND review_work_revision=%s AND phase IN ('source_stopping','review_stopping','correction','clean'))""",
           (t['id'], t['work_revision'], t['id'], t['work_revision'])):
        return False
    if t.get('autonomy') != 'on' and not current_plan_approved(cur, t):
        return False
    if one(cur, """SELECT 1 FROM requests WHERE requester_id=%s AND status IN ('open','accepted')
            AND (originating_task_id=%s OR (originating_task_id IS NULL AND created_at >= %s)) LIMIT 1""",
           (aid, t['id'], e['created_at'])):
        return False
    run = one(cur, 'SELECT * FROM worker_runs WHERE run_id=%s', (e['run_id'],))
    permit = one(cur, 'SELECT * FROM workflow_launch_permits WHERE run_id=%s', (e['run_id'],))
    if (not run or not permit or str(permit['execution_id']) != str(e['id'])
            or permit['generation'] != e['generation'] or run.get('stop_requested_at')
            or run.get('sandbox_container_id')):
        return False
    if run['status'] == 'exited' and run['exit_code'] == 0:
        return True
    try:
        reason = json.loads(run.get('kill_reason') or '{}')
    except (ValueError, TypeError):
        return False
    if run['status'] != 'killed' or not isinstance(reason, dict):
        return False
    if reason.get('cause') == 'host_process_missing_after_notifier_restart':
        return True
    # The notifier checkpoints and positively stops managed commands before
    # ending this worker. Keep the ordinary schedule/approval/count gates above;
    # this is not a new immediate or unbounded restart path.
    return (reason.get('cause') == 'managed_checkpoint'
            and bool(one(cur, 'SELECT 1 FROM managed_jobs WHERE owner_run_id=%s LIMIT 1', (run['run_id'],))))


def limit_notice(cur, execution):
    # One generation-keyed audit marker, serialized by the execution lock.
    if one(cur, "SELECT 1 FROM events WHERE entity_id=%s AND event_type='automatic_continuation_limit'",
           (execution['run_id'],)):
        return
    task = one(cur, 'SELECT title,container_id FROM tasks WHERE id=%s', (execution['task_id'],))
    aid, cid = str(execution['claimant_id']), str(task['container_id'])
    agent = one(cur, 'SELECT alias FROM agents WHERE id=%s', (aid,))
    message = (f"{agent['alias']} reached the automatic continuation limit for “{task['title']}” "
               f"after {LIMIT} additional runs. Work is saved but remains unfinished. "
               "Please check the task and answer this request to continue or give new direction.")
    cur.execute('INSERT INTO task_messages (task_id,author_id,body) VALUES (%s,NULL,%s)',
                (execution['task_id'], message))
    from portal_backend.org_chart import route_via_manager, stamp_routing
    from portal_backend.guards import find_actionable_human
    recipient, routing = route_via_manager(cur, cid, aid)
    recipient = recipient or find_actionable_human(cur, cid)
    rid = None
    if recipient:
        cur.execute("""INSERT INTO requests (container_id,type,requester_id,target_id,priority,status,
                       payload,expires_at,chain_depth,originating_task_id)
                       VALUES (%s,'info',%s,%s,100,'open',%s,%s,0,%s) RETURNING id""",
                    (cid, aid, recipient, message, sql.from_now(7 * 86400), execution['task_id']))
        rid = str(cur.fetchone()['id'])
        stamp_routing(cur, rid, routing)
        log_event(cur, cid, 'system', None, 'request', rid, 'created',
                  {'reason': 'automatic_continuation_limit', 'preview': message[:120]})
        publish_event(cur, cid, str(recipient), 'request_created',
                      {'request_id': rid, 'type': 'info', 'from_agent_id': aid, 'preview': message[:120]})
    log_event(cur, cid, 'system', None, 'run', execution['run_id'], 'automatic_continuation_limit',
              {'task_id': str(execution['task_id']), 'generation': execution['generation'], 'request_id': rid})


def schedule(cur, execution_id, aid):
    e = one(cur, 'SELECT * FROM workflow_executions WHERE id=%s', (execution_id,))
    if not eligible(cur, e, aid):
        return
    existing = one(cur, 'SELECT * FROM agent_self_wake WHERE agent_id=%s AND task_id=%s', (aid, e['task_id']))
    if existing and (not existing['auto_continue_run_id'] or str(existing['auto_continue_run_id']) == str(e['run_id'])):
        return
    if automatic_attempts(cur, e) >= LIMIT:
        limit_notice(cur, e)
        return
    cur.execute("""INSERT INTO agent_self_wake (id,agent_id,task_id,resume_at,context,auto_continue_run_id)
                   VALUES (%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (agent_id,task_id) DO UPDATE SET id=EXCLUDED.id,
                     resume_at=EXCLUDED.resume_at,context=EXCLUDED.context,
                     auto_continue_run_id=EXCLUDED.auto_continue_run_id,created_at=now()
                   WHERE agent_self_wake.auto_continue_run_id IS NOT NULL
                     AND agent_self_wake.auto_continue_run_id<>EXCLUDED.auto_continue_run_id""",
                (str(uuid4()), aid, e['task_id'], sql.utcnow() + timedelta(seconds=DELAY_SECONDS),
                 'Continue the approved unfinished task. Read the saved progress and current task thread.', e['run_id']))


def schedule_eligible(cur, row, aid):
    e = one(cur, """SELECT e.* FROM workflow_executions e
                    JOIN workflow_launch_permits p ON p.execution_id=e.id
                    WHERE p.run_id=%s AND e.run_id=p.run_id AND e.generation=p.generation""",
            (row['auto_continue_run_id'],))
    return bool(e and str(e['task_id']) == str(row['task_id']) and eligible(cur, e, aid)
                and automatic_attempts(cur, e) < LIMIT)


def reserve_refusal(cur, execution, aid, schedule_id, previous_run_id):
    """A refusal is returned (not raised) so exact-row cleanup commits with it."""
    row = one(cur, 'SELECT * FROM agent_self_wake WHERE agent_id=%s AND task_id=%s AND id=%s',
              (aid, execution['task_id'], schedule_id))
    if not row or not row['auto_continue_run_id']:
        return 'The automatic continuation schedule has been replaced or consumed.'
    if (str(row['auto_continue_run_id']) != str(previous_run_id)
            or not schedule_eligible(cur, row, aid)):
        cur.execute('DELETE FROM agent_self_wake WHERE id=%s AND auto_continue_run_id IS NOT NULL', (schedule_id,))
        return 'This automatic continuation no longer applies to the current task.'
    if _time(row['resume_at']) > sql.utcnow():
        return 'The automatic continuation is not due yet.'
    return None


def consume_automatic(cur, aid, tid):
    cur.execute('DELETE FROM agent_self_wake WHERE agent_id=%s AND task_id=%s AND auto_continue_run_id IS NOT NULL',
                (aid, tid))


def cleanup_obsolete(cur, aid):
    """Daemon-only cleanup; a live worker/lease alone never invalidates a wait."""
    cur.execute("""DELETE FROM agent_self_wake AS sw WHERE sw.agent_id=%s AND (
        NOT EXISTS (SELECT 1 FROM tasks t JOIN agent_tasks at ON at.task_id=t.id
            WHERE t.id=sw.task_id AND at.agent_id=sw.agent_id AND t.status='in_progress'
              AND at.assignment_status IN ('assigned','accepted','working'))
        OR (sw.auto_continue_run_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM workflow_executions e WHERE e.run_id=sw.auto_continue_run_id
              AND e.task_id=sw.task_id AND e.claimant_id=sw.agent_id
              AND e.state IN ('running','recovery_needed') AND e.first_stop_at IS NULL)))""", (aid,))
