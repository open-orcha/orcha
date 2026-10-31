"""Common managed-command interface used by one-shot Claude and Codex workers."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from uuid import UUID, uuid4, uuid5

from .job_api import JobAPI, JobAPIError
from .job_identity import same_process
from .job_store import JobStore, JobStorageError, atomic_json, command_summary, read_json, _open_private
from .job_supervisor import module_environment
from .job_executor import minimal_environment


def register(sub, handler):
    parser = sub.add_parser('job', help='Run and monitor a durable, supervised foreground command')
    parser.add_argument('--task', default=os.environ.get('ORCHA_TASK_ID'), help='current task identity')
    parser.add_argument('--base-cwd', help='durable project directory (normally detected)')
    commands = parser.add_subparsers(dest='job_action', required=True)
    start = commands.add_parser('start', help='reserve once; retries never launch another copy')
    start.add_argument('--key', required=True, help='stable name for this task operation; reuse on retries')
    start.add_argument('--purpose', required=True, help='brief description without credentials')
    start.add_argument('--max-seconds', type=int, default=7200)
    start.add_argument('--max-transfers', type=int, default=3)
    start.add_argument('--port', type=int, action='append', default=[],
                       help='local port used by the command; repeat as needed')
    start.add_argument('--artifact', action='append', default=[],
                       help='output path relative to the command directory; saved privately, never uploaded')
    start.add_argument('--isolate', action='store_true',
                       help='macOS: deny shared writes, network, IPC and subprocesses; write only to ORCHA_JOB_SCRATCH')
    start.add_argument('--continue-after-exit', action='store_true',
                       help='explicit finite continuation of an isolated ordinary host command after the worker exits')
    start.add_argument('command', nargs=argparse.REMAINDER)
    status = commands.add_parser('status', help='read status and saved exit information without raw logs')
    status.add_argument('job_id', nargs='?')
    wait = commands.add_parser('wait', help='bounded wait; returns early for guidance or deadline')
    wait.add_argument('job_id')
    wait.add_argument('--seconds', type=float, default=100)
    checkpoint = commands.add_parser('checkpoint', help='save private reasoning and request a mechanical checkpoint')
    checkpoint.add_argument('job_id')
    checkpoint.add_argument('--context-file', help='JSON with completed_steps and remaining_steps')
    yielded = commands.add_parser('yield', help='save progress and wait for command completion without a model worker')
    yielded.add_argument('job_id')
    yielded.add_argument('--context-file', required=True)
    result_handled = commands.add_parser('result-handled', help='handle one exact saved result or resolve uncertainty')
    result_handled.add_argument('job_id')
    result_handled.add_argument('--revision', type=int, required=True)
    result_handled.add_argument('--disposition', choices=['applied', 'uncertainty_resolved'], required=True)
    result_handled.add_argument('--note', required=True, help='brief safe explanation without logs or credentials')
    result_handled.add_argument('--release-checkout', action='store_true',
                                help='saved remaining steps no longer need the original checkout')
    handled = commands.add_parser('handled', help='explicitly acknowledge guidance after handling it')
    handled.add_argument('message_id')
    handled.add_argument('--outcome', choices=['applied', 'not_applicable'], required=True)
    handled.add_argument('--note', help='explanation without credentials or command output')
    stop = commands.add_parser('stop', help='ask the current supervisor to checkpoint and stop its command')
    stop.add_argument('job_id')
    recover = commands.add_parser('recover', help='reconcile a saved result from an ended worker; never relaunch')
    recover.add_argument('job_id')
    adopt = commands.add_parser('adopt', help='take over a prepared isolated command through its original supervisor')
    adopt.add_argument('job_id')
    parser.set_defaults(func=handler)


def project_directory(cwd):
    for path in (cwd, *cwd.parents):
        if (path / '.claude' / 'orcha.json').is_file():
            return path
    raise JobStorageError('No Orcha project configuration found')


def summary(store, job):
    value = {k: job[k] for k in ('job_id', 'state', 'owner_run_id', 'budget_until', 'transfers_used')}
    try:
        local = store.read(job['job_id'])
        if local['task_id'] != job['task_id'] or local['launch_nonce'] != job['launch_nonce']:
            raise JobStorageError('Managed command evidence belongs to another launch')
        value.update(status=local['status'], record=str(store.job_directory(job['job_id']) / 'record.json'))
        if local['status'] == 'running':
            process = read_json(store.job_directory(job['job_id']) / 'process.json')
            if (process['launch_nonce'] != job['launch_nonce']
                    or not same_process(process.get('guard'))
                    or not same_process(local.get('supervisor'))):
                value.update(status='unknown', reason='Controller identity unavailable; do not relaunch')
        result_path = store.job_directory(job['job_id']) / 'result.json'
        if result_path.exists():
            result = read_json(result_path)
            if (any(result.get(k) != job.get(k) for k in ('job_id', 'launch_nonce'))
                    or result.get('owner_run_id') != local.get('launch_owner_run_id', job['owner_run_id'])):
                raise JobStorageError('Managed result belongs to another launch')
            from .job_evidence import verified_result
            if not verified_result(store.job_directory(job['job_id']), local, result):
                raise JobStorageError('Managed command termination is not verified')
            value.update(status=result['status'], exit_code=result['exit_code'],
                         termination_verified=result['termination_verified'], reason=result['reason'])
    except (JobStorageError, KeyError):
        value.update(status='unknown', reason='Local evidence unavailable; do not relaunch')
    return value


def start_job(api, store, *, key, purpose, argv, cwd, max_seconds=7200, max_transfers=3,
              isolate=False, ports=(), artifacts=(), continue_after_exit=False):
    if not argv:
        raise ValueError('A foreground command is required after --')
    if (len(ports) > 32 or any(type(port) is not int or not 1 <= port <= 65535 for port in ports)
            or len(artifacts) > 100):
        raise ValueError('Invalid declared command ports or artifacts')
    for artifact in artifacts:
        if (not isinstance(artifact, str) or not artifact or len(artifact) > 1024
                or Path(artifact).is_absolute() or '..' in Path(artifact).parts
                or any(ord(character) < 32 for character in artifact)
                or not (Path(cwd) / artifact).resolve().is_relative_to(Path(cwd).resolve())):
            raise ValueError('Artifacts must be local paths within the command directory')
    if not Path(cwd).resolve().is_relative_to(store.root.parent.parent):
        raise JobStorageError('Command directory is outside the durable workspace')
    from . import job_isolation
    if isolate:
        job_isolation.require_available()
    contract = job_isolation.CONTRACT if isolate else 'stop_before_transfer'
    from .job_sandbox import launch_identity
    container = launch_identity(store)
    if continue_after_exit and (not isolate or container):
        raise ValueError('Continuation requires an isolated ordinary host command')
    job_key = str(uuid5(UUID(api.task_id), key))
    registration = store.root / f'.reservation-{job_key}.json'
    with store.locked():
        if not registration.exists():
            atomic_json(registration, {'task_id':api.task_id, 'cwd':str(Path(cwd).resolve()),
                                       'continuation':contract, 'job_id':None})
        saved_registration = read_json(registration)
        if saved_registration['cwd'] != str(Path(cwd).resolve()) or saved_registration['continuation'] != contract:
            raise JobStorageError('Retry must use the original command directory and isolation')
    capability = None
    if continue_after_exit:
        import secrets
        path = store.root / f'.continuation-{job_key}.json'
        with store.locked():
            if not path.exists():
                atomic_json(path, {'capability':secrets.token_urlsafe(32)})
            capability = read_json(path)['capability']
    import hashlib
    job = api.request('managed-jobs', {'job_key': job_key,
                                     'max_elapsed_secs': max_seconds, 'max_transfers': max_transfers,
                                     'continue_after_exit':continue_after_exit,
                                     'continuation_capability_digest':hashlib.sha256(capability.encode()).hexdigest() if capability else None,
                                     'continuation_contract': contract})
    with store.locked():
        atomic_json(registration, {**saved_registration, 'job_id':job['job_id']})
        directory = store.job_directory(job['job_id'], create=True)
        path = directory / 'record.json'
        previous = None
        if path.exists():
            previous = store.read(job['job_id'])
            if not retry_unstarted(directory, previous, job):
                return summary(store, job)
        if job['version'] != 0 or job['state'] != 'reserved':
            return {'job_id': job['job_id'], 'status': 'unknown',
                    'reason': 'Existing launch has no local evidence; do not relaunch'}
        record = {'job_id': job['job_id'], 'task_id': api.task_id,
                  'version': previous['version'] + 1 if previous else 0,
                  'server_version': job['version'], 'owner_run_id': job['owner_run_id'],
                  'workflow_generation': job['workflow_generation'], 'launch_nonce': job['launch_nonce'],
                  'status': 'reserved', 'cwd': str(Path(cwd).resolve()), 'purpose': purpose,
                  'ports': sorted(set(ports)), 'artifacts': list(dict.fromkeys(artifacts)),
                  'command': command_summary(argv), 'budget_until': job['budget_until'],
                  'max_transfers': job['max_transfers'], 'transfers_used': job['transfers_used'],
                  'launch_claimed': True, 'continuation': contract,
                  'reserved_at':job.get('reserved_at'), 'monitor_enabled':True,
                  'continue_after_exit':continue_after_exit,
                  'launch_attempt': str(uuid4())}
        if previous:
            # Retrying requires fresh argv, but cannot change the reserved
            # contract, original declarations, directory or absolute budget.
            for name in ('cwd', 'purpose', 'ports', 'artifacts', 'command', 'continuation'):
                record[name] = previous[name]
            if record['cwd'] != str(Path(cwd).resolve()) or record['continuation'] != contract:
                raise JobStorageError('Retry must use the original command directory and isolation')
        if container:
            record['container'] = container
        # Serialize against teardown and competing CLI starts. Any crash after
        # this durable reservation retains the fence, including before Popen.
        if not Path(cwd).is_dir():
            raise JobStorageError('Command directory is unavailable')
        atomic_json(path, record)
        if isolate:
            job_isolation.prepare(directory)
        atomic_json(directory / 'context.json', {'completed_steps': [], 'remaining_steps': []})
        atomic_json(directory / 'guidance.json', {'received_position': None, 'handled_position': None,
                                                'pending_messages': [], 'has_more': True})
        config = {'base_cwd': str(store.root.parent.parent), 'job_id': job['job_id'],
                  'launch_attempt': record['launch_attempt'],
                  'launch_nonce': job['launch_nonce'], 'cwd': record['cwd'], 'argv': argv,
                  'env': minimal_environment(os.environ), 'api_base': api.url.geturl(), 'token': api.token}
        if capability:
            config['continuation_capability'] = capability
        proc = subprocess.Popen([sys.executable, '-m', 'orcha_cli.job_supervisor'],
                                stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                env=module_environment(), start_new_session=True, close_fds=True)
        try:
            proc.stdin.write(json.dumps(config).encode() + b'\n')
            proc.stdin.close()
        except (OSError, ValueError):
            raise JobStorageError('Launch outcome is uncertain; inspect this reservation') from None
    return summary(store, job)


def retry_unstarted(directory, record, job):
    """Only an explicit pre-contact failure permits another supervisor attempt.

    Absence of process evidence alone never proves that a launch did not happen.
    The supervisor lock excludes an attempt still finishing its failure path.
    """
    if (record.get('status') != 'not_started' or job['state'] != 'reserved' or job['version'] != 0
            or any(record.get(k) != job.get(k) for k in ('task_id', 'owner_run_id', 'launch_nonce'))
            or any((directory / name).exists() for name in ('process.json', 'result.json', 'publication.json'))):
        return False
    lock = _open_private(directory / 'supervisor.lock', os.O_RDWR | os.O_CREAT)
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        return True
    finally:
        os.close(lock)


def current_job(api, job_id, *, timeout=None):
    jobs = api.request('managed-jobs', method='GET', timeout=timeout)['jobs']
    return next((job for job in jobs if job['job_id'] == str(UUID(job_id))), None)


def save_guidance(store, job_id, page):
    # Message bodies remain in the authoritative thread, not startup pointers.
    refs = {k: page.get(k) for k in ('received_position', 'handled_position')}
    refs['pending_messages'] = [{'message_id': m['message_id'], 'event_ids': m['event_ids'],
                                 'operation_key': m['operation_key']} for m in page['messages']]
    refs['has_more'] = page['has_more']
    with store.locked():
        atomic_json(store.job_directory(job_id) / 'guidance.json', refs)


def wait_for_job(api, store, job_id, seconds):
    if not 0 < seconds <= 110:
        raise ValueError('Wait must be greater than zero and at most 110 seconds')
    deadline = time.monotonic() + seconds
    job = current_job(api, job_id, timeout=seconds)
    if job is None:
        raise JobStorageError('Managed command not found in this task')
    while time.monotonic() < deadline:
        remaining = deadline - time.monotonic()
        # The receipt endpoint performs full current-run/task/hold validation.
        page = api.request('managed-messages/poll', {}, timeout=remaining)
        save_guidance(store, job_id, page)
        if page['messages']:
            return {'reason': 'guidance', **page, 'job': summary(store, job)}
        outcomes = api.request('job-outcomes/poll', {}, timeout=max(0.01, deadline-time.monotonic()))
        if outcomes['outcomes']:
            return {'reason':'command_outcome', **outcomes, 'job':summary(store,job), 'task':page['task']}
        value = summary(store, job)
        if value['status'] in {'completed', 'interrupted', 'exhausted', 'unknown'}:
            return {'reason': 'job_status', 'job': value, 'task': page['task']}
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        if page.get('run_id') != job['owner_run_id']:
            # A successor may monitor, handle or explicitly yield without
            # pretending to own the original command's controller.
            time.sleep(min(2, max(0, remaining)))
            job = current_job(api, job_id, timeout=max(0.01, deadline-time.monotonic()))
            continue
        authority = api.heartbeat(job_id, timeout=remaining)
        if not authority['mutations_allowed']:
            return {'reason': 'scheduling_lease_lapsed', 'job': value, 'task': page['task']}
        from .job_api import epoch
        if epoch(authority['prepare_at']) <= epoch(authority['server_time']):
            return {'reason': 'prepare_checkpoint', 'job': value, 'task': page['task']}
        time.sleep(min(2, max(0, deadline - time.monotonic())))
    return {'reason': 'wait_complete', 'job': summary(store, job)}


def request_control(api, store, job_id, action, context=None):
    if action == 'stop':
        return api.request(f'job-monitors/{job_id}/stop', {})
    authority = api.heartbeat(job_id)
    if not authority['mutations_allowed']:
        raise JobAPIError(409)
    with store.locked():
        record = store.read(job_id)
        if record['owner_run_id'] != authority['run_id']:
            raise JobAPIError(409)
        directory = store.job_directory(job_id)
        if context is not None:
            if not isinstance(context, dict) or set(context) - {'completed_steps', 'remaining_steps'}:
                raise ValueError('Context accepts completed_steps and remaining_steps only')
            for steps in context.values():
                if (not isinstance(steps, list) or len(steps) > 100
                        or any(not isinstance(step, str) or len(step) > 2000 for step in steps)):
                    raise ValueError('Context requires bounded lists of step descriptions')
            atomic_json(directory / 'context.json', context)
        atomic_json(directory / f'control-{uuid4()}.json', {
            'action': action, 'owner_run_id': authority['run_id'], 'launch_nonce': record['launch_nonce'],
        })
    return {'job_id': job_id, 'requested': action}


def yield_command(api, store, job_id, context):
    import hashlib
    if (not isinstance(context, dict) or set(context) != {'completed_steps','remaining_steps'}
            or any(not isinstance(v, list) or len(v)>100 or any(not isinstance(s,str) or len(s)>2000 for s in v)
                   for v in context.values())):
        raise ValueError('Yield requires bounded completed_steps and remaining_steps')
    job = current_job(api, job_id)
    if job is None:
        raise JobStorageError('Managed command not found in this task')
    with store.locked():
        record = store.read(job_id)
        if any(record.get(k) != job[k] for k in ('task_id','launch_nonce')):
            raise JobStorageError('Managed command identity changed')
        path = store.job_directory(job_id) / 'context.json'
        atomic_json(path, context)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
    receipt = api.request(f'job-monitors/{job_id}/yield', {'context_digest':digest})
    return {'job_id':job_id, 'waiting':True, 'receipt':receipt,
            'guidance':'Progress is saved. Exit this worker; completion or new guidance will resume the task.'}


def handle_result(api, store, job_id, revision, disposition, note, release_checkout=False):
    import hashlib
    job = current_job(api, job_id)
    if job is None:
        raise JobStorageError('Managed command not found in this task')
    digest = None
    if disposition == 'applied':
        from .job_evidence import verified_result
        directory = store.job_directory(job_id)
        record, result = store.read(job_id), read_json(directory / 'result.json')
        if not verified_result(directory, record, result):
            raise JobStorageError('Original command result is not verified')
        digest = hashlib.sha256((directory / 'result.json').read_bytes()).hexdigest()
    receipt = api.request(f'job-outcomes/{job_id}/handled', dict(revision=revision,
        result_digest=digest, disposition=disposition, note=note))
    # A successful receipt only releases delivery retention. The existing
    # positive-termination fence still applies, including handled uncertainty.
    try:
        with store.locked():
            record = store.read(job_id)
            # Acknowledgement can race the supervisor's final checkpoint reply.
            # Keep its receipt separate from the controller's versioned record.
            # Saved remaining steps keep the checkout unless this exact context is released.
            context = store.job_directory(job_id)/'context.json'
            atomic_json(store.job_directory(job_id)/'handled-outcome.json', {
                'job_id':job_id, 'launch_nonce':record['launch_nonce'],
                'revision':revision, 'result_digest':digest,
                'termination_verified':bool(receipt['termination_verified']),
                'checkout_released':bool(release_checkout),
                'context_digest':(hashlib.sha256(context.read_bytes()).hexdigest()
                                  if release_checkout and context.exists() else None),
            })
    except JobStorageError:
        pass
    return receipt


def cmd_job(args):
    try:
        task_id = str(UUID(args.task or ''))
        cwd = Path.cwd().resolve()
        base = Path(args.base_cwd).resolve() if args.base_cwd else project_directory(cwd)
        config = json.loads((base / '.claude' / 'orcha.json').read_text())
        api = JobAPI(config['api_base_url'], os.environ.get('ORCHA_RUN_TOKEN'), task_id)
        store = JobStore(base)
        if args.job_action == 'start':
            argv = args.command[1:] if args.command[:1] == ['--'] else args.command
            result = start_job(api, store, key=args.key, purpose=args.purpose, argv=argv, cwd=cwd,
                               max_seconds=args.max_seconds, max_transfers=args.max_transfers,
                               isolate=args.isolate, ports=args.port, artifacts=args.artifact,
                               continue_after_exit=args.continue_after_exit)
        elif args.job_action == 'status':
            jobs = api.request('managed-jobs', method='GET')['jobs']
            result = {'jobs': [summary(store, j) for j in jobs if not args.job_id or j['job_id'] == args.job_id]}
            result.update(api.request('job-outcomes/poll', {}))
        elif args.job_action == 'wait':
            result = wait_for_job(api, store, args.job_id, args.seconds)
        elif args.job_action == 'handled':
            result = api.request(f'managed-messages/{UUID(args.message_id)}/handled',
                                 {'outcome': args.outcome, 'handling_note': args.note})
        elif args.job_action == 'result-handled':
            result = handle_result(api, store, str(UUID(args.job_id)), args.revision, args.disposition, args.note,
                                   release_checkout=args.release_checkout)
        elif args.job_action == 'yield':
            result = yield_command(api, store, str(UUID(args.job_id)), json.loads(Path(args.context_file).read_text()))
        elif args.job_action == 'adopt':
            from .job_transfer import transfer_command
            if current_job(api, args.job_id) is None:
                raise JobStorageError('Managed command not found in this task')
            result = transfer_command(store, str(UUID(args.job_id)), 'adopt', api.token)
        elif args.job_action == 'recover':
            from .job_recovery import recover_result
            job = current_job(api, args.job_id)
            if job is None:
                raise JobStorageError('Managed command not found in this task')
            result = summary(store, recover_result(api, store, job))
        else:
            context = None
            if args.job_action == 'checkpoint' and args.context_file:
                context = json.loads(Path(args.context_file).read_text())
            result = request_control(api, store, str(UUID(args.job_id)), args.job_action, context)
        print(json.dumps(result))
    except (JobAPIError, JobStorageError) as exc:
        raise SystemExit(str(exc)) from None
    except (OSError, ValueError, KeyError):
        raise SystemExit('Managed command request is invalid or local evidence is unavailable') from None
