"""Retained-supervisor handoff. Credentials travel only through private IPC.

A replacement cannot recreate this controller. The original guard answers on
its anonymous pipe while still owning an unreaped child. Transfer capabilities
are held only in memory; losing the controller always stops its command.
"""

import hashlib
import hmac
import json
import os
import secrets
import selectors
import socket
import tempfile
import time
from pathlib import Path
from uuid import uuid4

from .job_api import AuthorityClock, JobAPI, JobAPIError, epoch
from .job_store import JobStorageError, read_json


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def guard_proof(supervisor):
    guard = supervisor.guard
    if not guard or guard.poll() is not None:
        raise JobStorageError('Original command guard is unavailable')
    challenge = secrets.token_hex(16)
    supervisor.send({'probe': challenge})
    with selectors.DefaultSelector() as selector:
        selector.register(guard.stdout, selectors.EVENT_READ)
        if not selector.select(min(1, max(0, supervisor.clock.until - time.monotonic()))):
            raise JobStorageError('Original command guard did not confirm identity')
        line = guard.stdout.readline(16384)
    proof = json.loads(line)
    process = read_json(supervisor.directory / 'process.json')
    if (proof.pop('challenge', None) != challenge or not proof.pop('live', False)
            or proof != process or proof['guard']['pid'] != guard.pid
            or proof['continuation_contract'] != 'readonly_single_process_v1'
            or proof['launch_nonce'] != supervisor.record['launch_nonce']
            or not proof.get('process') or not proof.get('guard')):
        raise JobStorageError('Original isolated launch could not be verified')
    return digest(proof)


class PlannedTransfer:
    def __init__(self, supervisor):
        self.supervisor = supervisor
        self.capability = secrets.token_urlsafe(32)
        self.proof = guard_proof(supervisor)
        self.body = {'transfer_id': str(uuid4()), 'expected_version': supervisor.record['server_version'],
                     'launch_nonce': supervisor.record['launch_nonce'], 'proof_digest': self.proof,
                     'capability_digest': hashlib.sha256(self.capability.encode()).hexdigest()}
        self.api = JobAPI(supervisor.config['api_base'], self.capability, supervisor.record['task_id'])
        self.prepared = False
        self.adopting = None

    def prepare(self):
        s = self.supervisor
        response = s.api.request(f'managed-jobs/{s.job_id}/transfer/prepare', self.body)
        self.prepared = True
        s.clock.mutations_allowed = False
        s.update(transfer_id=response['transfer_id'], transfer_until=response['authority_until'],
                 launch_owner_run_id=s.record.get('launch_owner_run_id', s.record['owner_run_id']))
        self.confirm(time.monotonic())
        return {'transfer_id': response['transfer_id'], 'status': 'prepared'}

    def confirm(self, sent):
        s = self.supervisor
        if self.adopting:
            self.adopt(self.adopting['token'])
            return
        if not self.prepared:
            raise JobAPIError()  # An uncertain prepare freezes locally until retry.
        response = self.api.request(f'managed-jobs/{s.job_id}/transfer/heartbeat')
        if (response['source_run_id'] != s.record['owner_run_id']
                or response['transfer_id'] != self.body['transfer_id'] or response['job_id'] != s.job_id):
            raise JobAPIError(409, code='managed_transfer_heartbeat_mismatch')
        s.clock.until = min(s.clock.until, sent + epoch(response['authority_until']) - epoch(response['server_time']))
        s.clock.mutations_allowed = False

    def adopt(self, token):
        s = self.supervisor
        if not self.prepared:
            raise JobStorageError('Planned transfer is no longer available')
        if not self.adopting:
            if time.monotonic() >= s.clock.until or guard_proof(s) != self.proof:
                raise JobStorageError('Retained command identity changed or authority expired')
        api = JobAPI(s.config['api_base'], token, s.record['task_id'])
        # The same request is reused after a lost reply; another candidate may
        # not replace a locally uncertain adoption and extend authority.
        if self.adopting and not hmac.compare_digest(self.adopting['token'], token):
            raise JobStorageError('An earlier adoption needs reconciliation')
        if not self.adopting:
            self.adopting = {'token': token, 'uncertain': False, 'body': {
                'transfer_id': self.body['transfer_id'], 'operation_id': str(uuid4()),
                'expected_version': s.record['server_version'], 'launch_nonce': s.record['launch_nonce'],
                'proof_digest': self.proof, 'capability': self.capability}}
        try:
            job = api.request(f'managed-jobs/{s.job_id}/transfer/adopt', self.adopting['body'])
        except JobAPIError as exc:
            if not exc.rejected:
                self.adopting['uncertain'] = True
            elif not self.adopting['uncertain']:
                # Only a refusal before ANY ambiguous attempt proves ownership
                # stayed with the source. Later refusals cannot undo a commit.
                self.adopting = None
            raise
        old_clock = s.clock
        # Preserve the server's ownership receipt even if contact fails before
        # confirming the new deadline, or the command completes in this gap.
        s.update(owner_run_id=job['owner_run_id'], server_version=job['version'],
                 workflow_generation=job['workflow_generation'], transfers_used=job['transfers_used'],
                 transfer_id=None, transfer_until=None)
        s.api, s.transfer = api, None
        clock = AuthorityClock(job['owner_run_id'], s.job_id)
        clock.until, clock.budget = old_clock.until, old_clock.budget
        s.clock = clock
        sent = time.monotonic()
        clock.confirm(api.heartbeat(s.job_id), sent)
        # Transfer consumes a new run cap, NEVER a new absolute command budget.
        clock.budget = min(clock.budget, old_clock.budget)
        clock.until = min(clock.until, clock.budget)
        s.send({'controller_run_id': job['owner_run_id'], 'transfers_used': job['transfers_used'], 'until': clock.until,
                'prepare': clock.prepare, 'budget_until': clock.budget})
        return {'status': 'adopted', 'job_id': s.job_id, 'owner_run_id': job['owner_run_id'],
                'transfers_used': job['transfers_used']}


class TransferChannel:
    def __init__(self, supervisor):
        self.supervisor = supervisor
        # macOS Unix socket paths cannot fit a typical task worktree path.
        self.directory = tempfile.TemporaryDirectory(prefix='orcha-transfer-')
        self.path = str(Path(self.directory.name) / 'control')
        self.socket = socket.socket(socket.AF_UNIX)
        self.socket.bind(self.path)
        os.chmod(self.path, 0o600)
        self.socket.listen(4)
        self.socket.setblocking(False)
        supervisor.update(transfer_socket=self.path)

    def poll(self):
        try:
            connection, _ = self.socket.accept()
        except BlockingIOError:
            return
        with connection:
            connection.settimeout(0.1)
            try:
                data = b''
                while b'\n' not in data and len(data) <= 8192:
                    block = connection.recv(8192)
                    if not block:
                        raise ValueError('Incomplete command')
                    data += block
                request = json.loads(data)
                s = self.supervisor
                if request.get('launch_nonce') != s.record['launch_nonce']:
                    raise ValueError('Launch changed')
                if request['action'] == 'prepare' and hmac.compare_digest(request['token'], s.api.token):
                    if not s.transfer:
                        s.confirm()
                        if time.monotonic() >= s.clock.until:
                            raise JobAPIError(409)
                        # Another command may already have frozen this run.
                        # Read-only supervision remains valid, and the prepare
                        # endpoint alone admits the remaining job reservations.
                        if s.clock.mutations_allowed:
                            s.publish_pending()
                        elif (s.directory / 'publication.json').exists():
                            raise JobStorageError('Pending command publication needs reconciliation')
                        s.checkpoint('planned_transfer')
                        s.transfer = PlannedTransfer(s)
                    response = s.transfer.prepare()
                elif request['action'] == 'adopt' and s.transfer:
                    response = s.transfer.adopt(request['token'])
                elif request['action'] == 'adopt' and hmac.compare_digest(request['token'], s.api.token):
                    if not s.confirm():
                        raise JobAPIError(409)
                    response = {'status': 'adopted', 'job_id': s.job_id, 'owner_run_id': s.record['owner_run_id'],
                                'transfers_used': s.record['transfers_used']}
                else:
                    raise ValueError('Transfer unavailable')
            except JobAPIError as exc:
                response = {'status': 'refused', 'retryable': exc.retryable}
                if exc.code:
                    response['code'] = exc.code
            except (OSError, ValueError, KeyError, JobStorageError):
                response = {'status': 'refused'}  # No raw errors, tokens or argv.
            try:
                connection.sendall(json.dumps(response).encode() + b'\n')
            except OSError:
                pass  # The exact retry returns the already prepared/adopted state.

    def close(self):
        self.socket.close()
        self.directory.cleanup()


def transfer_command(store, jid, action, token):
    record = store.read(jid)
    if not record.get('transfer_socket'):
        raise JobStorageError('Retained command controller is unavailable')
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(8)
        connection.connect(record['transfer_socket'])
        connection.sendall(json.dumps({'action': action, 'token': token,
                                      'launch_nonce': record['launch_nonce']}).encode() + b'\n')
        data = b''
        while b'\n' not in data and len(data) <= 8192:
            block = connection.recv(8192)
            if not block:
                raise JobStorageError('Retained command controller disconnected')
            data += block
        response = json.loads(data)
        if response.get('status') not in {'prepared', 'adopted'}:
            if response.get('retryable') and response.get('code'):
                raise JobAPIError(409, code=response['code'])
            raise JobStorageError('Command transfer refused; inspect original evidence')
        return response
