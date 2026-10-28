"""Issue #370: truthful guidance and workflow-only holds, on isolated SQLite data."""
import json
from uuid import uuid4

import pytest
from portal_backend import sql
from portal_backend.database import db_cursor
from portal_backend import workflow_service as ws
from test_workflow_local_launch import Project, stopped_turn


@pytest.fixture(autouse=True)
def local_lane(monkeypatch):
    monkeypatch.setattr(ws, 'WORKFLOWS_INTEGRATED', True)
    monkeypatch.delenv('ORCHA_TRUST_PROXY_USER', raising=False)
    monkeypatch.delenv('ORCHA_BIND', raising=False)


def ordinary(project, *, status='not_ready', assigned=True):
    tid = str(uuid4())
    with db_cursor() as (_, cur):
        cur.execute("INSERT INTO tasks(id,container_id,title,definition_of_done,status) VALUES (%s,%s,'Held ordinary task','done',%s)", (tid, project.cid, status))
        if assigned:
            cur.execute("INSERT INTO agent_tasks(task_id,agent_id,assignment_status) VALUES (%s,%s,'working')", (tid, project.ann))
        cur.execute("INSERT INTO agent_reachability(agent_id,headless_cwd) VALUES (%s,'/isolated/fixture') ON CONFLICT(agent_id) DO UPDATE SET headless_cwd='/isolated/fixture'", (project.ann,))
    return tid


async def delivery(project, tid):
    return await project.call('GET', f'/api/tasks/{tid}/messages/delivery')


@pytest.mark.parametrize('status', ['ready', 'pending', 'not_ready', 'in_progress', 'needs_verification'])
@pytest.mark.parametrize('ready', [True, False])
async def test_workflow_readiness_refuses_both_directions_before_any_write(client, status, ready):
    project = Project(client)
    await project.start('parallel', [('a', project.ann, [])])
    tid = project.tasks['a']
    with db_cursor() as (_, cur):
        cur.execute('UPDATE tasks SET status=%s WHERE id=%s', (status, tid))
        cur.execute('SELECT count(*) AS n FROM agent_events'); before = cur.fetchone()['n']
    result = await project.call('POST', f'/api/tasks/{tid}/readiness', {'actor_agent_id': project.owner, 'ready': ready}, 409)
    assert 'workflow controls' in result['detail']
    with db_cursor() as (_, cur):
        cur.execute('SELECT status FROM tasks WHERE id=%s', (tid,)); assert cur.fetchone()['status'] == status
        cur.execute('SELECT count(*) AS n FROM agent_events'); assert cur.fetchone()['n'] == before
        cur.execute("SELECT 1 FROM events WHERE entity_id=%s AND event_type='readiness_set'", (tid,)); assert not cur.fetchone()


async def test_ordinary_hold_can_receive_message_and_release_still_works(client):
    project = Project(client); tid = ordinary(project)
    data = await delivery(project, tid)
    assert data['state'] == 'deliverable_now'
    assert data['recipients'][0]['alias'] == 'Ann'
    assert 'agent=Ann' in data['recipients'][0]['direct_chat_href']
    await project.call('POST', f'/api/tasks/{tid}/messages', {'author_agent_id': project.owner, 'body': 'Can you explain this hold?'}, 201)
    scan = await client.get(f'/api/containers/{project.cid}/wake-scan?min_idle=0&cooldown=0')
    ann = next(c for c in scan.json()['candidates'] if c['agent_id'] == project.ann)
    assert ann['should_wake'] and any('Can you explain this hold?' in m for m in ann['prompt_messages'])
    assert (await project.call('POST', f'/api/tasks/{tid}/readiness', {'actor_agent_id': project.owner, 'ready': True}))['status'] == 'ready'


@pytest.mark.parametrize('gate,reason', [('hold', 'on hold'), ('draft', 'Prepare'), ('owner', 'owner to decide'), ('review', 'not waiting'), ('start', 'not released')])
async def test_workflow_waiting_guidance_matches_selection_and_preserves_pending_message(client, gate, reason):
    project = Project(client)
    await project.start('parallel', [('a', project.ann, [])])
    tid = project.tasks['a']
    with db_cursor() as (_, cur):
        if gate == 'hold': cur.execute('UPDATE tasks SET human_hold_by=%s,status=\'not_ready\' WHERE id=%s', (project.owner, tid))
        if gate == 'draft': cur.execute("UPDATE tasks SET preparation_state='draft',status='not_ready' WHERE id=%s", (tid,))
        if gate == 'owner': cur.execute("UPDATE tasks SET awaiting_owner_decision='stopped_by_owner',status='not_ready' WHERE id=%s", (tid,))
        if gate == 'review': cur.execute("UPDATE tasks SET status='needs_verification' WHERE id=%s", (tid,))
        if gate == 'start': cur.execute("UPDATE tasks SET start_hold=true,status='not_ready' WHERE id=%s", (tid,))
    # Remove setup notifications from this isolated fixture's question-only scan.
    with db_cursor() as (_, cur):
        cur.execute("INSERT INTO agent_event_acks(agent_id,event_id) SELECT %s,id FROM agent_events WHERE event_key=%s ON CONFLICT DO NOTHING", (project.ann, project.ann))
    await project.call('POST', f'/api/tasks/{tid}/messages', {'author_agent_id': project.owner, 'body': 'Please explain what is waiting.'}, 201)
    data = await delivery(project, tid)
    assert data['state'] == 'deferred_until_eligible'
    assert reason in data['recipients'][0]['reason']
    scan = await client.get(f'/api/containers/{project.cid}/wake-scan?min_idle=0&cooldown=0')
    ann = next(c for c in scan.json()['candidates'] if c['agent_id'] == project.ann)
    assert not ann['should_wake']
    assert not any('Please explain what is waiting.' in m for m in ann['prompt_messages'])
    with db_cursor() as (_, cur):
        cur.execute("SELECT e.id FROM agent_events e LEFT JOIN agent_event_acks a ON a.event_id=e.id AND a.agent_id=%s WHERE e.event_key=%s AND e.event_name='task_message' AND a.event_id IS NULL", (project.ann, project.ann))
        assert cur.fetchone()


async def test_stopped_worker_continuation_is_not_misreported_as_parked(client):
    project = Project(client); await stopped_turn(project, client)
    with db_cursor() as (_, cur):
        cur.execute("INSERT INTO agent_reachability(agent_id,headless_cwd) VALUES (%s,'/isolated') ON CONFLICT(agent_id) DO UPDATE SET headless_cwd='/isolated'", (project.ann,))
    assert (await delivery(project, project.tasks['a']))['state'] == 'deliverable_now'


@pytest.mark.parametrize('case,state', [('none','no_assignee'), ('finished','task_finished'), ('cancelled','task_finished'), ('paused','wake_disabled_or_paused'), ('disabled','wake_disabled_or_paused'), ('failure','wake_disabled_or_paused'), ('backoff','deferred_until_eligible'), ('running','worker_running'), ('unknown','unknown')])
async def test_delivery_states_are_read_only(client, case, state):
    project = Project(client); tid = ordinary(project, assigned=case != 'none')
    with db_cursor() as (_, cur):
        if case in ('finished','cancelled'): cur.execute('UPDATE tasks SET status=%s WHERE id=%s', ('completed' if case == 'finished' else 'cancelled', tid))
        if case == 'paused': cur.execute("UPDATE containers SET status='paused' WHERE id=%s", (project.cid,))
        if case == 'disabled': cur.execute('UPDATE agent_reachability SET wake_enabled=false WHERE agent_id=%s', (project.ann,))
        if case == 'unknown': cur.execute('UPDATE agent_reachability SET headless_cwd=NULL WHERE agent_id=%s', (project.ann,))
        if case == 'running': cur.execute("INSERT INTO agent_wake_state(agent_id,wake_lease_until) VALUES (%s,%s)", (project.ann,sql.from_now(600)))
        if case == 'backoff': cur.execute("INSERT INTO wake_backoff(container_id,agent_id,wake_key,strikes,suppressed_until) VALUES (%s,%s,'task_message',3,%s)", (project.cid,project.ann,sql.from_now(600)))
        if case == 'failure': cur.execute("INSERT INTO wake_backoff(container_id,agent_id,wake_key,strikes) VALUES (%s,%s,'run_failure',3)", (project.cid,project.ann))
        cur.execute('SELECT count(*) AS n FROM agent_events'); events = cur.fetchone()['n']
        cur.execute('SELECT count(*) AS n FROM agent_event_acks'); acks = cur.fetchone()['n']
    data = await delivery(project, tid)
    assert data['state'] == state, data
    assert bool(data['recipients']) == (case != 'none')
    with db_cursor() as (_, cur):
        cur.execute('SELECT count(*) AS n FROM agent_events'); assert cur.fetchone()['n'] == events
        cur.execute('SELECT count(*) AS n FROM agent_event_acks'); assert cur.fetchone()['n'] == acks


async def test_review_submitter_and_multiple_assignees_match_actual_notifications(client):
    project = Project(client); tid = ordinary(project, status='needs_verification')
    with db_cursor() as (_, cur):
        cur.execute("UPDATE agent_tasks SET assignment_status='done' WHERE task_id=%s", (tid,))
        cur.execute('UPDATE tasks SET result=%s WHERE id=%s', (json.dumps({'by_agent_id':project.ann}),tid))
        cur.execute("INSERT INTO agent_tasks(task_id,agent_id,assignment_status) VALUES (%s,%s,'working')", (tid,project.bob))
    data = await delivery(project, tid)
    assert {r['agent_id'] for r in data['recipients']} == {project.ann,project.bob}
    await project.call('POST', f'/api/tasks/{tid}/messages', {'author_agent_id':project.owner, 'body':'Explain the result.'}, 201)
    with db_cursor() as (_,cur):
        cur.execute("SELECT event_key FROM agent_events WHERE event_name='task_message' AND payload->>'task_id'=%s AND event_key<>%s", (tid,'c:' + project.cid))
        assert {str(r['event_key']) for r in cur.fetchall()} == {project.ann,project.bob}


async def test_delivery_contract_and_thread_authorization(client, monkeypatch):
    project = Project(client); tid = ordinary(project)
    spec = (await client.get('/openapi.json')).json()
    schema = spec['paths']['/api/tasks/{tid}/messages/delivery']['get']['responses']['200']['content']['application/json']['schema']
    assert schema['$ref'].endswith('/TaskMessageDelivery')
    assert 'deferred_until_eligible' in spec['components']['schemas']['MessageRecipientDelivery']['properties']['state']['enum']
    monkeypatch.setenv('ORCHA_TRUST_PROXY_USER', '1')
    for suffix in ('messages','messages/delivery'):
        r = await client.get(f'/api/tasks/{tid}/{suffix}', headers={'X-Auth-Request-User':'outsider'})
        assert r.status_code == 403, r.text
    assert (await client.get('/api/tasks/not-a-uuid/messages/delivery')).status_code == 400


async def test_running_workflow_reports_queued_message_without_promising_a_reply(client):
    project = Project(client)
    await project.start('parallel', [('a', project.ann, [])])
    launch = await project.reserve(project.ann, 'a')
    await project.activate(project.ann, launch)
    data = await delivery(project, project.tasks['a'])
    assert data['state'] == 'worker_running'
    assert 'not guaranteed' in data['recipients'][0]['reason']


async def test_unreadable_workflow_is_unknown_not_a_wake_promise(client, monkeypatch):
    project = Project(client)
    await project.start('parallel', [('a', project.ann, [])])
    monkeypatch.setattr(ws.WorkflowService, 'snapshot', lambda *_: (_ for _ in ()).throw(RuntimeError('unavailable')))
    assert (await delivery(project, project.tasks['a']))['state'] == 'unknown'
