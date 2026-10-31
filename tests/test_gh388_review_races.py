"""GH #388 PR #390 review regressions: owner change and admission identity races.

Ported from the independent recheck; disposable API/database only.
"""
import hashlib
import sys
from uuid import uuid4
import pytest
from orcha_cli.cli_job import start_job
from orcha_cli.job_api import JobAPI
from orcha_cli.job_store import JobStore, JobStorageError, atomic_json
from orcha_cli.job_transfer import transfer_command
from test_gh312_managed_messages import managed
from test_gh312_managed_jobs import publish, reserve, url
from test_gh312_job_supervisor import service, eventually, result
from test_gh312_job_transfer import prepared, observed
from test_gh312_job_recovery import successor
from test_gh388_job_monitors import finish_worker, candidate, observation, monitor_url

@pytest.mark.skipif(sys.platform != 'darwin', reason='Adoption requires the enforced macOS contract')
@pytest.mark.parametrize('lost_reply', [False, True])
async def test_pending_observation_reconciles_owner_change(client, managed, service, tmp_path, db, monkeypatch,
                                                        lost_reply):
    import os
    import signal
    from fastapi import HTTPException
    from portal_backend.application import app
    from orcha_cli.cli_job import current_job
    from orcha_cli.job_identity import same_process
    from orcha_cli.job_recovery import recover_result
    await publish(client, managed, seconds=120)
    api = JobAPI(service[0], managed['token'], managed['tid'])
    store = JobStore(tmp_path)
    jid = start_job(api, store, key='lost-controller', purpose='Adoption crash recovery', cwd=tmp_path,
                    argv=[sys.executable,'-c','import time;time.sleep(60)'], isolate=True)['job_id']
    try:
        eventually(lambda: store.read(jid).get('transfer_socket'))
        transfer_command(store, jid, 'prepare', api.token)
        stale_job = JobAPI(service[0], None, managed['tid'], machine=True).request(
            f'job-monitors/{jid}/reconcile', {})['job']  # Registry read before adoption.
        new = await successor(client, managed)
        await observed(client, managed, db)
        route = next(r for r in app.routes if getattr(r, 'path', '').endswith('/transfer/adopt'))
        original = route.dependant.call
        def crash_after_commit(*args, **kwargs):
            original(*args, **kwargs)
            identity = store.read(jid)['supervisor']
            assert same_process(identity)
            os.kill(identity['pid'], signal.SIGKILL)
            raise HTTPException(503, 'Temporary test response loss')
        monkeypatch.setattr(route.dependant, 'call', crash_after_commit)
        with pytest.raises((JobStorageError, OSError)):
            transfer_command(store, jid, 'adopt', new['token'])
        saved = eventually(lambda: result(store, jid))
        assert saved['termination_verified'] and saved['owner_run_id'] == managed['rid']
        assert store.read(jid)['owner_run_id'] == managed['rid']
        await finish_worker(client, new)
        from orcha_cli.job_monitor import publish as publish_observation
        from orcha_cli.job_api import JobAPIError
        monitor_api = JobAPI(service[0], None, managed['tid'], machine=True)
        if lost_reply:
            # The refusal reply is lost: ambiguous, so the exact body is retained.
            send = monitor_api.request
            def lose(*args, **kwargs):
                try:
                    send(*args, **kwargs)
                except JobAPIError:
                    pass
                raise JobAPIError()
            monkeypatch.setattr(monitor_api, 'request', lose)
        with pytest.raises(JobAPIError) as rejected:
            publish_observation(monitor_api, store, stale_job)
        assert rejected.value.status == (None if lost_reply else 409)
        from orcha_cli.job_store import read_json
        pending = read_json(store.root/f'.observation-{jid}.json')
        refusal = await client.post(f"/api/tasks/{managed['tid']}/job-monitors/{jid}/observe", json=pending)
        assert refusal.status_code == 409
        assert refusal.json()['detail']['code'] == 'managed_recovery_identity_changed'
        assert (store.root/f'.observation-{jid}.json').exists()
        from orcha_cli import notifier_job_monitors
        from types import SimpleNamespace
        import httpx
        with httpx.Client(timeout=3) as http:
            transport = SimpleNamespace(_get_json=lambda u: http.get(u).json())
            cid = str(db.execute('SELECT container_id FROM agents WHERE id=%s', (managed['aid'],))[0]['container_id'])
            for _ in range(3):
                notifier_job_monitors._last_pass.clear()
                notifier_job_monitors.tick(service[0], cid, str(tmp_path), transport)
        outcomes = db.execute('SELECT * FROM managed_job_outcomes')
        assert outcomes, 'Registry found the job but silently skipped the saved result after committed adoption'
        assert outcomes[-1]['termination_verified']
        assert not (store.root/f'.observation-{jid}.json').exists()
        assert (store.root/f".rejected-observation-{pending['operation_id']}.json").exists()
        assert store.read(jid)['owner_run_id'] == managed['rid']  # Nothing adopted locally.

    finally:
        db.execute('UPDATE worker_runs SET stop_requested_at=%s', (db.ago(0),))
        eventually(lambda: result(store, jid), seconds=12)


async def test_lost_rejected_claim_cannot_refund_another_launcher(client, managed, db, service, monkeypatch):
    import httpx
    from orcha_cli import notifier, notifier_wake_worker
    await publish(client, managed)
    db.execute("UPDATE tasks SET autonomy='on' WHERE id=%s", (managed['tid'],))
    job = await reserve(client, managed)
    await finish_worker(client, managed)
    assert (await client.post(monitor_url(managed, job, 'observe'), json=observation(job))).status_code == 200
    stale = await candidate(client, managed, db)
    # Launcher A has admission, but is still preparing its checkout/persona.
    claim = await client.post(f"/api/agents/{managed['aid']}/wake-claim", json={'completion':stale['completion']})
    assert claim.json()['claimed']
    assert db.execute('SELECT attempts FROM managed_job_outcomes')[0]['attempts'] == 1
    replies = []
    def lose_denied_reply(path, body):
        with httpx.Client(timeout=3) as http:
            reply = http.post(path, json=body)
        assert reply.status_code == 200, reply.text
        if path.endswith('/wake-claim'):
            assert reply.json()['claimed'] is False  # B never owned A's admission.
            replies.append(reply.json())
            return None  # Only the rejected HTTP reply is lost.
        return reply.json()
    monkeypatch.setattr(notifier, '_post_json', lose_denied_reply)
    assert notifier_wake_worker.spawn(service[0], stale, prompt='Inspect the result.',
        event='managed_command_completion', dry_run=False, quiet=True, lease_ttl=120,
        live_workers={}, services=notifier) is None
    assert replies
    # Launcher A still has its lease and can now start a real recorded worker.
    token = (await client.post(f"/api/agents/{managed['aid']}/embodiment-tokens",
        json={'lane':'work', 'kind':'headless'})).json()['run_token']
    run = await client.post(f"/api/agents/{managed['aid']}/runs", json={'task_id':managed['tid'],
        'token_id':token, 'wake_event':'managed_command_completion'})
    assert run.status_code == 201, run.text
    assert db.execute('SELECT attempts FROM managed_job_outcomes')[0]['attempts'] == 1, \
        'A rejected competitor refunded the admitted worker before it started'


async def test_old_refund_cannot_release_a_new_admission(client, managed, db):
    await publish(client, managed)
    db.execute("UPDATE tasks SET autonomy='on' WHERE id=%s", (managed['tid'],))
    job = await reserve(client, managed)
    await finish_worker(client, managed)
    await client.post(monitor_url(managed, job, 'observe'), json=observation(job))
    old = (await candidate(client, managed, db))['completion']
    claim_url = f"/api/agents/{managed['aid']}/wake-claim"
    release_url = monitor_url(managed, job, 'unlaunched-wake')
    first = (await client.post(claim_url, json={'completion':old})).json()
    assert first['claimed']
    old = {**old, 'admission_id': first['admission_id']}
    assert (await client.post(release_url, json=old)).json()['released']
    db.execute('UPDATE managed_job_outcomes SET next_attempt_at=%s', (db.ago(1),))
    db.execute('UPDATE agent_wake_state SET wake_lease_until=%s', (db.ago(1),))
    new = (await candidate(client, managed, db))['completion']
    assert new['operation_id'] == old['operation_id']  # Same attempt, different launch.
    second = (await client.post(claim_url, json={'completion':new})).json()
    assert second['claimed'] and second['admission_id'] != first['admission_id']
    assert not (await client.post(release_url, json=old)).json()['released'], \
        'An old refunded operation released a different newly admitted launch'
    assert db.execute('SELECT attempts FROM managed_job_outcomes')[0]['attempts'] == 1
    # A replayed claim naming a returned launch identity never admits a free start.
    db.execute('UPDATE agent_wake_state SET wake_lease_until=%s', (db.ago(1),))
    assert (await client.post(release_url, json={**new, 'admission_id': second['admission_id']})).json()['released']
    db.execute('UPDATE managed_job_outcomes SET next_attempt_at=%s', (db.ago(1),))
    replay = await client.post(claim_url, json={'completion':new, 'admission_id': second['admission_id']})
    assert not replay.json()['claimed']
    assert db.execute('SELECT attempts FROM managed_job_outcomes')[0]['attempts'] == 0
