"""Private managed-command evidence from an observed container shutdown.

Docker client exit, an absent container, or a reused name is never stop proof.
Only an inspected, exited instance matching the original launch and durable
workspace can close a launch fence. No raw inspect/config/environment is saved.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import socket
import sys
import time
from pathlib import Path

from .job_evidence import context_snapshot
from .job_store import JobStore, JobStorageError, _open_private, atomic_json, jobs_root, read_json


def launch_identity(store):
    name = os.environ.get('ORCHA_SANDBOX_CONTAINER')
    workspace = os.environ.get('ORCHA_WORKSPACE_ROOT')
    if not name and not workspace:
        return None
    # The builder uses Docker's default hostname (the immutable ID prefix).
    # Refuse a custom/unknown identity rather than promising durable recovery.
    hostname = socket.gethostname()
    if (sys.platform != 'linux' or not name or not workspace
            or not re.fullmatch(r'[a-f0-9]{12,64}', hostname)
            or Path(workspace).resolve() != store.root.parent.parent):
        raise JobStorageError('Managed sandbox identity or durable workspace is unavailable')
    return {'name': name, 'id_prefix': hostname,
            'workspace': str(store.root.parent.parent), 'recorded_at': time.time()}


def inspect_container(name, sandbox_mod, *, identifier=None):
    """Return an allowlisted snapshot, never credentials from Docker inspect."""
    try:
        response = sandbox_mod._docker(['inspect', identifier or name], timeout=10)
        if response.returncode:
            return None
        value = json.loads(response.stdout)[0]
        state, config = value['State'], value['Config']
        labels = config.get('Labels') or {}
        if (labels.get('orcha.managed') != '1'
                or labels.get('orcha.container_name') != name
                or not re.fullmatch(r'[a-f0-9]{64}', value['Id'])):
            return None
        workspaces = [v.split('=', 1)[1] for v in config.get('Env', [])
                      if v.startswith('ORCHA_WORKSPACE_ROOT=')]
        if len(workspaces) != 1:
            return None
        root = workspaces[0]
        if not Path(root).is_absolute() or str(Path(root).resolve()) != root:
            return None
        if not any(m.get('Type') == 'bind' and m.get('RW') is True
                   and m.get('Source') == root and m.get('Destination') == root
                   for m in value.get('Mounts', [])):
            return None
        return {'name': name, 'container_id': value['Id'], 'workspace': root,
                'status': state.get('Status'), 'running': state.get('Running'),
                'restarting': state.get('Restarting'), 'paused': state.get('Paused'),
                'started_at': state.get('StartedAt'), 'finished_at': state.get('FinishedAt'),
                'container_exit_code': state.get('ExitCode'), 'oom_killed': bool(state.get('OOMKilled'))}
    except (OSError, ValueError, KeyError, TypeError, IndexError, AttributeError):
        return None


def matches(record, evidence):
    from .sandbox import _parse_started_at
    original = record.get('container') or {}
    try:
        started = _parse_started_at(evidence['started_at']).timestamp()
        prefix = original['id_prefix']
        return (re.fullmatch(r'[a-f0-9]{12,64}', prefix) is not None
                and re.fullmatch(r'[a-f0-9]{64}', evidence['container_id']) is not None
                and evidence['container_id'].startswith(prefix)
                and original['name'] == evidence['name']
                and original['workspace'] == evidence['workspace']
                and 0 < started <= original['recorded_at'])
    except (KeyError, TypeError, ValueError, AttributeError, OverflowError):
        return False


def exited(record, evidence):
    from .sandbox import _parse_started_at
    try:
        return (matches(record, evidence) and evidence['status'] == 'exited'
                and evidence['running'] is False and evidence['restarting'] is False
                and evidence['paused'] is False
                and _parse_started_at(evidence['finished_at']).timestamp()
                >= record['container']['recorded_at'])
    except (KeyError, TypeError, ValueError, AttributeError, OverflowError):
        return False


def records(evidence):
    if not evidence or not jobs_root(evidence['workspace']).exists():
        return None, []
    store = JobStore(evidence['workspace'])
    with store.locked():
        rows = [record for _, record in store.entries()]
    if None in rows:
        raise JobStorageError('Managed command record is unavailable')
    return store, [r for r in rows if (r.get('container') or {}).get('name') == evidence['name']]


def save_before_stop(evidence):
    """Works without a worker-run row, using only the validated mounted root."""
    store, rows = records(evidence)
    if not store:
        return
    with store.locked():
        for row in rows:
            record = store.read(row['job_id'])
            if not matches(record, evidence):
                continue
            directory = store.job_directory(record['job_id'])
            atomic_json(directory / 'container-handoff.json', {
                **context_snapshot(directory), 'job_id': record['job_id'],
                'owner_run_id': record['owner_run_id'], 'launch_nonce': record['launch_nonce'],
                'saved_at': time.time(), 'reason': 'container_stopping',
                'container_id': evidence['container_id'], 'result_record': 'result.json',
            })
            atomic_json(directory / 'daemon-stop.json', {
                'owner_run_id': record['owner_run_id'], 'launch_nonce': record['launch_nonce'],
                'reason': 'container_stopping',
            })


def save_after_exit(evidence):
    """Persist unknown command exit code separately from the container exit code.

    Keep an original guard result byte-for-byte. If its supervisor is still
    publishing, leave it alone and retain the container for a later sweep.
    """
    if evidence is None:
        return False
    store, rows = records(evidence)
    if not store:
        return True
    safe = True
    for row in rows:
        directory = store.job_directory(row['job_id'])
        lock = _open_private(directory / 'supervisor.lock', os.O_RDWR | os.O_CREAT)
        try:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                safe = False
                continue
            with store.locked():
                record = store.read(row['job_id'])
                if not exited(record, evidence):
                    safe = False
                    continue
                result_path = directory / 'result.json'
                if not result_path.exists():
                    proof = directory / 'container-exit.json'
                    for name in ('stdout.log', 'stderr.log'):
                        if (directory / name).exists():
                            fd = _open_private(directory / name, os.O_RDONLY)
                            try:
                                os.fsync(fd)
                            finally:
                                os.close(fd)
                    atomic_json(proof, evidence)
                    atomic_json(result_path, {
                        'job_id': record['job_id'], 'launch_nonce': record['launch_nonce'],
                        'owner_run_id': record.get('launch_owner_run_id', record['owner_run_id']),
                        'status': 'interrupted', 'exit_code': None, 'signal': None,
                        'reason': 'container_exited_command_status_unavailable',
                        'termination_verified': True, 'termination_source': 'container_exit',
                        'container_evidence_digest': hashlib.sha256(proof.read_bytes()).hexdigest(),
                        'finished_at': time.time(), 'stdout': 'stdout.log', 'stderr': 'stderr.log',
                    })
                result = read_json(result_path)
                from .job_evidence import verified_result
                if not verified_result(directory, record, result):
                    safe = False
                    continue
                if (record.get('status') == result['status'] and record.get('termination_verified')
                        and record.get('result_saved')):
                    continue
                record.update(status=result['status'], termination_verified=True, result_saved=True,
                              result='result.json', version=record['version'] + 1)
                atomic_json(directory / 'record.json', record)
        finally:
            os.close(lock)
    return safe


def verified_container_result(directory, record, result):
    if (result.get('status') != 'interrupted' or result.get('exit_code') is not None
            or result.get('signal') is not None):
        return False
    proof = directory / 'container-exit.json'
    evidence = read_json(proof)
    return (result.get('container_evidence_digest') == hashlib.sha256(proof.read_bytes()).hexdigest()
            and exited(record, evidence))
