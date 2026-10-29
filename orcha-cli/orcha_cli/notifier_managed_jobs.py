"""Local-daemon handoff and stop coordination for detached managed commands.

No recorded PID is signaled here. The original child guard consumes a private,
run/nonce-bound stop request even after its server credentials are revoked.
Uncertain evidence retains the launch/worktree fence and prevents respawning.
"""

from __future__ import annotations

import fcntl
import os
import time
from uuid import UUID, uuid5

from .job_api import JobAPI, JobAPIError, AuthorityClock
from .job_evidence import context_snapshot
from .job_store import JobStore, JobStorageError, atomic_json, read_json, _open_private, jobs_root


def run_jobs(worker):
    base = worker.get('base_cwd') or worker.get('worktree')
    if not base or not worker.get('run_id') or not jobs_root(base).exists():
        return None, []
    store = JobStore(base)
    records = []
    with store.locked():
        for directory in sorted(store.root.iterdir()):
            if directory.name.startswith('.'):
                continue
            record = store.read(directory.name)
            if record.get('owner_run_id') == worker['run_id']:
                records.append(record)
    return store, records


def reconcile_result(store, record):
    """Recover guard evidence after supervisor death, without touching live state."""
    directory = store.job_directory(record['job_id'])
    fd = _open_private(directory / 'supervisor.lock', os.O_RDWR | os.O_CREAT)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return store.read(record['job_id'])
        with store.locked():
            record = store.read(record['job_id'])
            result = read_json(directory / 'result.json')
            if (any(result.get(k) != record.get(k) for k in ('job_id', 'owner_run_id', 'launch_nonce'))
                    or not result.get('termination_verified')
                    or result.get('status') not in {'completed', 'interrupted', 'exhausted'}):
                return record
            if record.get('result_saved') and record.get('termination_verified'):
                return record
            record.update(status=result['status'], result_saved=True, termination_verified=True,
                          result='result.json', version=record['version'] + 1)
            atomic_json(directory / 'record.json', record)
            return record
    except JobStorageError:
        return record
    finally:
        os.close(fd)


def settled(record):
    return (record.get('status') in {'completed', 'interrupted', 'exhausted'}
            and record.get('termination_verified') and record.get('result_saved'))


def notice(api_base, store, record, services):
    """An outbox plus a server key survives a crash or lost POST response."""
    directory = store.job_directory(record['job_id'])
    path = directory / ('notice-' + record['owner_run_id'] + '.json')
    if path.exists() and read_json(path).get('delivered'):
        return
    key = str(uuid5(UUID(record['job_id']), record['owner_run_id']))
    body = {'system_notice': True, 'system_notice_key': key,
            'body': 'Command progress and recovery details are saved. The next worker will check the original command and its results before continuing.'}
    atomic_json(path, {'key': key, 'delivered': False})
    response = services._post_json(f"{api_base}/api/tasks/{record['task_id']}/messages", body)
    if response and (response.get('message_id') or response.get('suppressed')):
        atomic_json(path, {'key': key, 'delivered': True})


def prepare(api_base, worker, services, *, reason, stop=False, wait_secs=5):
    """Flush evidence before requesting stop; return verified disposition only.

    Stopping a worker is still required when disposition is unknown, but its
    replacement must not be spawned and its working directory must be retained.
    No authority is granted by this local evidence capture.
    """
    try:
        store, records = run_jobs(worker)
        if not records:
            return True
        pending = []
        for record in records:
            record = reconcile_result(store, record)
            directory = store.job_directory(record['job_id'])
            with store.locked():
                record = store.read(record['job_id'])
                atomic_json(directory / 'handoff.json', {
                    **context_snapshot(directory), 'job_id': record['job_id'],
                    'owner_run_id': record['owner_run_id'], 'launch_nonce': record['launch_nonce'],
                    'reason': reason, 'saved_at': time.time(), 'status': record['status'],
                    'record': 'record.json', 'process': 'process.json', 'result': 'result.json',
                    'recovery': 'Inspect the original reservation and saved result before continuing.',
                })
                if stop and not settled(record):
                    atomic_json(directory / 'daemon-stop.json', {
                        'owner_run_id': record['owner_run_id'], 'launch_nonce': record['launch_nonce'],
                        'reason': reason,
                    })
                    pending.append(record)
            notice(api_base, store, record, services)
        if not stop:
            return True
        deadline = time.monotonic() + wait_secs
        while pending:
            pending = [r for r in pending if not settled(reconcile_result(store, store.read(r['job_id'])))]
            if not pending:
                return True
            if time.monotonic() >= deadline:
                worker['managed_disposition_unknown'] = True
                return False
            time.sleep(0.05)
        return True
    except (OSError, ValueError, KeyError, JobStorageError):
        worker['managed_disposition_unknown'] = True
        return False


def reconcile_renewal(api_base, worker):
    """False means stop; a mere lease lapse can retain finite supervision.

    Failed contact never extends the last confirmed local deadline. Independent
    supervisors/guards continue enforcing their own, possibly earlier deadline.
    """
    try:
        store, records = run_jobs(worker)
        live = [r for r in records if not settled(reconcile_result(store, r))]
        if not live:
            return True
        clocks = worker.setdefault('managed_authority_clocks', {})
        clients = worker.setdefault('managed_authority_clients', {})
        for record in live:
            jid = record['job_id']
            clock = clocks.setdefault(jid, AuthorityClock(worker['run_id'], jid))
            api = clients.get(jid)
            if api is None:
                api = clients[jid] = JobAPI(api_base, worker.get('run_token'), record['task_id'])
            sent = time.monotonic()
            try:
                clock.confirm(api.heartbeat(jid), sent)
            except JobAPIError as exc:
                if settled(reconcile_result(store, store.read(jid))):
                    continue  # The command may have completed during the probe.
                if exc.fenced and not exc.lease_lapsed:
                    return False
                if time.monotonic() >= clock.until:
                    # A daemon restart has no confirmed deadline in memory; the
                    # guard retains its own deadline, but do not assume authority.
                    return False
        return True
    except (OSError, ValueError, KeyError, JobStorageError, JobAPIError):
        return False


def prepare_if_due(api_base, worker, services, now):
    deadlines = [worker[k] for k in ('hard_deadline', 'managed_sandbox_until') if worker.get(k)]
    if worker.get('scheduling_lease_until'):
        from .job_api import epoch
        deadlines.append(epoch(worker['scheduling_lease_until']))
    if deadlines and now >= min(deadlines) - 65:
        prepare(api_base, worker, services, reason='deadline_approaching')
