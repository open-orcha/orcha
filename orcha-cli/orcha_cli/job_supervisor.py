"""Independent, finite-authority supervision for one durable command reservation."""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import signal
import subprocess
import sys
import time
from uuid import uuid4

from .job_api import AuthorityClock, JobAPI, JobAPIError
from .job_evidence import context_snapshot, daemon_stop_requested
from .job_executor import minimal_environment
from .job_identity import process_identity
from .job_store import JobStore, atomic_json, read_json, _open_private


def file_digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def module_environment():
    env = minimal_environment(os.environ)
    # Use this installed/source package, never a worker-controlled PYTHONPATH.
    from pathlib import Path
    env['PYTHONPATH'] = str(Path(__file__).resolve().parent.parent)
    return env


class Supervisor:
    def __init__(self, config):
        self.config = config
        self.store = JobStore(config['base_cwd'])
        self.job_id = config['job_id']
        self.directory = self.store.job_directory(self.job_id)
        self.record = self.store.read(self.job_id)
        if self.record['launch_nonce'] != config['launch_nonce']:
            raise ValueError('Managed command reservation changed')
        self.api = JobAPI(config['api_base'], config['token'], self.record['task_id'])
        self.clock = AuthorityClock(self.record['owner_run_id'], self.job_id)
        self.guard = None
        self.stopping = False

    def update(self, **changes):
        self.record = self.store.update(self.job_id, self.record['version'], changes)

    def confirm(self):
        sent = time.monotonic()
        self.clock.confirm(self.api.heartbeat(self.job_id), sent)
        return self.clock.mutations_allowed

    def checkpoint(self, reason, state=None, result=None):
        evidence = {**context_snapshot(self.directory), 'reason': reason, 'owner_run_id': self.record['owner_run_id'],
                    'launch_nonce': self.record['launch_nonce'],
                    'status': state or self.record['status'],
                    'process_record': 'process.json', 'guidance_record': 'guidance.json',
                    'worker_context': 'context.json', 'mechanical_record': 'mechanical.json',
                    'result_record': 'result.json' if result else None,
                    'authority_until_monotonic': self.clock.until,
                    'prepare_at_monotonic': self.clock.prepare}
        self.record = self.store.checkpoint(self.job_id, self.record['version'], evidence)
        if not self.clock.mutations_allowed:
            return
        pending = self.directory / 'publication.json'
        if pending.exists():
            self.publish_pending()
        # Save the exact CAS body before sending it. A lost response is retried
        # under the same operation ID; it never consumes another version.
        body = {'operation_id': str(uuid4()), 'expected_version': self.record['server_version'],
                'state': state or self.record['status'], 'checkpoint_version': evidence_version(self.record),
                'checkpoint_digest': file_digest(self.directory / f"checkpoint-{evidence_version(self.record)}.json"),
                'result_digest': file_digest(self.directory / 'result.json') if result else None,
                'termination_verified': bool(result and result['termination_verified'])}
        atomic_json(pending, body)
        self.publish_pending()

    def publish_pending(self):
        path = self.directory / 'publication.json'
        if not path.exists():
            return
        body = read_json(path)
        response = self.api.request(f'managed-jobs/{self.job_id}/checkpoint', body)
        self.update(server_version=response['version'])
        path.unlink()

    def launch(self):
        if not self.confirm() or self.record['server_version'] != 0:
            raise JobAPIError(409)
        # A server CAS plus a flushed local launch fence precedes Popen. If
        # either outcome is uncertain, no worker may silently try a new launch.
        self.checkpoint('launch_reserved', state='reserved')
        if not self.confirm():
            raise JobAPIError(409)
        self.update(supervisor=process_identity(os.getpid()), status='reserved')
        self.guard = subprocess.Popen([sys.executable, '-m', 'orcha_cli.job_executor'],
                                      stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                      stderr=subprocess.DEVNULL, env=module_environment(),
                                      start_new_session=True, close_fds=True)
        packet = {k: self.config[k] for k in ('base_cwd', 'job_id', 'launch_nonce', 'argv', 'env', 'cwd')}
        packet.update(owner_run_id=self.record['owner_run_id'], until=self.clock.until,
                      prepare=self.clock.prepare, budget_until=self.clock.budget)
        self.guard.stdin.write(json.dumps(packet).encode() + b'\n')
        self.guard.stdin.flush()
        # Wait for guard startup before sending another packet; the guard's
        # initial buffered line read must not prefetch a later control packet.
        ready_until = min(time.monotonic() + 5, self.clock.until)
        while time.monotonic() < ready_until:
            if (self.directory / 'process.json').exists() or (self.directory / 'result.json').exists():
                self.update(status='running')
                try:
                    self.checkpoint('command_started', state='running')
                except JobAPIError as exc:
                    self.reconcile_contact_error(exc)
                return
            if self.guard.poll() is not None:
                break
            time.sleep(0.02)
        raise RuntimeError('Managed command launch needs reconciliation')

    def reconcile_contact_error(self, exc):
        self.clock.mutations_allowed = False
        if exc.lease_lapsed:
            try:
                self.confirm()  # A lease lapse alone does not revoke supervision.
                self.send({'until': self.clock.until, 'prepare': self.clock.prepare,
                           'budget_until': self.clock.budget})
            except JobAPIError as confirmation:
                if confirmation.fenced:
                    self.stopping = True
        elif exc.fenced:
            self.stopping = True

    def send(self, packet):
        if self.guard and self.guard.poll() is None:
            try:
                self.guard.stdin.write(json.dumps(packet).encode() + b'\n')
                self.guard.stdin.flush()
            except (OSError, ValueError):
                self.stopping = True

    def controls(self):
        for path in sorted(self.directory.glob('control-*.json')):
            control = read_json(path)
            if (control.get('owner_run_id') != self.record['owner_run_id']
                    or control.get('launch_nonce') != self.record['launch_nonce']):
                path.unlink()
                continue
            # Revalidate after receiving each queued request. A prior successful
            # client heartbeat is not authority for a later supervisor action.
            if not self.confirm():
                return
            if control['action'] == 'stop':
                self.checkpoint('worker_stop_requested')
                self.stopping = True
            elif control['action'] == 'checkpoint':
                self.checkpoint('worker_checkpoint')
            path.unlink()

    def finish(self, result):
        if (result['launch_nonce'] != self.record['launch_nonce']
                or result['owner_run_id'] != self.record['owner_run_id']):
            raise ValueError('Saved result belongs to another launch')
        self.update(status=result['status'], result_saved=True,
                    termination_verified=result['termination_verified'], result='result.json')
        try:
            self.checkpoint('result_saved', state=result['status'], result=result)
        except JobAPIError:
            # Local terminal evidence remains immutable and available even when
            # ownership was revoked before authoritative publication.
            pass

    def run(self):
        lock = _open_private(self.directory / 'supervisor.lock', os.O_RDWR | os.O_CREAT)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(lock)
            return
        def stop(signum, frame):
            self.stopping = True
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        try:
            self.launch()
            next_contact = 0.0
            prepared = False
            while self.guard.poll() is None:
                now = time.monotonic()
                if daemon_stop_requested(self.directory, self.record):
                    self.stopping = True
                if self.stopping or now >= self.clock.until:
                    try:
                        self.clock.mutations_allowed = False
                        self.checkpoint('stopping')
                    finally:
                        self.send({'stop': True, 'reason': 'budget_exhausted'
                                   if time.monotonic() >= self.clock.budget else 'supervisor_stop_requested'})
                        self.guard.stdin.close()
                    break
                if now >= next_contact:
                    try:
                        self.confirm()
                        self.send({'until': self.clock.until, 'prepare': self.clock.prepare,
                                   'budget_until': self.clock.budget})
                        if self.clock.mutations_allowed:
                            self.publish_pending()
                            self.controls()
                            if not prepared and now >= self.clock.prepare:
                                self.checkpoint('preparing_for_deadline')
                                prepared = True
                    except JobAPIError as exc:
                        self.reconcile_contact_error(exc)
                    next_contact = time.monotonic() + 2
                time.sleep(0.05)
            self.guard.wait(timeout=5)
            path = self.directory / 'result.json'
            if path.exists():
                self.finish(read_json(path))
            else:
                self.update(status='unknown')
                self.clock.mutations_allowed = False
                self.checkpoint('result_unavailable')
        except BaseException:
            self.clock.mutations_allowed = False
            try:
                self.checkpoint('supervisor_error')
            finally:
                if self.guard:
                    if not self.guard.stdin.closed:
                        self.guard.stdin.close()  # Guard checkpoints, then stops on EOF.
                    try:
                        self.guard.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        pass  # Do not signal a recorded/reused process ID.
                self.update(status='unknown')
        finally:
            os.close(lock)


def evidence_version(record):
    # checkpoint() may publish an older pending operation, advancing the local
    # record version. Its saved pointer still identifies the evidence to hash.
    from pathlib import Path
    return int(Path(record['checkpoint']).stem.split('-')[1])


def main():
    try:
        config = json.loads(sys.stdin.buffer.readline(1024 * 1024))
        sys.stdin.close()
        Supervisor(config).run()
    except BaseException:
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
