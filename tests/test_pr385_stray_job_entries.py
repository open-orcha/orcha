"""A non-record entry in the shared jobs folder must not stop unrelated workers.

Regression for the 2026-10-30 incident: a stray file and folder written into
.claude/.orcha-jobs made every worker's renewal scan fail, and each failure was
treated as lost managed authority. Only a worker's OWN unreadable or missing
record may cost that worker its authority.
"""

import asyncio
from types import SimpleNamespace
from uuid import uuid4

from orcha_cli import notifier_embodiment, notifier_managed_jobs as handoff, sandbox
from orcha_cli.job_store import JobStore
from test_gh312_job_supervisor import service, jobs, running, eventually  # noqa: F401
from test_gh312_managed_messages import managed  # noqa: F401


def add_strays(store):
    (store.root / 'workflow-step-2-session.json').write_text('{"not": "a record"}')
    folder = store.root / 'workflow-step-2-frrql6x3'
    folder.mkdir()
    (folder / 'context-input.json').write_text('{}')


def own_job(store, run_id, base, status='running'):
    jid = str(uuid4())
    store.reserve(jid, {'owner_run_id': run_id, 'launch_nonce': str(uuid4()),
                        'task_id': str(uuid4()), 'cwd': str(base), 'status': status})
    return jid


def test_stray_file_and_folder_do_not_stop_unrelated_worker(tmp_path, caplog):
    store = JobStore(tmp_path)
    add_strays(store)
    worker = {'run_id': str(uuid4()), 'base_cwd': str(tmp_path)}
    assert handoff.reconcile_renewal('http://test', worker)
    assert handoff.run_jobs(worker)[1] == []
    assert 'workflow-step-2-session.json' in caplog.text
    assert 'workflow-step-2-frrql6x3' in caplog.text


def test_stray_entries_do_not_hide_a_workers_own_records(tmp_path):
    store = JobStore(tmp_path)
    add_strays(store)
    rid = str(uuid4())
    jid = own_job(store, rid, tmp_path)
    other = own_job(store, str(uuid4()), tmp_path)
    _, records = handoff.run_jobs({'run_id': rid, 'base_cwd': str(tmp_path)})
    assert [r['job_id'] for r in records] == [jid]
    assert other != jid


def test_corrupt_record_affects_only_its_owner(tmp_path):
    store = JobStore(tmp_path)
    owner = {'run_id': str(uuid4()), 'base_cwd': str(tmp_path)}
    bystander = {'run_id': str(uuid4()), 'base_cwd': str(tmp_path)}
    jid = own_job(store, owner['run_id'], tmp_path)
    handoff.run_jobs(owner)  # The owner's watcher has observed its live command.
    handoff.run_jobs(bystander)
    (store.job_directory(jid) / 'record.json').write_text('{corrupt')
    assert handoff.reconcile_renewal('http://test', bystander)
    assert not handoff.reconcile_renewal('http://test', owner)


def test_missing_own_record_stops_owner_only(tmp_path):
    store = JobStore(tmp_path)
    owner = {'run_id': str(uuid4()), 'base_cwd': str(tmp_path)}
    bystander = {'run_id': str(uuid4()), 'base_cwd': str(tmp_path)}
    jid = own_job(store, owner['run_id'], tmp_path)
    handoff.run_jobs(owner)
    (store.job_directory(jid) / 'record.json').unlink()
    assert handoff.reconcile_renewal('http://test', bystander)
    assert not handoff.reconcile_renewal('http://test', owner)


def test_unattributable_corrupt_record_is_skipped_by_unobserved_worker(tmp_path, caplog):
    store = JobStore(tmp_path)
    jid = own_job(store, str(uuid4()), tmp_path)
    (store.job_directory(jid) / 'record.json').write_text('[]')
    worker = {'run_id': str(uuid4()), 'base_cwd': str(tmp_path)}
    assert handoff.reconcile_renewal('http://test', worker)
    assert jid in caplog.text


def corrupt(store, jid):
    (store.job_directory(jid) / 'record.json').write_text('{corrupt')


def transport():
    return SimpleNamespace(_post_json=lambda *a: {'message_id': str(uuid4())})


def test_unreadable_record_keeps_stop_and_replacement_uncertain_for_fresh_worker(tmp_path):
    store = JobStore(tmp_path)
    worker = {'run_id': str(uuid4()), 'base_cwd': str(tmp_path), 'run_token': 'unused'}
    corrupt(store, own_job(store, worker['run_id'], tmp_path))
    # No ownership history yet (fresh worker or notifier restart): unknown is not "no commands".
    assert not handoff.prepare('http://test', worker, transport(), reason='stop', stop=True, wait_secs=0)
    assert worker['managed_disposition_unknown']
    successor = {'run_id': str(uuid4()), 'base_cwd': str(tmp_path), 'run_token': 'unused'}
    assert not handoff.prepare_replacement('http://test', successor, transport())
    assert successor['managed_disposition_unknown']
    assert handoff.reconcile_renewal('http://test', dict(successor))  # Renewal alone stays isolated.


def test_unreadable_record_blocks_container_removal(tmp_path, monkeypatch):
    from test_gh312_job_sandbox import docker_boundary, setup_record
    store, record, payload = setup_record(tmp_path)
    corrupt(store, record['job_id'])
    calls = []
    monkeypatch.setattr(sandbox, '_docker', docker_boundary(payload, calls))
    worker = {'run_id': record['owner_run_id'], 'base_cwd': str(tmp_path),
              'sandbox_container_id': 'orcha-run-test'}
    notifier_embodiment.reap_sandbox_artifacts(worker, sandbox_mod=sandbox)
    assert not any(c[0] in {'rm', 'stop'} for c in calls)


def test_strays_alone_keep_stop_and_replacement_certain(tmp_path):
    store = JobStore(tmp_path)
    add_strays(store)
    worker = {'run_id': str(uuid4()), 'base_cwd': str(tmp_path), 'run_token': 'unused'}
    assert handoff.prepare('http://test', worker, transport(), reason='stop', stop=True, wait_secs=0)
    assert handoff.prepare_replacement('http://test', worker, transport())
    assert not worker.get('managed_disposition_unknown')


def test_worktree_retention_ignores_strays_but_keeps_unreadable_records(tmp_path):
    store = JobStore(tmp_path)
    add_strays(store)
    with store.locked():
        assert not store.retains_worktree(tmp_path)
    jid = own_job(store, str(uuid4()), tmp_path, status='completed')
    (store.job_directory(jid) / 'record.json').write_text('{corrupt')
    with store.locked():
        assert store.retains_worktree(tmp_path)


def test_startup_pointers_survive_stray_entries(tmp_path):
    from orcha_cli.job_guidance import startup_guidance
    store = JobStore(tmp_path)
    add_strays(store)
    tid, jid = str(uuid4()), str(uuid4())
    store.reserve(jid, {'task_id': tid, 'owner_run_id': str(uuid4()), 'cwd': str(tmp_path),
                        'status': 'running'})
    guidance = startup_guidance(tmp_path, tid)
    assert jid in guidance
    assert 'could not be read' not in guidance  # Strays are not unreadable evidence.


async def test_genuine_authority_loss_still_stops_owner_amid_strays(jobs, managed, service, db):  # noqa: F811
    api, store, launch = jobs
    jid = launch('import time;time.sleep(60)')
    eventually(lambda: running(store, jid))
    add_strays(store)
    base = str(store.root.parent.parent)
    owner = {'run_id': managed['rid'], 'run_token': managed['token'], 'base_cwd': base,
             'respawn_ctx': {'task_id': managed['tid']}}
    bystander = {'run_id': str(uuid4()), 'run_token': managed['token'], 'base_cwd': base}
    assert await asyncio.to_thread(handoff.reconcile_renewal, service[0], owner)
    assert await asyncio.to_thread(handoff.reconcile_renewal, service[0], bystander)
    db.execute("UPDATE tasks SET status='cancelled' WHERE id=%s", (managed['tid'],))
    assert not await asyncio.to_thread(handoff.reconcile_renewal, service[0], owner)
    assert await asyncio.to_thread(handoff.reconcile_renewal, service[0], bystander)
