"""Stopped-checkout snapshots keep their original lifecycle owner until durable."""

import asyncio
import io
import time
from types import SimpleNamespace

import pytest

from orcha_cli import notifier
from orcha_cli import notifier_resident_claude_start as resident_start
from orcha_cli import notifier_resident_idle as resident_idle
from orcha_cli import notifier_resident_lifecycle as resident_lifecycle
from orcha_cli import notifier_resident_live as resident_live
from orcha_cli import terminal_bridge as bridge
from orcha_cli import terminal_bridge_warm as bridge_warm


def _snapshot(ok, code="ok"):
    return SimpleNamespace(ok=ok, code=code)


def _warm_session():
    return bridge._WarmSession(
        "agent-1",
        "Reviewer",
        "http://orcha.test",
        "/project",
        4321,
        7,
        None,
        None,
        "run-1",
        {"chunks": ["saved output"], "len": 12},
        run_token="token-1",
        worktrees_disabled=True,
    )


@pytest.fixture(autouse=True)
def _clear_warm_sessions():
    bridge._WARM_SESSIONS.clear()
    yield
    for session in list(bridge._WARM_SESSIONS.values()):
        session.cancel_expiry()
    bridge._WARM_SESSIONS.clear()


def _wire_warm_retirement(monkeypatch, snapshots):
    calls = {"killed": [], "released": [], "finished": [], "revoked": [], "teardown": []}
    monkeypatch.setattr(
        bridge_warm,
        "record_stopped_checkout_snapshot",
        lambda *args, **kwargs: snapshots.pop(0),
    )
    monkeypatch.setattr(
        bridge,
        "terminate_pty",
        lambda pid, fd: calls["killed"].append((pid, fd)),
    )
    monkeypatch.setattr(
        bridge,
        "release_live_lease",
        lambda api, aid: calls["released"].append(aid),
    )
    monkeypatch.setattr(
        bridge,
        "finish_live_run",
        lambda api, run_id, *args, **kwargs: calls["finished"].append(run_id),
    )
    monkeypatch.setattr(
        bridge,
        "revoke_live_token",
        lambda api, token: calls["revoked"].append(token),
    )
    monkeypatch.setattr(
        bridge,
        "safe_teardown_worktree",
        lambda *args: calls["teardown"].append(args) or "removed",
    )
    return calls


@pytest.mark.asyncio
async def test_warm_expiry_retains_snapshot_owner_and_retries(monkeypatch):
    calls = _wire_warm_retirement(
        monkeypatch,
        [_snapshot(False, "snapshot_live_state_unverified"), _snapshot(True)],
    )
    monkeypatch.setattr(bridge, "LIVE_GRACE_SECS", 0)
    monkeypatch.setattr(bridge, "LIVE_RENEW_SECS", 3600)
    session = _warm_session()
    bridge._WARM_SESSIONS[session.aid] = session

    await bridge._expire_warm(session, quiet=True)

    assert bridge._WARM_SESSIONS[session.aid] is session
    assert session.snapshot_retry_pending == "snapshot_live_state_unverified"
    assert calls["released"] == calls["finished"] == calls["revoked"] == []

    assert bridge._retire_warm(session, quiet=True) == "removed"
    assert session.aid not in bridge._WARM_SESSIONS
    assert calls["killed"] == [(4321, 7)]
    assert calls["released"] == [session.aid]
    assert calls["finished"] == [session.run_id]
    assert calls["revoked"] == [session.run_token]
    await asyncio.sleep(0)


def test_warm_routing_toggle_retry_never_tears_down_old_checkout(monkeypatch):
    calls = _wire_warm_retirement(
        monkeypatch,
        [_snapshot(False, "snapshot_checkout_still_shared"), _snapshot(True)],
    )
    session = _warm_session()
    session.worktree = "/project/.orcha-worktrees/live-reviewer"

    first = bridge._retire_warm(
        session, quiet=True, teardown_worktree=False
    )
    second = bridge._retire_warm(session, quiet=True)

    assert first == "snapshot-pending:snapshot_checkout_still_shared"
    assert second == "preserved-routing-change"
    assert calls["teardown"] == []
    assert calls["released"] == [session.aid]


def test_bridge_shutdown_keeps_failed_snapshot_registered(monkeypatch):
    calls = _wire_warm_retirement(
        monkeypatch,
        [_snapshot(False, "snapshot_live_state_unverified"), _snapshot(True)],
    )
    session = _warm_session()
    bridge._WARM_SESSIONS[session.aid] = session

    bridge._retire_all_warm()
    assert bridge._WARM_SESSIONS[session.aid] is session
    assert calls["released"] == []

    bridge._retire_all_warm()
    assert bridge._WARM_SESSIONS == {}
    assert calls["released"] == [session.aid]


class _Process:
    def __init__(self):
        self.pid = 9876
        self.returncode = None
        self.stdin = io.BytesIO()

    def poll(self):
        return self.returncode


def test_close_resident_retries_without_finish_release_or_teardown(monkeypatch):
    snapshots = [
        _snapshot(False, "snapshot_checkout_still_shared"),
        _snapshot(True),
    ]
    monkeypatch.setattr(
        resident_lifecycle,
        "record_stopped_checkout_snapshot",
        lambda *args, **kwargs: snapshots.pop(0),
    )
    calls = {"kill": 0, "finish": 0, "ack": 0, "teardown": 0}
    monkeypatch.setattr(
        notifier,
        "_kill_worker",
        lambda process, graceful=True: calls.__setitem__("kill", calls["kill"] + 1),
    )
    monkeypatch.setattr(notifier, "_capture_diff", lambda *args: "diff")
    monkeypatch.setattr(
        notifier,
        "_finish_run",
        lambda *args, **kwargs: calls.__setitem__("finish", calls["finish"] + 1) or True,
    )
    monkeypatch.setattr(notifier, "_reap_sandbox_artifacts", lambda *args: None)
    monkeypatch.setattr(
        notifier,
        "_safe_teardown_worktree",
        lambda *args: calls.__setitem__("teardown", calls["teardown"] + 1),
    )
    monkeypatch.setattr(
        notifier,
        "_post_json",
        lambda url, body: calls.__setitem__(
            "ack", calls["ack"] + int(url.endswith("/wake-ack"))
        ) or {},
    )
    resident = {
        "proc": _Process(),
        "agent_id": "agent-1",
        "current_run_id": "run-1",
        "run_id": "run-1",
        "base_cwd": "/project",
        "worktree": None,
        "branch": None,
        "log_path": None,
    }

    assert notifier._close_resident(
        "http://orcha.test",
        resident,
        reason="worktree_routing_changed",
        teardown_worktree=False,
        stamp_woken=False,
    ) is False
    assert resident["current_run_id"] == "run-1"
    assert resident["snapshot_retry_close"] == {
        "reason": "worktree_routing_changed",
        "teardown_worktree": False,
        "stamp_woken": False,
    }
    assert calls == {"kill": 1, "finish": 0, "ack": 0, "teardown": 0}

    retired = []
    live = {"conversation-1": resident}
    monkeypatch.setattr(
        notifier,
        "_retire_resident",
        lambda api, residents, conv_id: retired.append(conv_id)
        or residents.pop(conv_id),
    )

    # The next lifecycle tick recognizes the retained close context, retries it
    # before any other transition, and retires only after the snapshot succeeds.
    resident_live.advance_live_resident(
        notifier,
        "http://orcha.test",
        "conversation-1",
        resident,
        None,
        set(),
        live,
        quiet=True,
        dry_run=False,
    )

    assert calls == {"kill": 1, "finish": 1, "ack": 1, "teardown": 0}
    assert retired == ["conversation-1"]
    assert live == {}


def _resident_services(close_result=False, *, renew=None):
    retired = []
    services = SimpleNamespace(
        RUNTIME_CLAUDE="claude",
        RUNTIME_CODEX="codex",
        WAKE_LEASE_TTL_SECS=60,
        HARD_CAP_MIN_SECS=900,
        RESIDENT_IDLE_REAP_SECS=30,
        RESIDENT_WORK_TEARDOWN_ENABLED=False,
        _RESIDENT_RESUME_FAILED=set(),
        _RESIDENT_DRAIN_YIELD={"conversation-1": (1, 1)},
        _PERSONA_CACHE={"agent-1": "persona"},
        _normalize_runtime=lambda value: value or "claude",
        _resident_runtime=lambda resident: resident.get("runtime", "claude"),
        _close_resident=lambda *args, **kwargs: close_result,
        _retire_resident=lambda api, live, conv: retired.append(conv) or live.pop(conv, None),
        _post_json=lambda *args, **kwargs: renew or {"renewed": True},
        _resident_idle=resident_idle,
        _resident_codex=SimpleNamespace(advance_codex_resident=lambda *args, **kwargs: None),
    )
    return services, retired


@pytest.mark.parametrize(
    ("candidate", "active_ids", "resident_overrides", "renew"),
    [
        ({"model_runtime": "codex"}, {"conversation-1"}, {}, None),
        ({"model_runtime": "claude", "model": "new"}, {"conversation-1"}, {"model": "old"}, None),
        (None, set(), {}, None),
        (
            {"model_runtime": "claude", "pending_human": False},
            {"conversation-1"},
            {},
            {"renewed": True, "preempt_requested": True},
        ),
    ],
    ids=["runtime", "model", "conversation-ended", "preempt"],
)
def test_resident_close_callers_do_not_retire_failed_snapshot(
    candidate, active_ids, resident_overrides, renew
):
    services, retired = _resident_services(False, renew=renew)
    process = _Process()
    resident = {
        "proc": process,
        "agent_id": "agent-1",
        "runtime": "claude",
        "awaiting_result": False,
        "serviced_seq": 0,
        "last_activity_ts": time.time(),
        **resident_overrides,
    }
    live = {"conversation-1": resident}

    resident_live.advance_live_resident(
        services,
        "http://orcha.test",
        "conversation-1",
        resident,
        candidate,
        active_ids,
        live,
        quiet=True,
        dry_run=False,
    )

    assert live["conversation-1"] is resident
    assert retired == []
    assert services._RESIDENT_RESUME_FAILED == set()


def test_idle_resident_does_not_retire_failed_snapshot():
    services, retired = _resident_services(False)
    resident = {
        "proc": _Process(),
        "agent_id": "agent-1",
        "awaiting_result": False,
        "last_activity_ts": time.time() - 100,
    }
    live = {"conversation-1": resident}

    resident_idle.service_idle_resident(
        "http://orcha.test",
        "conversation-1",
        resident,
        {"pending_inbox": 0},
        live,
        {"renewed": True},
        False,
        quiet=True,
        services=services,
    )

    assert live["conversation-1"] is resident
    assert retired == []


def test_resident_routing_toggle_keeps_retry_owner_and_does_not_boot():
    closed = []
    services = SimpleNamespace(
        RUNTIME_CLAUDE="claude",
        _close_resident=lambda *args, **kwargs: closed.append(kwargs) or False,
        _resident_runtime=lambda resident: "claude",
    )
    resident = {
        "agent_id": "agent-1",
        "worktrees_disabled": False,
        "awaiting_result": False,
        "serviced_seq": 0,
    }
    live = {"conversation-1": resident}

    resident_start.start_or_feed_candidate(
        services,
        "http://orcha.test",
        "conversation-1",
        {
            "agent_id": "agent-1",
            "worktrees_disabled": True,
            "last_turn_seq": 1,
        },
        live,
        frozenset(),
        base_cwd="/project",
        quiet=True,
        dry_run=False,
    )

    assert live["conversation-1"] is resident
    assert closed == [{
        "reason": "worktree_routing_changed",
        "teardown_worktree": False,
        "stamp_woken": False,
    }]
