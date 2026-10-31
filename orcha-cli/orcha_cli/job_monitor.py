"""Private evidence publication shared by original supervisors and the notifier.

No command is launched, adopted or signalled here. Persist the exact observation
before sending it; retry a lost reply with the same operation and body.
"""

import hashlib
import time
from uuid import uuid4

from .job_api import JobAPI, JobAPIError, epoch
from .job_evidence import committed_adoption, verified_result
from .job_identity import same_process
from .job_store import JobStorageError, atomic_json, read_json


def evidence(store, job, *, grace_seconds=10):
    """Return verified terminal evidence, an uncertainty, or no action yet."""
    try:
        record = store.read(job['job_id'])
        if any(record.get(k) != job[k] for k in ('task_id', 'launch_nonce')):
            raise JobStorageError('Saved record belongs to another launch')
        directory = store.job_directory(job['job_id'])
        try:
            result = read_json(directory / 'result.json')
        except JobStorageError:
            result = None
        # A committed adoption can lose its reply and controller; its same-launch
        # guard result is still verified. Other owner changes stay unverified.
        same_owner = record.get('owner_run_id') == job['owner_run_id'] or committed_adoption(record, job)
        if same_owner and result and verified_result(directory, record, result):
            return dict(state=result['status'], termination_verified=True,
                        result_digest=hashlib.sha256((directory / 'result.json').read_bytes()).hexdigest())
        process = read_json(directory / 'process.json')
        if (process.get('launch_nonce') == job['launch_nonce']
                and same_process(process.get('guard')) and same_process(record.get('supervisor'))):
            return None
    except (JobStorageError, OSError, KeyError, ValueError, TypeError):
        pass
    if time.time() - epoch(job['reserved_at']) < grace_seconds:
        return None
    return dict(state='unknown', termination_verified=False, result_digest=None)


def publish(api, store, job, outcome=None):
    path = store.root / f".observation-{job['job_id']}.json"
    receipt_path = store.root / f".observation-receipt-{job['job_id']}.json"
    with store.locked():
        store.job_directory(job['job_id'], create=True)  # Missing record keeps teardown fenced.
        if path.exists():
            body = read_json(path)
        else:
            value = evidence(store, job)
            if value is None:
                return None
            if outcome and (outcome['termination_verified'] or not value['termination_verified']):
                return None
            # This is a mechanical observation, not a forged reasoning checkpoint.
            checkpoint = {'job_id':job['job_id'], 'launch_nonce':job['launch_nonce'], **value}
            evidence_path = store.root / f".observation-evidence-{job['job_id']}.json"
            atomic_json(evidence_path, checkpoint)
            body = dict(operation_id=str(uuid4()), expected_version=job['version'],
                owner_run_id=job['owner_run_id'], launch_nonce=job['launch_nonce'],
                checkpoint_version=job['checkpoint_version']+1,
                checkpoint_digest=hashlib.sha256(evidence_path.read_bytes()).hexdigest(), **value)
            atomic_json(path, body)
    try:
        response = api.request(f"job-monitors/{job['job_id']}/observe", body)
    except JobAPIError as exc:
        # The server checks its operation receipt BEFORE these exact refusals,
        # proving this body did not commit. Retain the rejected body for
        # diagnostics and rebuild from the registry; never rotate after a
        # timeout, and never across launches. An owner refusal rotates only
        # once the registry names the newer same-launch owner (e.g. a committed
        # adoption); evidence is then rechecked against that owner, once.
        stale_owner = (exc.code == 'managed_recovery_identity_changed'
                       and body['launch_nonce'] == job['launch_nonce']
                       and body['owner_run_id'] != job['owner_run_id'])
        if exc.code == 'managed_checkpoint_version_changed' or stale_owner:
            with store.locked():
                if path.exists() and read_json(path) == body:
                    atomic_json(store.root/f".rejected-observation-{body['operation_id']}.json", body)
                    path.unlink()
            if stale_owner:
                return publish(api, store, job, outcome)
        raise
    with store.locked():
        atomic_json(receipt_path, response)
        # Another publisher may have completed this same body already.
        if path.exists() and read_json(path) == body:
            path.unlink()
    return response


def publish_from_supervisor(supervisor):
    """Best-effort prompt delivery; registry reconciliation is the durable retry."""
    r = supervisor.record
    job = dict(job_id=r['job_id'], task_id=r['task_id'], launch_nonce=r['launch_nonce'],
        owner_run_id=r['owner_run_id'], version=r['server_version'],
        checkpoint_version=0, reserved_at=r.get('reserved_at', '1970-01-01T00:00:00+00:00'))
    from .job_supervisor import evidence_version
    if r.get('checkpoint'):
        job['checkpoint_version'] = evidence_version(r)
    try:
        publish(supervisor.api, supervisor.store, job)
    except (JobAPIError, JobStorageError, OSError, ValueError, KeyError):
        pass
