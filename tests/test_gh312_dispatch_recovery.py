"""Dispatch acknowledgement cannot erase the private guidance recovery trail."""

from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest

from orcha_cli.job_dispatch import capture
from orcha_cli.job_evidence import context_snapshot
from orcha_cli.job_guidance import startup_guidance
from orcha_cli.job_store import JobStore, read_json
from orcha_cli.notifier_wake_candidate import _ack_delivery
from test_gh312_job_supervisor import service
from test_gh312_job_recovery import successor
from test_gh312_managed_messages import managed
from test_gh312_managed_jobs import publish


async def test_capture_precedes_dispatch_ack_and_successor_recovers_unhandled_thread(client, managed, db, tmp_path, service):
    await publish(client, managed)
    posted = await client.post(f"/api/tasks/{managed['tid']}/messages", json={'body': 'private-guidance-fixture'})
    mid = posted.json()['message_id']
    cid = str(db.execute('SELECT container_id FROM agents WHERE id=%s', (managed['aid'],))[0]['container_id'])
    scan = (await client.get(f'/api/containers/{cid}/wake-scan?cooldown=0&min_idle=0')).json()
    candidate = next(c for c in scan['candidates'] if c['agent_id'] == managed['aid'])
    ref = next(r for r in candidate['task_message_refs'] if r['message_id'] == mid)
    assert ref['task_id'] == managed['tid'] and ref['event_id'] in candidate['handled_event_ids']
    candidate['headless_cwd'] = str(tmp_path)
    # Exercise the documented legacy delivery-safe fallback, then crash before
    # any managed poll or handled receipt. New servers keep directives pending.
    candidate.pop('delivery_handled_event_ids', None)
    path = JobStore(tmp_path).root / '.dispatch' / f"{managed['tid']}.json"
    def post(url, body):
        if url.endswith('/events/ack-handled'):
            saved = read_json(path)
            assert saved['pending_messages'] == [{'event_id': ref['event_id'], 'message_id': mid}]
            assert 'private-guidance-fixture' not in path.read_text()
        with httpx.Client(timeout=2) as transport:
            response = transport.post(url, json=body)
            assert response.status_code == 200, response.text
            return response.json()
    services = SimpleNamespace(_post_json=post, self_wake_ack_fields=lambda *a, **k: {})
    _ack_delivery(service[0], candidate, kind='ephemeral', event='task_message', sent=True,
                  lane='work', resume_rendered=False, live_workers=None, services=services)
    assert db.execute('SELECT * FROM agent_event_acks WHERE event_id=%s', (ref['event_id'],))
    assert not db.execute('SELECT * FROM managed_message_receipts')
    new = await successor(client, managed)
    poll = await client.post(new['url']+'/poll', headers=new['headers'], json={})
    assert poll.status_code == 200, poll.text
    assert any(m['message_id'] == mid for m in poll.json()['messages'])
    assert poll.json()['handled_position'] is None
    assert str(path) in startup_guidance(tmp_path, managed['tid'])
    # A command launched after dispatch carries the same references at shutdown.
    store = JobStore(tmp_path)
    jid = str(uuid4())
    store.reserve(jid, {'task_id': managed['tid'], 'cwd': str(tmp_path)})
    snapshot = context_snapshot(store.job_directory(jid))
    assert snapshot['dispatch_message_refs'] == read_json(path)['pending_messages']
    assert snapshot['guidance_incomplete']


def test_capture_failure_retains_delivery_and_completion_event_references(tmp_path):
    base = tmp_path/'unavailable'
    base.write_text('not a directory')
    candidate = {'agent_id': str(uuid4()), 'headless_cwd': str(base), 'pending_events': 1,
                 'handled_event_ids': [str(uuid4())],
                 'task_message_refs': [{'task_id': str(uuid4()), 'message_id': str(uuid4()), 'event_id': 1}]}
    posts = []
    services = SimpleNamespace(_post_json=lambda url, body: posts.append((url, body)),
                               self_wake_ack_fields=lambda *a, **k: {})
    for live in [None, {candidate['agent_id']: {'run_id': str(uuid4()), 'handled_event_ids': candidate['handled_event_ids'],
                                             'respawn_ctx': {'handled_event_ids': candidate['handled_event_ids']}}}]:
        _ack_delivery('http://test', candidate, kind='ephemeral', event='task_message', sent=True,
                      lane='work', resume_rendered=False, live_workers=live, services=services)
        if live:
            assert live[candidate['agent_id']]['handled_event_ids'] == []
            assert live[candidate['agent_id']]['respawn_ctx']['handled_event_ids'] == []
    assert candidate['message_reference_capture_failed']
    assert all(not url.endswith('/events/ack-handled') and body['delivered_ts'] is None for url, body in posts)


def test_reference_journal_merges_retries_and_never_copies_text(tmp_path):
    tid = str(uuid4())
    refs = [{'task_id': tid, 'message_id': str(uuid4()), 'event_id': i+1} for i in range(2)]
    for ref in [refs[0], refs[0], refs[1]]:
        assert capture({'headless_cwd': str(tmp_path), 'task_message_refs': [{**ref, 'body': 'private-text-fixture'}]})
    path = JobStore(tmp_path).root/'.dispatch'/f'{tid}.json'
    assert len(read_json(path)['pending_messages']) == 2
    assert path.stat().st_mode & 0o777 == 0o600
    assert 'private-text-fixture' not in path.read_text()
