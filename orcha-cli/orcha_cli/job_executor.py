"""Network-free command guard. Supervisor pipe loss stops its original children.

Only this process signals the command's group. It never reaps the group leader
until all signals are sent, so the operating system cannot recycle that PID.
Executable argv/environment arrive via an anonymous pipe, never durable JSON.
"""

from __future__ import annotations

import json
import os
import selectors
import signal
import subprocess
import sys
import time
from pathlib import Path

from .job_evidence import context_snapshot, daemon_stop_requested, daemon_stop_reason
from .job_identity import child_exited, group_live, process_identity
from .job_store import JobStore, atomic_json


def minimal_environment(source):
    return {k: v for k, v in source.items() if k in {
        'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ',
        'VIRTUAL_ENV', 'SYSTEMROOT',
    }}


def signal_owned_group(child, sig):
    try:
        os.killpg(child.pid, sig)
    except ProcessLookupError:
        pass
    except PermissionError:
        # Darwin returns EPERM for a group containing only the pinned zombie.
        # It is safe to proceed only after confirming no live group members.
        if group_live(child.pid) is not False:
            raise


def run(config):
    store = JobStore(config['base_cwd'])
    directory = store.job_directory(config['job_id'])
    identity = {'job_id': config['job_id'], 'launch_nonce': config['launch_nonce'],
                'owner_run_id': config['owner_run_id']}
    until, prepare = config['until'], config['prepare']
    budget = config.get('budget_until', float('inf'))
    transfers_used = config.get('transfers_used', 0)
    max_transfers = config.get('max_transfers', 3)
    child = None
    reason = None
    prepared = False
    stage = 'preparing'

    def checkpoint(why):
        atomic_json(directory / 'mechanical.json', {
            **identity, **context_snapshot(directory), 'reason': why, 'saved_monotonic': time.monotonic(),
            'authority_until_monotonic': until, 'prepare_at_monotonic': prepare,
            'process_record': 'process.json', 'result_record': 'result.json',
            'guidance_record': 'guidance.json', 'worker_context': 'context.json',
            'continuation': 'Inspect saved result; never relaunch an uncertain reservation',
        })

    def stop_signal(signum, frame):
        nonlocal reason
        reason = 'authority_deadline' if signum == signal.SIGALRM else 'guard_stop_requested'
        if signum == signal.SIGALRM and time.monotonic() >= budget:
            reason = 'budget_exhausted'
        # A filesystem failure must still stop the command. Its durable initial
        # checkpoint and launch fence remain available for later reconciliation.
        try:
            checkpoint(reason)
        finally:
            if child is not None:
                signal_owned_group(child, signal.SIGKILL)

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGALRM):
        signal.signal(sig, stop_signal)
    try:
        if time.monotonic() >= until:
            raise RuntimeError('Authority expired before launch')
        checkpoint('before_launch')
        # Existence is the durable local no-relaunch fence, even if Popen fails.
        fd = os.open(directory / 'launch-started', os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.fsync(fd)
        os.close(fd)
        with store.open_output(config['job_id'], 'stdout') as out, store.open_output(config['job_id'], 'stderr') as err:
            stage = 'launching'
            argv, env = config['argv'], minimal_environment(config['env'])
            contract = config.get('continuation_contract', 'stop_before_transfer')
            if contract != 'stop_before_transfer':
                from .job_isolation import CONTRACT, launch_arguments
                if contract != CONTRACT:
                    raise ValueError('Unsupported command isolation contract')
                argv, env = launch_arguments(directory, argv, env)
            with store.locked():
                if daemon_stop_requested(directory, identity):
                    raise RuntimeError('Managed command stopped before launch')
                child = subprocess.Popen(argv, cwd=config['cwd'], env=env,
                                         stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                                         start_new_session=True, close_fds=True)
            signal.setitimer(signal.ITIMER_REAL, max(0.001, until - time.monotonic()))
            process_record = {
                **identity, 'process': process_identity(child.pid), 'group_id': child.pid,
                'guard': process_identity(os.getpid()), 'started_at': time.time(),
                'continuation_contract': contract,
            }
            atomic_json(directory / 'process.json', process_record)
            selector = selectors.DefaultSelector()
            stage = 'monitoring'
            selector.register(sys.stdin.fileno(), selectors.EVENT_READ)
            buffer = b''
            while reason is None and not child_exited(child.pid):
                now = time.monotonic()
                if daemon_stop_requested(directory, identity):
                    reason = ('budget_exhausted' if daemon_stop_reason(directory, identity) == 'transfer_budget_exhausted'
                              and transfers_used >= max_transfers else 'daemon_stop_requested')
                    break
                if now >= prepare and not prepared:
                    checkpoint('preparing_for_deadline')
                    prepared = True
                for key, _ in selector.select(min(0.1, max(0, until - now))):
                    data = os.read(key.fd, 65536)
                    if not data:
                        reason = 'supervisor_disconnected'
                        break
                    buffer += data
                    if len(buffer) > 65536:
                        raise ValueError('Invalid guard control')
                    while b'\n' in buffer:
                        line, buffer = buffer.split(b'\n', 1)
                        control = json.loads(line)
                        if control.get('probe'):
                            # Answer over the retained anonymous pipe, never a
                            # filesystem/PID-only claim. The child is unreaped.
                            proof = dict(process_record, challenge=control['probe'],
                                         live=not child_exited(child.pid))
                            sys.stdout.write(json.dumps(proof) + '\n')
                            sys.stdout.flush()
                            continue
                        if control.get('controller_run_id'):
                            if control['controller_run_id'] != identity.get('controller_run_id', identity['owner_run_id']):
                                prepared = False
                            identity['controller_run_id'] = control['controller_run_id']
                            transfers_used = max(transfers_used, control.get('transfers_used', transfers_used))
                        if control.get('stop'):
                            exhausted = ((control.get('reason') == 'budget_exhausted' and time.monotonic() >= budget)
                                         or (control.get('reason') == 'transfer_budget_exhausted'
                                             and transfers_used >= max_transfers))
                            reason = 'budget_exhausted' if exhausted else 'supervisor_stop_requested'
                            break
                        until, prepare = control['until'], control['prepare']
                        budget = min(budget, control.get('budget_until', budget))
                        signal.setitimer(signal.ITIMER_REAL, max(0.001, until - time.monotonic()))
            selector.close()
            stage = 'checkpointing_exit'
            checkpoint(reason or 'command_exited')
            # Kill remaining descendants too, while the unreaped group leader
            # pins its PID. Commands must not daemonize out of this process group.
            signal_owned_group(child, signal.SIGTERM)
            stage = 'stopping_group'
            grace = min(time.monotonic() + 1.0, until)
            while time.monotonic() < grace and group_live(child.pid) is True:
                time.sleep(0.05)
            signal_owned_group(child, signal.SIGKILL)
            verified = False
            for _ in range(20):
                if group_live(child.pid) is False:
                    verified = True
                    break
                time.sleep(0.05)
            signal.setitimer(signal.ITIMER_REAL, 0)
            blocked = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGINT, signal.SIGALRM})
            stage = 'reaping'
            try:
                code = child.wait(timeout=2)
                child = None  # Clear before any pending signal handler can run.
            finally:
                signal.pthread_sigmask(signal.SIG_SETMASK, blocked)
            signal.setitimer(signal.ITIMER_REAL, 0)
            for stream in (out, err):
                os.fsync(stream.fileno())
            stage = 'saving_result'
            atomic_json(directory / 'result.json', {
                **identity, 'exit_code': code, 'signal': -code if code < 0 else None,
                'reason': reason or 'command_exited', 'termination_verified': verified,
                'status': ('exhausted' if reason == 'budget_exhausted' else
                           ('interrupted' if reason else 'completed') if verified else 'unknown'),
                'finished_at': time.time(), 'stdout': 'stdout.log', 'stderr': 'stderr.log',
            })
    except BaseException as exc:
        diagnostic = {**identity, 'status': 'unknown', 'stage': stage,
                      'error_type': type(exc).__name__, 'errno': getattr(exc, 'errno', None)}
        atomic_json(directory / 'guard-error.json', diagnostic)
        try:
            checkpoint('guard_error')
        finally:
            if child is not None:
                signal_owned_group(child, signal.SIGKILL)
                signal.setitimer(signal.ITIMER_REAL, 0)
                blocked = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGINT, signal.SIGALRM})
                try:
                    child.wait(timeout=2)
                    child = None
                finally:
                    signal.pthread_sigmask(signal.SIG_SETMASK, blocked)
            atomic_json(directory / 'guard-error.json', diagnostic)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)


def main():
    try:
        config = json.loads(sys.stdin.buffer.readline(1024 * 1024))
        run(config)
    except BaseException:
        # Raw command arguments, environment and exception messages are private.
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
