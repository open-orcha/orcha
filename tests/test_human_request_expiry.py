"""GH #328: human-held requests must get durable, throttled overdue reminders."""
import datetime as dt
import uuid

from fastapi.testclient import TestClient

import main
from orcha_cli import notifier_request_sweep as sweep
from portal_backend import sql


def arena():
    tc = TestClient(main.app)
    cid = tc.post('/api/containers', json={'name': 'overdue-' + uuid.uuid4().hex[:8]}).json()['container_id']
    human = tc.post(f'/api/containers/{cid}/agents', json={
        'alias': 'Kedar', 'role': 'owner', 'kind': 'human',
    }).json()['agent_id']
    agent = tc.post(f'/api/containers/{cid}/agents', json={
        'alias': 'rig', 'role': 'worker', 'kind': 'ai', 'prompt': 'Test agent',
    }).json()['agent_id']
    return tc, cid, human, agent


def test_human_expiry_via_notifier_is_recorded_and_reminded_once_per_day(db, monkeypatch):
    tc, cid, human, agent = arena()
    rid = tc.post(f'/api/containers/{cid}/requests', json={
        'requester_agent_id': agent, 'target_alias': 'Kedar', 'payload': 'Which release?',
        'type': 'info', 'expires_minutes': 0,
    }).json()['request_id']
    expired = sql.utcnow() - dt.timedelta(days=6)
    db.execute('UPDATE requests SET expires_at=%s, detail=%s WHERE id=%s',
               (expired, sql.json_param({'keep_me': 'original task metadata'}), rid))
    sweep._LAST_SWEEP.clear()
    clock = [1000.0]
    monkeypatch.setattr(sweep, '_monotonic', lambda: clock[0])

    class Live:
        @staticmethod
        def _get_json(url):
            r = tc.get(url.replace('http://test', ''))
            assert r.status_code == 200, r.text
            return r.json()

        @staticmethod
        def _post_json(url, body):
            r = tc.post(url.replace('http://test', ''), json=body)
            assert r.status_code == 200, r.text
            return r.json()

    try:
        result = sweep.maybe_sweep_expired('http://test', cid, Live, quiet=True)
        assert result['reminded_count'] == 1
        assert result['reminded_request_ids'] == [rid]
        row = db.execute('SELECT * FROM requests WHERE id=%s', (rid,))[0]
        assert str(row['target_id']) == human and row['status'] == 'open'
        assert row['detail']['keep_me'] == 'original task metadata'
        stamp = row['detail']['overdue_reminded_at']
        assert row['detail']['overdue_since'] == sql.ts(expired)
        outbox = tc.get(f'/api/agents/{agent}/outbox').json()['outgoing_requests']
        assert next(r for r in outbox if r['id'] == rid)['detail']['overdue_reminded_at'] == stamp
        for key in (human, agent, f'c:{cid}'):
            events = [e for e in db.event_rows(key) if e['event_name'] == 'request_overdue']
            assert len(events) == 1
            assert events[0]['payload']['request_id'] == rid
        # A notifier restart or another sweep does not duplicate a reminder.
        sweep._LAST_SWEEP.clear()
        assert sweep.maybe_sweep_expired('http://test', cid, Live, quiet=True)['reminded_count'] == 0
        clock[0] += 61
        assert sweep.maybe_sweep_expired('http://test', cid, Live, quiet=True)['reminded_count'] == 0
        # After the daily cooldown, remind again without closing or reassigning.
        old = sql.ts(sql.utcnow() - dt.timedelta(days=2))
        db.execute('UPDATE requests SET detail=%s WHERE id=%s',
                   (sql.json_param({**row['detail'], 'overdue_reminded_at': old}), rid))
        clock[0] += 61
        assert sweep.maybe_sweep_expired('http://test', cid, Live, quiet=True)['reminded_count'] == 1
        db.execute("UPDATE requests SET status='answered' WHERE id=%s", (rid,))
        clock[0] += 61
        assert sweep.maybe_sweep_expired('http://test', cid, Live, quiet=True)['reminded_count'] == 0
    finally:
        sweep._LAST_SWEEP.clear()


def test_sweep_excludes_future_no_expiry_manager_review_and_other_container(db):
    tc, cid, human, agent = arena()
    ids = []
    for expiry in (60, 0, 0):
        ids.append(tc.post(f'/api/containers/{cid}/requests', json={
            'requester_agent_id': agent, 'target_alias': 'Kedar', 'payload': 'Which release?',
            'expires_minutes': expiry,
        }).json()['request_id'])
    db.execute('UPDATE requests SET expires_at=NULL WHERE id=%s', (ids[1],))
    db.execute('UPDATE requests SET detail=%s WHERE id=%s',
               (sql.json_param({'kind': 'manager_review'}), ids[2]))
    extra = tc.post('/api/containers', json={'name': 'other', 'additional': True})
    assert extra.status_code == 201, extra.text
    other = extra.json()['container_id']
    other_human = extra.json()['human_agent_id']
    # Sweeping a different container cannot remind the first project's requests.
    assert tc.post(f'/api/containers/{other}/sweep?actor_agent_id={other_human}').json()['reminded_count'] == 0
    assert tc.post(f'/api/containers/{cid}/sweep?actor_agent_id={human}').json()['reminded_count'] == 0


def test_reminder_event_is_a_request_receipt_and_sweep_has_openapi_contract():
    notice = main._classify_notification('request_overdue', {'request_id': 'r1'})
    assert notice['type'] == 'request_overdue'
    assert notice['zone'] == 'earlier'
    assert notice['deeplink'] == {'kind': 'request', 'id': 'r1'}
    spec = TestClient(main.app).get('/openapi.json').json()
    response = spec['paths']['/api/containers/{cid}/sweep']['post']['responses']['200']
    assert response['content']['application/json']['schema']['$ref'].endswith('/SweepExpiredResponse')
    assert set(spec['components']['schemas']['SweepExpiredResponse']['required']) == {
        'escalated_count', 'request_ids', 'reminded_count', 'reminded_request_ids',
    }
