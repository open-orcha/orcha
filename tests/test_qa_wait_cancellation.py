"""Cancellation during real device-queue waits must stop the tool, not just its row."""

import asyncio

import pytest
from fastapi.testclient import TestClient

import main
from orcha_cli.qa.device import locks
from orcha_cli.qa.device.base import DeviceBusy
from orcha_cli.qa.mcp_server import DEVICE_BUSY, QATools
from test_qa_mcp import Clock
from test_qa_mcp_portal import AppPortal, FakeDevice, Ident, jshot
from test_qa_run_tasks import team, inline, task, hand, session, finish  # noqa: F401


@pytest.mark.parametrize('origin,through', [('continue', 'request'), ('continue', 'task'), ('again', 'task')])
@pytest.mark.parametrize('moment', ['waiting_busy', 'waiting_freed', 'opening', 'metadata'])
async def test_cancel_during_device_start_releases_queue_and_preserves_result(
        team, db, tmp_path, monkeypatch, origin, through, moment):
    monkeypatch.setattr(main, 'ATTACHMENTS_DIR', tmp_path / 'attachments')
    monkeypatch.setattr(locks, 'LOCK_ROOT', tmp_path)
    locks.leave_line()
    if origin == 'continue':
        out = await hand(team, await task(team), platform='ios', kind='check', minutes=20)
        old = await session(team, request_id=out['request']['id'], kind='check', platform='ios')
        response = await team['client'].patch(f"/api/qa/sessions/{old['id']}", json={
            'actor_agent_id': team['qa'], 'status': 'done',
            'result': {'budget': {'minutes': 20, 'used_s': 1201, 'left_s': 0}}})
        assert response.status_code == 200, response.text
        body = {'actor_agent_id': team['human'], 'minutes': 0}
    else:
        old = await session(team, task_id=await task(team, assignee='QAEngineer'), kind='check', platform='ios')
        await finish(team, old)
        body = {'actor_agent_id': team['human']}
    response = await team['client'].post(f"/api/qa/sessions/{old['id']}/{origin}", json=body)
    assert response.status_code == 201, response.text
    queued = response.json()
    sid, tid = queued['id'], queued['task_id']
    path = (f"/api/qa/requests/{out['request']['id']}/cancel" if through == 'request'
            else f'/api/tasks/{tid}/cancel')
    before = db.execute('SELECT * FROM qa_sessions WHERE id=%s', (old['id'],))[0]
    device_name = 'Cancellation test phone'
    lock_path = locks.lock_path(device_name)
    if moment.startswith('waiting'):
        lock_path.mkdir()  # Another tool's real device lock; no simulator is driven.
    held, opened, cancelled = [], [], []
    clock = Clock()

    class Device(FakeDevice):
        async def appearance_setting(self):
            if moment == 'metadata' and not cancelled:
                cancel()
            return 'light'

        async def end(self):
            for lock in held:
                lock.release()
            return await super().end()

    dev = Device([jshot('home', ('Heading', 'Checkout'))], device_name=device_name)
    with TestClient(main.app) as client:
        portal = AppPortal(client, team['cid'], team['qa'])

        def cancel():
            response = client.post(path, json={'actor_agent_id': team['human'], 'reason': 'Stop this run'})
            assert response.status_code == 200, response.text
            cancelled.append(db.execute('SELECT * FROM qa_sessions WHERE id=%s', (sid,))[0])

        async def sleep(seconds):
            clock.t += seconds
            if not cancelled:
                assert qa.queued and qa.queued['id'] == sid
                assert list((tmp_path / locks.QUEUE_DIR).glob('*.json'))
                cancel()
                if moment == 'waiting_freed':
                    lock_path.rmdir()
            await asyncio.sleep(0)

        async def open_device(*args, **kwargs):
            lock = locks.claim(device_name)
            if lock is None:
                raise DeviceBusy(DEVICE_BUSY, [device_name])
            held.append(lock)
            opened.append(dev)
            if moment == 'opening':
                cancel()
            return dev

        qa = QATools(identity=Ident(team['cid'], team['qa']), portal=portal,
                     device_opener=open_device, clock=clock, sleep=sleep)
        try:
            response = await qa.start_session(platform='ios', kind='check', task_id=tid,
                                              app='com.example.checkout', device=device_name)
            assert cancelled, 'The cancellation route must run before the assertion.'
            assert response.startswith('error:') and any(word in response.lower() for word in ('cancel', 'stopped')), response
            assert qa.live is None and qa.queued is None
            assert not list((tmp_path / locks.QUEUE_DIR).glob('*.json'))
            assert db.execute('SELECT * FROM qa_sessions WHERE id=%s', (sid,))[0] == cancelled[0]
            assert db.execute('SELECT * FROM qa_sessions WHERE id=%s', (old['id'],))[0] == before
            if moment in ('opening', 'metadata'):
                assert opened and dev.ended and not lock_path.exists()
            else:
                assert not opened
                assert lock_path.exists() == (moment == 'waiting_busy')
        finally:
            await qa.shutdown()
            await dev.end()
            locks.leave_line()
            locks.set_holder()
