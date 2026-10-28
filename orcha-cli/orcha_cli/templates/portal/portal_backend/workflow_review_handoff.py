"""Explicit review/correction turns. A handoff never accepts or verifies work.

All writes hold graph -> workflow -> tasks -> execution locks. The runner's positive
exit observation is the only seam that releases capacity and routes the next turn.
"""
import json
from uuid import UUID, uuid4

from portal_backend import sql
from portal_backend.events import publish_event
from portal_backend.task_approval_policy import requirements_digest
from portal_backend.workflow_graph import conflict
from portal_backend.workflow_worker_stops import fence_execution

ACTIVE_PHASES = ('source_stopping', 'review', 'review_stopping', 'correction')


def active_handoff(cur, wid):
    cur.execute("SELECT * FROM workflow_review_handoffs WHERE workflow_id=%s AND phase IN ('source_stopping','review','review_stopping','correction')", (wid,))
    row = cur.fetchone()
    return {k: str(v) if isinstance(v, UUID) else v for k,v in row.items()} if row else None


def interrupt_handoff(svc, w, reason, task_id=None):
    """End an interrupted round without releasing a worker or waiving CLEAN.

    Surviving work needs an explicit owner Retry. Existing holds, evidence and
    executions remain intact; an unconfirmed worker still owns its slot.
    """
    h = active_handoff(svc.cur, w['id'])
    if not h or (task_id and task_id not in (h['source_task_id'], h['review_task_id'])):
        return
    svc.cur.execute("UPDATE workflow_review_handoffs SET phase='cancelled' WHERE id=%s", (h['id'],))
    for tid in (h['source_task_id'], h['review_task_id']):
        svc.cur.execute("""UPDATE tasks SET status='not_ready',
            awaiting_owner_decision=COALESCE(awaiting_owner_decision,'worker_released'),
            owner_decision_at=COALESCE(owner_decision_at,%s)
            WHERE id=%s AND status NOT IN ('completed','cancelled')""", (sql.utcnow(), tid))
    from portal_backend.agent_status import log_event
    log_event(svc.cur, w['container_id'], 'system', None, 'task', h['source_task_id'],
              'review_handoff_interrupted', {'handoff_id': h['id'], 'reason': reason})


def reconcile_handoff(svc, w):
    h = active_handoff(svc.cur, w['id'])
    if not h:
        return
    if w['status'] in {'cancelled', 'completed'}:
        interrupt_handoff(svc, w, 'workflow_terminal')
        return
    for side in ('source', 'review'):
        t = svc.task(w['id'], h[side + '_task_id'])
        if t['status'] in {'completed', 'cancelled'} or t['work_revision'] != h[side + '_work_revision']:
            interrupt_handoff(svc, w, 'task_changed')
            return
        # Check the current turn too: correction may already have a new execution.
        e = svc.live_turn(t['id'])
        if e and (e['first_stop_at'] or e['state'] == 'stopping'):
            interrupt_handoff(svc, w, 'worker_stopping')
            return
    for field in ('source_execution_id', 'review_execution_id'):
        if h[field]:
            e = svc.one('SELECT * FROM workflow_executions WHERE id=%s', (h[field],))
            if e and (e['first_stop_at'] or e['state'] in {'released_lost','aborted'} or
                      (e['state'] == 'released' and e['release_reason'] != 'review_handoff')):
                interrupt_handoff(svc, w, 'worker_released')
                return


def require_independent_reviewer(svc, source_task_id, source_execution_id, reviewer_id):
    source = svc.one('SELECT claimant_id FROM workflow_executions WHERE id=%s', (source_execution_id,))
    assigned = svc.one("SELECT 1 AS n FROM agent_tasks WHERE task_id=%s AND agent_id=%s AND assignment_status<>'done'",
                       (source_task_id, reviewer_id))
    if assigned or (source and str(source['claimant_id']) == str(reviewer_id)):
        conflict('independent_review_required', 'The author cannot take the independent review turn.')


def guard_review_claim(svc, wid, task_id, reviewer_id):
    handoff = active_handoff(svc.cur, wid)
    if handoff and handoff['phase'] == 'review' and handoff['review_task_id'] == task_id:
        require_independent_reviewer(svc, handoff['source_task_id'], handoff['source_execution_id'], reviewer_id)


def require_plan(cur, task):
    # A handoff is implementation work, not permission to approve its own plan.
    cur.execute("""SELECT 1 FROM task_approval_records WHERE task_id=%s AND phase='plan'
        AND work_revision=%s AND requirements_sha256=%s LIMIT 1""",
        (task['id'], task['work_revision'], requirements_digest(task)))
    approved = cur.fetchone()
    cur.execute("SELECT decision FROM decisions WHERE subject_type='plan_approval' AND subject_id=%s ORDER BY created_at DESC LIMIT 1", (str(task['id']),))
    latest = cur.fetchone()
    if not approved or not latest or latest['decision'] != 'approve':
        conflict('plan_approval_required', 'Approve the current plan before handing off work.')


def _capture(cur, task, execution, result):
    from portal_backend.workflow_evidence_service import capture_workflow_submission
    cur.execute('SELECT COALESCE(max(source_sequence),0)+1 AS n FROM workflow_evidence_sets WHERE workflow_execution_id=%s', (execution['id'],))
    capture_workflow_submission(cur, str(execution['run_id']), generation=execution['generation'],
        work_revision=task['work_revision'], source_sequence=cur.fetchone()['n'], result=result,
        source_revision=None, captured_by=str(execution['claimant_id']), requires_file_changes=False)


def request_review(svc, w, source, execution, review, result):
    svc.active(w)
    previous = svc.one('SELECT * FROM workflow_review_handoffs WHERE source_execution_id=%s', (execution['id'],))
    if previous:
        if previous['review_task_id'] != review['id'] or previous['source_result'] != result:
            conflict('handoff_receipt_conflict', 'This turn already handed off different work.')
        return {'handoff_id': str(previous['id']), 'phase': previous['phase']}
    require_plan(svc.cur, source)
    if source['status'] != 'in_progress' or review['status'] not in {'ready', 'in_progress'}:
        conflict('handoff_unavailable', 'Both unfinished tasks must be available for a review handoff.')
    if source['id'] == review['id']:
        conflict('independent_review_required', 'Choose a different assigned reviewer.')
    for reviewer in svc.rows("SELECT agent_id FROM agent_tasks WHERE task_id=%s AND assignment_status<>'done'", (review['id'],)):
        require_independent_reviewer(svc, source['id'], execution['id'], reviewer['agent_id'])
    prior = active_handoff(svc.cur, w['id'])
    if prior:
        if (prior['phase'] != 'correction' or prior['source_task_id'] != source['id']
                or prior['review_task_id'] != review['id']):
            conflict('handoff_in_progress', 'Finish the current review handoff first.')
    # No dependency or hold may be waived. Assess the reviewer without the source's
    # exclusive turn, which is the one thing this explicit handoff will release.
    snapshot = svc.snapshot(w['id'])
    from portal_backend.workflow_scheduling import _base_blockers
    candidate = dict(review, status='ready')
    blockers = _base_blockers(dict(snapshot['workflow'], review_handoff_target=None), candidate, snapshot['tasks'],
        snapshot['dependencies'], snapshot['acceptances'], [], snapshot['outside_evidence'],
        {review['id']: svc.hooks.availability(svc.cur, review)}, 'worker')
    if blockers or svc.live_turn(review['id']):
        conflict('review_not_eligible', 'The reviewer has unmet prerequisites or a hold.', blockers=blockers)
    _capture(svc.cur, source, execution, result)
    if prior:
        svc.cur.execute("UPDATE workflow_review_handoffs SET phase='superseded' WHERE id=%s", (prior['id'],))
    hid = str(uuid4())
    svc.cur.execute('''INSERT INTO workflow_review_handoffs(id,workflow_id,source_task_id,review_task_id,
        source_execution_id,source_work_revision,review_work_revision,phase,source_result)
        VALUES (%s,%s,%s,%s,%s,%s,%s,'source_stopping',%s)''',
        (hid,w['id'],source['id'],review['id'],execution['id'],source['work_revision'],review['work_revision'],result))
    from portal_backend.workflow_service import WorkflowActor
    svc.audit(w, svc.actor(WorkflowActor(str(execution['claimant_id']), True, True), w['container_id']),
              'workflow_review_handoff_requested', {'handoff_id': hid, 'review_task_id': review['id']}, source['id'])
    return {'handoff_id': hid, 'phase': 'source_stopping', 'instruction': 'Exit this worker. The reviewer can start only after the runner confirms you stopped.'}


def record_verdict(svc, w, task, execution, hid, verdict, result):
    svc.active(w)
    require_plan(svc.cur, task)
    h = active_handoff(svc.cur, w['id'])
    if h and str(h['id']) == hid and h['phase'] == 'review_stopping' and h['review_execution_id'] == execution['id']:
        if h['verdict'] != verdict or h['review_result'] != result:
            conflict('handoff_receipt_conflict', 'This turn already recorded a different verdict.')
        return {'handoff_id': hid, 'phase': h['phase']}
    if not h or str(h['id']) != hid or h['phase'] != 'review' or h['review_task_id'] != task['id']:
        conflict('review_handoff_changed', 'This is not the current review turn.')
    source = svc.task(w['id'], h['source_task_id'], h['source_work_revision'])
    svc.task(w['id'], h['review_task_id'], h['review_work_revision'])
    require_independent_reviewer(svc, h['source_task_id'], h['source_execution_id'], execution['claimant_id'])
    saved_reference(svc, source, h['source_execution_id'])
    _capture(svc.cur, task, execution, result)
    svc.cur.execute("UPDATE workflow_review_handoffs SET phase='review_stopping',verdict=%s,review_result=%s,review_execution_id=%s WHERE id=%s",
        (verdict,result,execution['id'],hid))
    from portal_backend.workflow_service import WorkflowActor
    svc.audit(w, svc.actor(WorkflowActor(str(execution['claimant_id']), True, True), w['container_id']),
              'workflow_review_verdict', {'handoff_id': hid, 'verdict': verdict}, task['id'])
    return {'handoff_id': hid, 'phase': 'review_stopping', 'instruction': 'Exit this worker. The result will route after confirmed exit; CLEAN still requires human verification.'}


def saved_reference(svc, task, eid):
    from portal_backend.workflow_evidence_service import evidence_reference
    e = svc.one('SELECT * FROM workflow_executions WHERE id=%s', (eid,))
    if not e or e['work_revision'] != task['work_revision'] or e['evidence_state'] != 'saved':
        conflict('handoff_evidence_missing', 'Save the exact handoff evidence before proceeding.')
    ref = evidence_reference(svc.cur, e['current_evidence_set_id'])
    svc.hooks.validate_evidence(svc.cur, task, ref)
    return ref


def after_stopped(svc, w, task, execution):
    """Idempotent finalization after terminal capture, before scheduling another turn."""
    execution = {k: str(v) if isinstance(v, UUID) else v for k,v in execution.items()}
    task = {k: str(v) if isinstance(v, UUID) else v for k,v in task.items()}
    h = active_handoff(svc.cur, w['id'])
    if not h:
        return
    source_side = h['phase'] == 'source_stopping' and h['source_execution_id'] == execution['id']
    review_side = h['phase'] == 'review_stopping' and h['review_execution_id'] == execution['id']
    if not (source_side or review_side):
        return
    if w['status'] not in {'active', 'paused'} or task['status'] == 'cancelled':
        interrupt_handoff(svc, w, 'task_or_workflow_terminal')
        return
    source = svc.task(w['id'], h['source_task_id'], h['source_work_revision'])
    review = svc.task(w['id'], h['review_task_id'], h['review_work_revision'])
    if source['status'] in {'completed','cancelled'} or review['status'] in {'completed','cancelled'}:
        interrupt_handoff(svc, w, 'task_or_workflow_terminal')
        return
    current = svc.one('SELECT * FROM workflow_executions WHERE id=%s', (execution['id'],))
    if current['first_stop_at']:
        interrupt_handoff(svc, w, 'worker_stopped')
        return
    if not current['worker_stopped_at'] or current['state'] not in {'running','recovery_needed'}:
        return
    saved_reference(svc, task, execution['id'])
    fence_execution(svc.cur, current)
    svc.cur.execute("UPDATE workflow_executions SET state='released',released_at=%s,release_reason='review_handoff' WHERE id=%s", (sql.utcnow(), execution['id']))
    if source_side:
        phase, target = 'review', review
    elif h['verdict'] == 'changes_requested':
        phase, target = 'correction', source
    else:
        phase, target = 'clean', None
        saved_reference(svc, source, h['source_execution_id'])
        for t, result, eid in [(source,h['source_result'],h['source_execution_id']), (review,h['review_result'],h['review_execution_id'])]:
            svc.cur.execute("UPDATE tasks SET status='needs_verification',result=%s WHERE id=%s",
                (json.dumps({'result':result,'review_handoff_id':str(h['id'])}),t['id']))
            svc.notice(w,'workflow_task_awaiting_acceptance',t['id'],t['work_revision'])
    svc.cur.execute('UPDATE workflow_review_handoffs SET phase=%s WHERE id=%s', (phase,h['id']))
    from portal_backend.agent_status import log_event
    log_event(svc.cur, w['container_id'], 'system', None, 'task', task['id'],
              'review_handoff_routed', {'handoff_id': str(h['id']), 'phase': phase})
    if target:
        svc.cur.execute("UPDATE tasks SET status='ready' WHERE id=%s", (target['id'],))
        # Durable task-bound instructions also carry the exact reviewed artifact identity.
        for a in svc.rows("SELECT agent_id FROM agent_tasks WHERE task_id=%s AND assignment_status<>'done'", (target['id'],)):
            publish_event(svc.cur,w['container_id'],str(a['agent_id']),'task_message', {
                'task_id':str(target['id']), 'preview':f"Review handoff: {phase}. Read /api/workflows/{w['id']}/review-handoffs for the exact evidence and verdict."})


def acceptance_turn(svc, task):
    """Only CLEAN exact evidence may replace the released slot at human verification."""
    h = svc.one("SELECT * FROM workflow_review_handoffs WHERE (source_task_id=%s OR review_task_id=%s) ORDER BY created_at DESC,id DESC LIMIT 1", (task['id'],task['id']))
    if not h:
        return None
    if h['phase'] != 'clean':
        conflict('clean_review_required', 'Finish the review and correction loop before verification.')
    eid = h['source_execution_id'] if h['source_task_id'] == task['id'] else h['review_execution_id']
    saved_reference(svc,task,eid)
    return svc.one("SELECT * FROM workflow_executions WHERE id=%s AND state='released' AND release_reason='review_handoff' AND worker_stopped_at IS NOT NULL", (eid,))


def require_clean(svc, task):
    h = svc.one("SELECT * FROM workflow_review_handoffs WHERE source_task_id=%s OR review_task_id=%s ORDER BY created_at DESC,id DESC LIMIT 1", (task['id'],task['id']))
    if h and h['phase'] != 'clean':
        conflict('clean_review_required', 'Finish the review and correction loop before submitting finished work.')
    return h
