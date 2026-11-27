"""Choosing more QA time preserves the work a person asked the task to prove."""

import pytest

from test_qa_run_tasks import team, inline, task, hand, session  # noqa: F401


@pytest.mark.parametrize('minutes', [0, 45])
@pytest.mark.parametrize('operation', ['portal_continue', 'request_continue', 'approve_time'])
async def test_time_choice_preserves_task_instructions_and_requirements(team, db, minutes, operation):
    instructions = ('Test the staging build. Keep saved results. Run the complete regression suite.\n'
                    'Time limit: 20 minutes.\n'
                    'Run /orcha-qa-explore for this task on web --minutes 20 --focus "checkout"')
    criteria = 'Receipt email delivered and the complete regression suite passes.'
    tid = await task(team, assignee='QAEngineer', description=instructions, dod=criteria)
    if operation != 'portal_continue':
        out = await hand(team, tid, minutes=20)
        tid = out['qa_task_id']
        generated = db.execute('SELECT description FROM tasks WHERE id=%s', (tid,))[0]['description']
        instructions = generated + '\n\n' + instructions
        # Existing custom instructions on a request-created task must survive too.
        db.execute('UPDATE tasks SET description=%s, definition_of_done=%s WHERE id=%s',
                   (instructions, criteria, tid))
    if operation == 'approve_time':
        response = await team['client'].put(f"/api/qa/requests/{out['request']['id']}/time-limit", json={
            'actor_agent_id': team['human'], 'minutes': minutes})
        assert response.status_code == 200, response.text
    else:
        old = await session(team, task_id=tid, budget_minutes=20)
        response = await team['client'].patch(f"/api/qa/sessions/{old['id']}", json={
            'actor_agent_id': team['qa'], 'status': 'done',
            'result': {'budget': {'minutes': 20, 'used_s': 1201, 'left_s': 0}}})
        assert response.status_code == 200, response.text
        response = await team['client'].post(f"/api/qa/sessions/{old['id']}/continue", json={
            'actor_agent_id': team['human'], 'minutes': minutes})
        assert response.status_code == 201, response.text
    after = db.execute('SELECT description, definition_of_done FROM tasks WHERE id=%s', (tid,))[0]
    expected = instructions.replace('Time limit: 20 minutes.',
                                    'Time limit: none.' if minutes == 0 else 'Time limit: 45 minutes.')
    expected = expected.replace('--minutes 20', f'--minutes {minutes}')
    assert after == {'description': expected, 'definition_of_done': criteria}


async def test_continue_adds_time_note_without_replacing_custom_description(team, db):
    instructions = 'Use staging build. Keep recorded results and check the receipt email.'
    criteria = 'Receipt delivered and regression suite passes.'
    tid = await task(team, assignee='QAEngineer', description=instructions, dod=criteria)
    old = await session(team, task_id=tid, budget_minutes=20)
    response = await team['client'].patch(f"/api/qa/sessions/{old['id']}", json={
        'actor_agent_id': team['qa'], 'status': 'done',
        'result': {'budget': {'minutes': 20, 'used_s': 1201, 'left_s': 0}}})
    assert response.status_code == 200, response.text
    response = await team['client'].post(f"/api/qa/sessions/{old['id']}/continue", json={
        'actor_agent_id': team['human'], 'minutes': 45})
    assert response.status_code == 201, response.text
    after = db.execute('SELECT description, definition_of_done FROM tasks WHERE id=%s', (tid,))[0]
    assert after == {'description': instructions + '\n\nTime limit: 45 minutes.', 'definition_of_done': criteria}
