"""Local-daemon handoff and stop coordination for detached managed commands.

No recorded PID is signaled here. The original child guard consumes a private,
run/nonce-bound stop request even after its server credentials are revoked.
Uncertain evidence retains the launch/worktree fence and prevents respawning.
"""

from __future__ import annotations

import fcntl
import math
import os
import time
from uuid import UUID, uuid5

from .job_api import JobAPI, JobAPIError, AuthorityClock
from .job_evidence import context_snapshot, verified_result
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
            if not verified_result(directory, record, result):
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


def prepare(api_base, worker, services, *, reason, stop=False, wait_secs=5, retained_jobs=()):
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
                if record.get('owner_run_id') != worker['run_id']:
                    continue  # A stale daemon pass must not stop its successor.
                atomic_json(directory / 'handoff.json', {
                    **context_snapshot(directory), 'job_id': record['job_id'],
                    'owner_run_id': record['owner_run_id'], 'launch_nonce': record['launch_nonce'],
                    'reason': reason, 'saved_at': time.time(), 'status': record['status'],
                    'record': 'record.json', 'process': 'process.json', 'result': 'result.json',
                    'recovery': 'Inspect the original reservation and saved result before continuing.',
                })
                if stop and not settled(record) and record['job_id'] not in retained_jobs:
                    atomic_json(directory / 'daemon-stop.json', {
                        'owner_run_id': record['owner_run_id'], 'launch_nonce': record['launch_nonce'],
                        'reason': ('transfer_budget_exhausted' if reason == 'checkpoint_transfer'
                                   and record.get('continuation') == 'readonly_single_process_v1'
                                   and record.get('transfers_used', 0) >= record.get('max_transfers', 0)
                                   else reason),
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
        if worker.get('workflow') and not worker.get('run_token'):
            # Activation gives the token only to the bootstrap, never to the
            # notifier. Workflow runs have no ordinary scheduling lease to
            # reconcile. Their retained supervisors validate current generation
            # and enforce finite authority independently, including during a
            # paused or unavailable daemon.
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
                if clock.until == 0:
                    restore_authority(store, record, clock)
                if time.monotonic() >= clock.until:
                    return False
        return True
    except (OSError, ValueError, KeyError, JobStorageError, JobAPIError):
        return False


def restore_authority(store, record, clock):
    """Read a finite confirmation from the still-original, same-boot controller.

    This permits supervision only. It never restores mutation permission, and a
    changed owner, controller or missing evidence leaves the deadline at zero.
    """
    from .job_identity import same_process
    try:
        saved = read_json(store.job_directory(record['job_id']) / 'authority.json')
        if (any(saved.get(k) != record.get(k) for k in
                ('job_id', 'owner_run_id', 'launch_nonce', 'supervisor'))
                or not same_process(saved.get('supervisor'))):
            return
        bounds = [saved[k] for k in ('authority_until_monotonic', 'fixed_until_monotonic',
                                     'budget_until_monotonic')]
        if (not all(isinstance(v, (float, int)) and math.isfinite(v) for v in bounds)
                or not 0 < saved['confirmed_at_monotonic'] <= time.monotonic()):
            return
        clock.until = min(bounds)
        clock.mutations_allowed = False
    except (OSError, ValueError, TypeError, KeyError, JobStorageError):
        return


def prepare_if_due(api_base, worker, services, now):
    deadlines = [worker[k] for k in ('hard_deadline', 'managed_sandbox_until') if worker.get(k)]
    if worker.get('scheduling_lease_until'):
        from .job_api import epoch
        deadlines.append(epoch(worker['scheduling_lease_until']))
    if deadlines and now >= min(deadlines) - 65:
        prepare(api_base, worker, services, reason='deadline_approaching')


def transfer_due(worker, now):
    """Start replacement while the old fixed cap still has a full minute left."""
    if (worker.get('sandbox_container_id')
            or not worker.get('respawn_ctx')
            or (not worker.get('workflow') and not worker.get('run_token'))
            or not worker.get('hard_deadline') or now < worker['hard_deadline'] - 65):
        return False
    try:
        _, records = run_jobs(worker)
        if worker.get('workflow'):
            return any(not settled(r) for r in records)
        return any(r.get('continuation') == 'readonly_single_process_v1'
                   and r.get('status') == 'running' and r.get('transfer_socket') for r in records)
    except (OSError, ValueError, JobStorageError):
        return False


def prepare_replacement(api_base, worker, services):
    """Stop generic jobs first, then freeze eligible retained controllers."""
    from .job_transfer import transfer_command
    try:
        store, records = run_jobs(worker)
        eligible = [r['job_id'] for r in records if r.get('continuation') == 'readonly_single_process_v1'
                    and r.get('status') == 'running' and r.get('transfer_socket')
                    and r.get('transfers_used', 0) < r.get('max_transfers', 0)]
        if not prepare(api_base, worker, services, reason='checkpoint_transfer', stop=True,
                       retained_jobs=eligible):
            return False
        for jid in eligible:
            transfer_command(store, jid, 'prepare', worker['run_token'])
        worker['managed_transfers'] = eligible
        return True
    except (OSError, ValueError, KeyError, JobStorageError, JobAPIError):
        # Freeze cannot be undone. Stop the retained commands and checkpoint the
        # worker normally only after all command dispositions are verified.
        worker['managed_transfers'] = []
        return prepare(api_base, worker, services, reason='transfer_unavailable', stop=True)


def adopt_replacement(previous, successor):
    from .job_transfer import transfer_command
    try:
        store, _ = run_jobs(previous)
        for jid in previous.get('managed_transfers', []):
            record = reconcile_result(store, store.read(jid))
            if settled(record):
                continue  # The successor can import the saved result, no rerun.
            transfer_command(store, jid, 'adopt', successor['run_token'])
        return True
    except (OSError, ValueError, KeyError, JobStorageError, JobAPIError):
        successor['managed_transfer_needs_recovery'] = True
        return False  # Original guards retain their old, finite stop deadline.
