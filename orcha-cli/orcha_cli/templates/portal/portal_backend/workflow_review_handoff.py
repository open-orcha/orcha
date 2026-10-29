"""Explicit review/correction turns. A handoff never accepts or verifies work.

All writes hold graph -> workflow -> tasks -> execution locks. The runner's positive
exit observation is the only seam that releases capacity and routes the next turn.
"""
import json
from uuid import UUID, uuid4

from fastapi import HTTPException

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
    if not approved:
        # A repeat round changes the work revision, not the requirements.  Carry a
        # human-approved plan from an earlier round of this same group when its
        # requirements digest is unchanged; retries outside the group still need a
        # fresh approval.
        cur.execute("""SELECT 1
            FROM task_approval_records a
            JOIN workflow_step_instances old_i
              ON old_i.task_id=a.task_id AND old_i.work_revision=a.work_revision
            JOIN workflow_group_rounds old_r ON old_r.id=old_i.group_round_id
            JOIN workflow_repeat_group_members current_m
              ON current_m.task_id=a.task_id
            JOIN workflow_repeat_groups current_g
              ON current_g.id=current_m.group_id AND current_g.state='open'
            JOIN workflow_group_rounds current_r
              ON current_r.group_id=current_g.id
             AND current_r.round_number=current_g.current_round
            WHERE a.task_id=%s AND a.phase='plan' AND a.requirements_sha256=%s
              AND old_r.group_id=current_r.group_id
              AND old_r.round_number<=current_r.round_number
            LIMIT 1""", (task['id'], requirements_digest(task)))
        approved = cur.fetchone()
    cur.execute("SELECT decision FROM decisions WHERE subject_type='plan_approval' AND subject_id=%s ORDER BY created_at DESC LIMIT 1", (str(task['id']),))
    latest = cur.fetchone()
    if not approved or not latest or latest['decision'] != 'approve':
        conflict('plan_approval_required', 'Approve the current plan before handing off work.')


def _repeat_group_bridge(svc, w, source, review):
    """The one dependency a captured handoff may satisfy for this group round."""
    if w.get('semantics_version', 1) != 2:
        return None
    return svc.one("""SELECT g.*
        FROM workflow_repeat_groups g
        JOIN workflow_repeat_group_members source_member
          ON source_member.group_id=g.id AND source_member.task_id=%s
        JOIN workflow_repeat_group_members review_member
          ON review_member.group_id=g.id AND review_member.task_id=%s
        JOIN task_dependencies dependency
          ON dependency.task_id=%s AND dependency.depends_on_id=%s
        JOIN workflow_group_rounds round
          ON round.group_id=g.id
         AND round.round_number=g.current_round
        WHERE g.workflow_id=%s AND g.review_task_id=%s AND g.state='open'
          AND 1=(
              SELECT count(*)
              FROM task_dependencies group_dependency
              JOIN workflow_repeat_group_members group_member
                ON group_member.group_id=g.id
               AND group_member.task_id=group_dependency.depends_on_id
              WHERE group_dependency.task_id=g.review_task_id
          )
        LIMIT 1""", (
            source['id'], review['id'], review['id'], source['id'],
            w['id'], review['id'],
        ))


def _bind_group_round(svc, group, *tasks):
    """Associate edits made after Start with the group's already-open round."""
    current = svc.one(
        "SELECT id FROM workflow_group_rounds WHERE group_id=%s AND round_number=%s",
        (group['id'], group['current_round']),
    )
    if not current:
        return
    for task in tasks:
        svc.cur.execute(
            """INSERT INTO workflow_step_instances(task_id,work_revision,group_round_id)
               VALUES (%s,%s,%s)
               ON CONFLICT (task_id,work_revision)
               DO UPDATE SET group_round_id=excluded.group_round_id""",
            (task['id'], task['work_revision'], current['id']),
        )


def _group_route(svc, w, review, execution):
    """The current review worker's unapplied outcome and its resolved route."""
    decision = svc.one("""SELECT d.*,r.outcome_name,r.findings,r.note,
            r.reporter_id,r.reporter_kind,r.generation
        FROM workflow_route_decisions d
        JOIN workflow_outcome_reports r ON r.id=d.report_id
        WHERE r.task_id=%s AND r.work_revision=%s""",
        (review['id'], review['work_revision']))
    if (
        not decision
        or decision['applied_at']
        or str(decision['reporter_id']) != str(execution['claimant_id'])
        or decision['reporter_kind'] != 'ai'
        or decision['generation'] != execution['generation']
    ):
        conflict(
            'review_outcome_required',
            'Report this review turn\'s loop outcome and findings before its handoff verdict.',
        )
    from portal_backend import workflow_routing as routing
    preview = routing.resolve(
        svc.snapshot(w['id']), routing.load_flow(svc, w['id']),
        review['id'], decision['outcome_name'],
    )
    return decision, preview


def _validate_group_verdict(svc, w, group, review, execution, verdict):
    _, preview = _group_route(svc, w, review, execution)
    is_exit = (
        preview['outcome'].casefold() == group['exit_outcome'].casefold()
        and preview['destination'] not in {'return', 'ask_owner'}
    )
    if verdict == 'clean' and not is_exit:
        conflict(
            'review_verdict_outcome_mismatch',
            f"CLEAN must report the loop's exit outcome '{group['exit_outcome']}'.",
        )
    if verdict == 'changes_requested' and (
        is_exit or preview['destination'] not in {'return', 'ask_owner', 'stop'}
    ):
        conflict(
            'review_verdict_outcome_mismatch',
            'Changes requested must send work back, ask the owner, or stop the loop.',
        )


def _finalize_group_handoff(svc, w, handoff):
    """Put both exact unfinished results at the one final human-verification gate."""
    source = svc.task(w['id'], handoff['source_task_id'], handoff['source_work_revision'])
    review = svc.task(w['id'], handoff['review_task_id'], handoff['review_work_revision'])
    saved_reference(svc, source, handoff['source_execution_id'])
    saved_reference(svc, review, handoff['review_execution_id'])
    for task, result in (
        (source, handoff['source_result']),
        (review, handoff['review_result']),
    ):
        svc.cur.execute(
            "UPDATE tasks SET status='needs_verification',result=%s WHERE id=%s",
            (json.dumps({'result': result, 'review_handoff_id': str(handoff['id'])}), task['id']),
        )
        svc.notice(w, 'workflow_task_awaiting_acceptance', task['id'], task['work_revision'])
    svc.cur.execute("UPDATE workflow_review_handoffs SET phase='clean' WHERE id=%s", (handoff['id'],))


def finalize_routed_group_handoff(svc, w, review_task_id):
    """Finish an owner-routed handoff when the owner exits or stops its group."""
    review = svc.task(w['id'], review_task_id)
    group = svc.one(
        "SELECT state FROM workflow_repeat_groups WHERE workflow_id=%s AND review_task_id=%s",
        (w['id'], review_task_id),
    )
    if not group or group['state'] not in {'exited', 'stopped'}:
        return
    handoff = svc.one("""SELECT h.* FROM workflow_review_handoffs h
        JOIN tasks source ON source.id=h.source_task_id
        WHERE h.review_task_id=%s AND h.review_work_revision=%s
          AND source.work_revision=h.source_work_revision
          AND h.phase='superseded'
        ORDER BY h.created_at DESC,h.id DESC LIMIT 1""",
        (review_task_id, review['work_revision']))
    if handoff:
        _finalize_group_handoff(svc, w, handoff)


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
    group = _repeat_group_bridge(svc, w, source, review)
    if group:
        # Owners may edit an unstarted member after Start.  Keep the current
        # revisions in the already-open round so plan carry-forward and stall
        # evidence retain the round identity, including for pre-fix workflows.
        _bind_group_round(svc, group, source, review)
    require_plan(svc.cur, source)
    review_states = {'ready', 'in_progress'} | (
        {'pending', 'not_ready'} if group else set()
    )
    if source['status'] != 'in_progress' or review['status'] not in review_states:
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
    # Ordinary handoffs waive no dependency.  A same-round repeat-group handoff
    # satisfies only its direct source-to-review prerequisite; every outside
    # prerequisite, hold and admission gate remains visible here and in scheduling.
    snapshot = svc.snapshot(w['id'])
    from portal_backend.workflow_scheduling import _base_blockers
    candidate = dict(review, status='ready')
    eligibility_workflow = dict(snapshot['workflow'], review_handoff_target=None)
    if group:
        eligibility_workflow.update(
            review_handoff_target=review['id'],
            review_handoff_prerequisite=source['id'],
        )
    blockers = _base_blockers(eligibility_workflow, candidate, snapshot['tasks'],
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
    review = svc.task(w['id'], h['review_task_id'], h['review_work_revision'])
    require_independent_reviewer(svc, h['source_task_id'], h['source_execution_id'], execution['claimant_id'])
    group = _repeat_group_bridge(svc, w, source, review)
    if group:
        _validate_group_verdict(svc, w, group, review, execution, verdict)
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


def _route_group_after_stop(svc, w, source, review, execution, handoff, group):
    """Close the handoff first, then let the existing loop engine route it."""
    # An outcome may be replaced while the reviewer is stopping.  Recheck it
    # against the captured verdict at the confirmed-exit seam so the route and
    # the durable verdict can never disagree.
    _validate_group_verdict(svc, w, group, review, execution, handoff['verdict'])
    svc.cur.execute(
        "UPDATE tasks SET status='not_ready' WHERE id IN (%s,%s)",
        (source['id'], review['id']),
    )
    # _repeat bumps work revisions.  End the active handoff before applying the
    # route so reconciliation cannot mistake that intentional bump for an
    # interrupted worker and put the new round on an owner hold.
    svc.cur.execute(
        "UPDATE workflow_review_handoffs SET phase='superseded' WHERE id=%s",
        (handoff['id'],),
    )
    from portal_backend.workflow_service import WorkflowActor
    reviewer = svc.actor(
        WorkflowActor(str(execution['claimant_id']), True, True), w['container_id']
    )
    svc._apply_route(w, review, reviewer)
    state = svc.one(
        "SELECT state FROM workflow_repeat_groups WHERE workflow_id=%s AND review_task_id=%s",
        (w['id'], review['id']),
    )
    current = svc.one(
        "SELECT * FROM workflow_review_handoffs WHERE id=%s", (handoff['id'],)
    )
    if state and state['state'] in {'exited', 'stopped'}:
        _finalize_group_handoff(svc, w, current)
        return 'clean'
    return 'superseded'


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
    group = _repeat_group_bridge(svc, w, source, review) if review_side else None
    if source_side:
        phase, target = 'review', review
    elif group:
        try:
            phase = _route_group_after_stop(
                svc, w, source, review, current, h, group
            )
            target = None
        except HTTPException as exc:
            detail = exc.detail if isinstance(exc.detail, dict) else {}
            if detail.get('code') not in {
                'review_outcome_required', 'review_verdict_outcome_mismatch'
            }:
                raise
            # The confirmed worker has already released its slot.  Preserve both
            # drafts, cancel the inconsistent handoff, and give the owner an
            # explicit recovery decision instead of rolling back with a 409.
            interrupt_handoff(svc, w, 'review_outcome_changed')
            phase, target = 'cancelled', None
    elif h['verdict'] == 'changes_requested':
        phase, target = 'correction', source
    else:
        phase, target = 'clean', None
        _finalize_group_handoff(svc, w, h)
    if not group:
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


def _relevant_handoff(svc, task):
    current = svc.one("""SELECT * FROM workflow_review_handoffs
        WHERE (source_task_id=%s AND source_work_revision=%s)
           OR (review_task_id=%s AND review_work_revision=%s)
        ORDER BY created_at DESC,id DESC LIMIT 1""",
        (task['id'], task['work_revision'], task['id'], task['work_revision']))
    if current:
        return current
    # An interrupted review remains a durable CLEAN requirement across owner Retry.
    # A routed repeat round uses `superseded`, so it does not poison the next round.
    return svc.one("""SELECT * FROM workflow_review_handoffs
        WHERE (source_task_id=%s OR review_task_id=%s) AND phase='cancelled'
        ORDER BY created_at DESC,id DESC LIMIT 1""", (task['id'], task['id']))


def acceptance_turn(svc, task):
    """Only CLEAN exact evidence may replace the released slot at human verification."""
    h = _relevant_handoff(svc, task)
    if not h:
        return None
    if h['phase'] != 'clean':
        conflict('clean_review_required', 'Finish the review and correction loop before verification.')
    eid = h['source_execution_id'] if h['source_task_id'] == task['id'] else h['review_execution_id']
    saved_reference(svc,task,eid)
    return svc.one("SELECT * FROM workflow_executions WHERE id=%s AND state='released' AND release_reason='review_handoff' AND worker_stopped_at IS NOT NULL", (eid,))


def require_clean(svc, task):
    h = _relevant_handoff(svc, task)
    if h and h['phase'] != 'clean':
        conflict('clean_review_required', 'Finish the review and correction loop before submitting finished work.')
    return h
