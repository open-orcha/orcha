"""Bounded managed-job transport. Tokens and server error bodies never reach logs."""

from __future__ import annotations

import http.client
import json
import queue
import threading
import time
from datetime import datetime
from urllib.parse import urlsplit


class JobAPIError(RuntimeError):
    def __init__(self, status=None, *, lease_lapsed=False, code=None):
        self.status = status
        # Only public, fixed conflict names may cross the private IPC boundary.
        self.code = code if isinstance(code, str) and code in {
            'run_binding_pending', 'worker_lease_lapsed', 'managed_transfer_heartbeat_mismatch',
        } else None
        self.lease_lapsed = lease_lapsed or self.code == 'worker_lease_lapsed'
        self.retryable = self.code is not None
        self.rejected = status is not None and 400 <= status < 500
        self.fenced = self.rejected and not self.retryable
        super().__init__('Managed command authority refused' if self.fenced
                         else 'Managed command service unavailable; authority was not extended')


class JobAPI:
    def __init__(self, base, token, task_id, *, timeout=2.0):
        url = urlsplit(base)
        if url.scheme not in {'http', 'https'} or not url.hostname or url.username or url.password:
            raise ValueError('Invalid managed command service address')
        if not token:
            raise JobAPIError(403)
        self.url, self.token, self.task_id = url, token, task_id
        self.timeout = timeout
        self._inflight = threading.Lock()

    def request(self, suffix, body=None, *, method='POST', timeout=None):
        # A socket timeout alone does not bound a slowly streamed response. A
        # daemon thread gives the caller an absolute wall-time bound, with at
        # most one outstanding request per client, including after a timeout.
        duration = min(self.timeout, timeout) if timeout is not None else self.timeout
        if duration <= 0 or not self._inflight.acquire(blocking=False):
            raise JobAPIError()
        result = queue.Queue(maxsize=1)

        def send():
            connection = None
            value, error = None, None
            try:
                factory = http.client.HTTPSConnection if self.url.scheme == 'https' else http.client.HTTPConnection
                connection = factory(self.url.hostname, self.url.port, timeout=duration)
                path = self.url.path.rstrip('/') + f'/api/tasks/{self.task_id}/' + suffix
                connection.request(method, path, body=json.dumps(body or {}), headers={
                    'Content-Type': 'application/json', 'X-Orcha-Run-Token': self.token,
                })
                response = connection.getresponse()
                if response.status != 200:
                    code = None
                    if response.status == 409:
                        try:
                            error_body = json.loads(response.read(8192))
                            code = error_body.get('detail', {}).get('code')
                        except (ValueError, AttributeError):
                            pass
                    raise JobAPIError(response.status, code=code)
                data = response.read(1024 * 1024 + 1)
                if len(data) > 1024 * 1024:
                    raise JobAPIError()
                value = json.loads(data)
                if not isinstance(value, dict):
                    raise JobAPIError()
            except Exception as exc:
                error = exc if isinstance(exc, JobAPIError) else JobAPIError()
            finally:
                if connection:
                    connection.close()
                self._inflight.release()
                result.put((value, error))

        threading.Thread(target=send, daemon=True).start()
        try:
            value, error = result.get(timeout=duration)
        except queue.Empty:
            raise JobAPIError() from None
        if error:
            raise error
        return value

    def heartbeat(self, job_id, **kwargs):
        return self.request(f'managed-jobs/{job_id}/heartbeat', **kwargs)


def epoch(value):
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('An authoritative timestamp must include a timezone')
    return parsed.timestamp()


class AuthorityClock:
    """Convert server time conservatively; failed contact can never move a cap."""

    def __init__(self, run_id, job_id):
        self.run_id, self.job_id = run_id, job_id
        self.until = 0.0
        self.prepare = 0.0
        self.fixed = float('inf')
        self.budget = float('inf')
        self.mutations_allowed = False

    def confirm(self, response, sent_at):
        if (response['run_id'] != self.run_id or response['job_id'] != self.job_id
                or not response['token_valid'] or any(response[k] for k in
                    ('stop_requested', 'on_hold', 'cancelled'))):
            raise JobAPIError(409)
        server = epoch(response['server_time'])
        # Measuring from request START subtracts all round-trip latency and
        # remains safe across local wall-clock jumps. Fixed limits never slide.
        fixed = min(epoch(response[k]) for k in ('run_until', 'sandbox_until', 'budget_until')
                    if response.get(k))
        self.fixed = min(self.fixed, sent_at + fixed - server)
        self.budget = min(self.budget, sent_at + epoch(response['budget_until']) - server)
        self.until = min(self.fixed, sent_at + epoch(response['authority_until']) - server)
        self.prepare = min(self.until - 60, sent_at + epoch(response['prepare_at']) - server)
        self.mutations_allowed = bool(response['mutations_allowed']) and time.monotonic() < self.until
        return self
