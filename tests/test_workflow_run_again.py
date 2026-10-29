"""Completed-workflow reuse: real SQLite creation, edit, admission and execution."""
import pytest
from fastapi import HTTPException
from portal_backend import workflow_service as ws, workflow_routing as routing
from portal_backend.database import db_cursor
from test_workflows import create, prepare_and_start, setup_workflow, submit_result, uid
from test_workflow_flexible import flexible, loop_draft, flow_body, loop_ids


def rows(query, params=()):
    with db_cursor(readonly=True) as (_, cur):
        return ws.WorkflowService(cur).rows(query, params)


def detail(fixture, wid, actor=None):
    with db_cursor(readonly=True) as (_, cur):
        return ws.WorkflowService(cur, fixture[4]).detail(wid, actor or fixture[1])


def terminal_setup(w):
    """A terminal definition fixture for structural cases; execution is tested below."""
    with db_cursor() as (_, cur):
        cur.execute("UPDATE workflows SET status='completed' WHERE id=%s", (w['id'],))
    return w


def finish(fixture, w):
    execute = fixture[-1]
    evidence = []
    for task in w['tasks']:
        e, ref = submit_result(fixture, w, task['id'])
        if task.get('outcomes'):
            w = execute('report_outcome', {'outcome': task['outcomes'][0]['name'], 'findings': []}, w['id'], task['id'])
        w = execute('accept', {'evidence': ref}, w['id'], task['id'])
        with db_cursor() as (_, cur):
            ws.WorkflowService(cur, fixture[4]).release_confirmed(e['id'], e['generation'], 'exited')
        evidence.append(ref)
    basis = {'narrative': 'Checked the edited result', 'task_revisions': {t['id']: t['work_revision'] for t in w['tasks']}, 'evidence_sets': evidence}
    for objective in w['objectives']:
        w = execute('accept_objective', {'evidence': basis}, w['id'], objective['id'])
    w = execute('accept_goal', {'evidence': basis}, w['id'])
    return execute('finish', {}, w['id'])


def source_records(wid):
    return {table: rows(f'SELECT * FROM {table} WHERE {column}=%s ORDER BY id', (wid,)) for table, column in [
        ('workflows', 'id'), ('tasks', 'workflow_id'), ('workflow_history', 'workflow_id'),
        ('workflow_definition_versions', 'workflow_id'), ('workflow_executions', 'workflow_id'),
        ('workflow_task_acceptances', 'workflow_id'), ('workflow_objectives', 'workflow_id'),
    ]}


def test_copy_edit_start_and_finish_without_touching_completed_source(setup_workflow, flexible):
    f = setup_workflow
    execute = f[-1]
    source = finish(f, prepare_and_start(f, create(f, count=1)))
    before = source_records(source['id'])
    copy = execute('run_again', {}, source['id'])
    assert copy['id'] != source['id']
    assert copy['container_id'] == source['container_id']
    assert copy['owner_human_id'] == f[1].id
    assert copy['status'] == 'active' and not copy['launch_enabled']
    assert copy['definition_version'] == 0 and copy['turns_used'] == 0
    assert copy['goal_accepted_revision'] is None
    task = copy['tasks'][0]
    assert task['id'] != source['tasks'][0]['id']
    # Result acceptance sets the original assignment to done; reuse still keeps it.
    assert task['assignee_ids'] == [f[2]]
    assert task['preparation_state'] == 'prepared' and task['start_hold']
    assert not task['can_start'] and not task['human_hold_by'] and task['route_state'] is None
    for table in ('workflow_executions', 'workflow_task_acceptances', 'workflow_evidence_sets',
                  'workflow_review_rounds', 'workflow_group_rounds', 'workflow_outcome_reports',
                  'workflow_route_decisions', 'workflow_owner_decisions', 'workflow_definition_versions'):
        assert rows(f'SELECT * FROM {table} WHERE workflow_id=%s', (copy['id'],)) == []
    assert rows('SELECT * FROM task_approval_records WHERE task_id=%s', (task['id'],)) == []
    assert rows('SELECT * FROM workflow_step_instances WHERE task_id=%s', (task['id'],)) == []
    copy = execute('prepare', {'title': 'Edited step', 'description': 'New run input', 'definition_of_done': 'An edited result'}, copy['id'], task['id'])
    copy = execute('patch', {'goal': 'New run goal', 'title': 'Edited run'}, copy['id'])
    copy = execute('flow', {'steps': [{'task_id': task['id'], 'outcomes': [{'name': 'Ready', 'kind': 'success'}], 'routes': [{'outcome': 'Ready', 'destination': 'next'}]}], 'repeat_groups': []}, copy['id'])
    assert not copy['launch_enabled']
    copy = execute('start', {'task_ids': [task['id']], 'task_revisions': {task['id']: copy['tasks'][0]['work_revision']}}, copy['id'])
    assert copy['definition_version'] == 1 and copy['tasks'][0]['can_start']
    assert copy['tasks'][0]['description'] == 'New run input'
    copy = finish(f, copy)
    assert copy['status'] == 'completed' and copy['goal'] == 'New run goal'
    assert source_records(source['id']) == before


def test_fidelity_fresh_ids_limits_and_loop_state(setup_workflow, flexible):
    f = setup_workflow
    draft = loop_draft(f[2], objectives=[{'title': 'Reach readers', 'criteria': 'Public post'}], turn_allowance=73)
    draft['tasks'][0].update(description='A detailed brief', priority=12)
    source = f[-1]('create', draft)
    source = f[-1]('patch', {'task_limit': 93, 'round_limit': 9}, source['id'])
    source = prepare_and_start(f, source)
    with db_cursor() as (_, cur):
        # Final setup changed after the snapshot: these rows must win.
        cur.execute("UPDATE tasks SET description='Final brief',autonomy='on' WHERE id=%s", (source['tasks'][0]['id'],))
        cur.execute("UPDATE workflow_repeat_groups SET max_rounds=7,current_round=3,state='exited' WHERE workflow_id=%s", (source['id'],))
    terminal_setup(source)
    source = detail(f, source['id'])
    before = source_records(source['id'])
    copy = f[-1]('run_again', {}, source['id'])
    mapping = copy['created_task_ids']
    assert set(mapping) == {t['id'] for t in source['tasks']}
    assert not set(mapping) & set(mapping.values())
    for field in ('goal', 'execution_mode', 'semantics_version', 'turn_allowance', 'task_limit', 'round_limit'):
        assert copy[field] == source[field]
    for old, new in zip(source['tasks'], copy['tasks']):
        for field in ('title', 'description', 'definition_of_done', 'priority', 'outcomes', 'autonomy'):
            assert old[field] == new[field]
        assert new['depends_on'] == [mapping[d] for d in old['depends_on']]
        assert new['routes'] == [{**r, 'destination_task': mapping.get(r['destination_task'])} for r in old['routes']]
    old, new = source['repeat_groups'][0], copy['repeat_groups'][0]
    assert old['id'] != new['id'] and new['current_round'] == 0
    assert new['member_tasks'] == [mapping[t] for t in old['member_tasks']]
    assert new['review_task'] == mapping[old['review_task']]
    for field in ('name', 'exit_outcome', 'max_rounds', 'escalation_owner_id', 'stall_rule'):
        assert new[field] == old[field]
    assert copy['objectives'][0]['id'] != source['objectives'][0]['id']
    assert copy['objectives'][0]['criteria'] == 'Public post'
    assert source_records(source['id']) == before
    copy = f[-1]('flow', flow_body(loop_ids(copy), max_rounds=8), copy['id'])
    assert copy['repeat_groups'][0]['max_rounds'] == 8


def test_copy_more_than_default_task_limit(setup_workflow):
    f = setup_workflow
    source = create(f, count=1)
    source = f[-1]('patch', {'task_limit': 60}, source['id'])
    source = f[-1]('add_tasks', {'tasks': [{'client_key': str(i), 'title': f'Step {i}'} for i in range(50)]}, source['id'])
    terminal_setup(source)
    copy = f[-1]('run_again', {}, source['id'])
    assert len(copy['tasks']) == 51 and copy['task_limit'] == 60


def test_retry_receipt_and_rollback(setup_workflow, flexible):
    f = setup_workflow
    source = terminal_setup(f[-1]('create', loop_draft(f[2])))
    body = {'idempotency_key': uid()}
    copy = f[-1]('run_again', body, source['id'])
    assert f[-1]('run_again', body, source['id']) == copy
    assert len(rows('SELECT * FROM workflows WHERE container_id=%s', (f[0],))) == 2
    receipt = rows("SELECT * FROM workflow_operation_receipts WHERE operation='run_again'")[0]
    assert receipt['workflow_id'] == copy['id']
    with pytest.raises(HTTPException) as error:
        f[-1]('run_again', {**body, 'reason': 'Different'}, source['id'])
    assert error.value.detail['code'] == 'idempotency_conflict'
    # Refuse a missing retained flow target, with no partially saved draft.
    with db_cursor() as (_, cur):
        cur.execute('UPDATE tasks SET withdrawn_at=CURRENT_TIMESTAMP WHERE id=%s', (loop_ids(source)[0],))
    with pytest.raises(HTTPException) as error:
        f[-1]('run_again', {}, source['id'])
    assert error.value.detail['code'] == 'copy_definition_unavailable'
    assert len(rows('SELECT * FROM workflows WHERE container_id=%s', (f[0],))) == 2
    # A failure inside create (after workflow/task inserts) also rolls back everything.
    with db_cursor() as (_, cur):
        cur.execute('UPDATE tasks SET withdrawn_at=NULL WHERE workflow_id=%s', (source['id'],))
        cur.execute("UPDATE workflow_repeat_groups SET exit_outcome='Missing' WHERE workflow_id=%s", (source['id'],))
    with pytest.raises(HTTPException):
        f[-1]('run_again', {}, source['id'])
    assert len(rows('SELECT * FROM workflows WHERE container_id=%s', (f[0],))) == 2


@pytest.mark.parametrize('status', ['active', 'paused', 'cancelled'])
def test_completed_only(setup_workflow, status):
    f = setup_workflow
    w = create(f)
    with db_cursor() as (_, cur):
        cur.execute('UPDATE workflows SET status=%s WHERE id=%s', (status, w['id']))
    action = next(a for a in detail(f, w['id'])['available_actions'] if a['action'] == 'run_again')
    assert not action['enabled']
    with pytest.raises(HTTPException) as error:
        f[-1]('run_again', {}, w['id'])
    assert error.value.detail['code'] == 'workflow_not_completed'


def test_legacy_selection_and_unavailable_people(setup_workflow, monkeypatch):
    f = setup_workflow
    monkeypatch.setenv(routing.FLAG, '0')
    source = create(f, count=5)
    a, b, withdrawn, correction, review = source['tasks']
    with db_cursor() as (_, cur):
        cur.execute("UPDATE tasks SET route_state='not_selected' WHERE id=%s", (b['id'],))
        cur.execute('UPDATE tasks SET withdrawn_at=CURRENT_TIMESTAMP WHERE id=%s', (withdrawn['id'],))
        round_id = uid()
        cur.execute("INSERT INTO workflow_review_rounds(id,workflow_id,loop_key,round_number,review_task_id,reviewed_artifact) VALUES (%s,%s,'review',1,%s,'{}')", (round_id, source['id'], a['id']))
        cur.execute("INSERT INTO workflow_review_rounds(id,workflow_id,loop_key,round_number,review_task_id,correction_task_id,prior_round_id,reviewed_artifact) VALUES (%s,%s,'review',2,%s,%s,%s,'{}')", (uid(), source['id'], review['id'], correction['id'], round_id))
        cur.execute('UPDATE agents SET terminated_at=CURRENT_TIMESTAMP WHERE id=%s', (f[2],))
    terminal_setup(source)
    monkeypatch.setenv(routing.FLAG, '1')
    copy = f[-1]('run_again', {}, source['id'])
    assert copy['semantics_version'] == 1
    assert set(copy['created_task_ids']) == {a['id'], b['id']}
    assert all(t['preparation_state'] == 'draft' and not t['assignee_ids'] for t in copy['tasks'])
    assert all(t['route_state'] is None for t in copy['tasks'])
    assert len(copy['copy_notes']) == 2


def test_permissions_recovery_and_approval_policy(setup_workflow, flexible):
    f = setup_workflow
    source = terminal_setup(f[-1]('create', loop_draft(f[2])))
    other = ws.WorkflowActor(f[3], True)
    with pytest.raises(HTTPException) as error:
        f[-1]('run_again', {}, source['id'], acting=other)
    assert error.value.status_code == 403
    with db_cursor() as (_, cur):
        cur.execute('UPDATE workflows SET owner_human_id=%s WHERE id=%s', (f[3], source['id']))
        cur.execute("UPDATE tasks SET autonomy='on' WHERE workflow_id=%s", (source['id'],))
    copy = f[-1]('run_again', {}, source['id'], acting=other)
    assert all(t['autonomy'] == 'off' for t in copy['tasks'])
    assert any('project owner' in note for note in copy['copy_notes'])
    with db_cursor() as (_, cur):
        cur.execute('UPDATE agents SET terminated_at=CURRENT_TIMESTAMP WHERE id=%s', (f[3],))
        cur.execute('UPDATE workflow_repeat_groups SET escalation_owner_id=%s WHERE workflow_id=%s', (f[3], source['id']))
    copy = f[-1]('run_again', {}, source['id'])
    assert copy['owner_human_id'] == f[1].id
    assert copy['repeat_groups'][0]['escalation_owner_id'] == f[1].id
    assert all(t['autonomy'] == 'on' for t in copy['tasks'])
    assert rows('SELECT autonomy_changed_by FROM tasks WHERE workflow_id=%s', (copy['id'],))[0]['autonomy_changed_by'] == f[1].id
    with db_cursor() as (_, cur):
        cur.execute("UPDATE containers SET status='paused' WHERE id=%s", (f[0],))
    with pytest.raises(HTTPException) as error:
        f[-1]('run_again', {}, source['id'])
    assert error.value.detail['code'] == 'project_not_active'


async def test_route_human_only_hidden_copy_and_receipt(client, setup_workflow, monkeypatch):
    f = setup_workflow
    from portal_backend import workflow_routes
    monkeypatch.setattr(workflow_routes, 'HOOKS', f[4])
    source = terminal_setup(create(f, count=1))
    source = f[-1]('hide', {}, source['id'])
    url = f"/api/workflows/{source['id']}/run_again"
    body = {'expected_revision': source['revision'], 'idempotency_key': uid()}
    for headers in ({'X-Orcha-Run-Token': 'worker'}, {'X-Orcha-Local-Actor': f[2]}, {'X-Orcha-Local-Actor': f[3]}):
        result = await client.post(url, json=body, headers=headers)
        assert result.status_code == 403
    headers = {'X-Orcha-Local-Actor': f[1].id}
    result = await client.post(url, json=body, headers=headers)
    assert result.status_code == 200, result.text
    copy = result.json()
    assert copy['id'] != source['id'] and not copy['hidden'] and not copy['launch_enabled']
    assert (await client.post(url, json=body, headers=headers)).json() == copy
    assert detail(f, source['id'])['hidden']


def test_version_two_requires_capability_and_stale_revision_is_refused(setup_workflow, flexible, monkeypatch):
    f = setup_workflow
    source = terminal_setup(f[-1]('create', loop_draft(f[2])))
    with pytest.raises(HTTPException) as error:
        f[-1]('run_again', {'expected_revision': source['revision'] + 1}, source['id'])
    assert error.value.detail['code'] == 'revision_changed'
    monkeypatch.setenv(routing.FLAG, '0')
    with pytest.raises(HTTPException) as error:
        f[-1]('run_again', {}, source['id'])
    assert error.value.detail['code'] == 'flexible_disabled'
    assert len(rows('SELECT * FROM workflows WHERE container_id=%s', (f[0],))) == 1
