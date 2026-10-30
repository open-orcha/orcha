"""Import saved terminal evidence without acquiring control or launching again."""

from __future__ import annotations

import fcntl
import hashlib
import os
from uuid import uuid4

from .job_evidence import context_snapshot
from .job_store import JobStorageError, _open_private, atomic_json, read_json


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def recover_result(api, store, job):
    """Only an absent original supervisor permits importing its guard's result.

    Unknown or missing files remain a launch fence. A running supervisor owns
    publication even if its child has just finished; never race that publisher.
    A durable request survives a lost response under the same operation ID.
    """
    directory = store.job_directory(job['job_id'])
    lock = _open_private(directory / 'supervisor.lock', os.O_RDWR | os.O_CREAT)
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise JobStorageError('Original command supervisor is still active; retry recovery later') from None
        with store.locked():
            record = store.read(job['job_id'])
            result_path = directory / 'result.json'
            result = read_json(result_path)
            identity = ('job_id', 'owner_run_id', 'launch_nonce')
            if (any(record.get(k) != job.get(k) or result.get(k) != job.get(k) for k in identity)
                    or record.get('task_id') != api.task_id):
                raise JobStorageError('Saved command result belongs to another launch')
            if (not result.get('termination_verified')
                    or result.get('status') not in {'completed', 'interrupted', 'exhausted'}
                    or type(result.get('exit_code')) is not int
                    or result.get('signal') != (-result['exit_code'] if result['exit_code'] < 0 else None)):
                raise JobStorageError('Saved command termination is not verified; do not relaunch')
            result_digest = digest(result_path)
            if job['termination_verified']:
                if job['state'] != result['status'] or job['result_digest'] != result_digest:
                    raise JobStorageError('Saved result differs from the authoritative result')
                response = job
            else:
                pending = directory / 'recovery-publication.json'
                if pending.exists():
                    body = read_json(pending)
                    if (body.get('source_owner_run_id') != job['owner_run_id']
                            or body.get('launch_nonce') != job['launch_nonce']
                            or body.get('result_digest') != result_digest):
                        raise JobStorageError('Pending recovery belongs to different evidence')
                else:
                    version = max(record['version'], job['checkpoint_version']) + 1
                    checkpoint = directory / f'recovery-{version}.json'
                    atomic_json(checkpoint, {
                        **context_snapshot(directory), 'job_id': job['job_id'],
                        'owner_run_id': job['owner_run_id'], 'launch_nonce': job['launch_nonce'],
                        'status': result['status'], 'reason': 'saved_guard_result_recovered',
                        'result_record': 'result.json', 'version': version,
                    })
                    body = {'operation_id': str(uuid4()), 'expected_version': job['version'],
                            'source_owner_run_id': job['owner_run_id'], 'launch_nonce': job['launch_nonce'],
                            'state': result['status'], 'checkpoint_version': version,
                            'checkpoint_digest': digest(checkpoint), 'result_digest': result_digest,
                            'termination_verified': True}
                    atomic_json(pending, body)
                response = api.request(f"managed-jobs/{job['job_id']}/reconcile", body)
            record.update(status=result['status'], result_saved=True, termination_verified=True,
                          result='result.json', server_version=response['version'],
                          version=record['version'] + 1)
            atomic_json(directory / 'record.json', record)
            # Keep the retry receipt as private evidence. No command/controller
            # identity or budget changes during recovery of an already ended job.
            return response
    finally:
        os.close(lock)
