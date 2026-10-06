"""Notifier hooks: automatic expired-request escalation (EX-01) and the one-shot
budget-paused skip line (B27).

EX-01: expiry was display-only — nothing but the hand-run /orcha-sweep skill called
POST /api/containers/{cid}/sweep, so an ask that expired on an AI agent stayed there.
The notifier tick now pokes the sweep (throttled, headerless daemon lane).

B27: the daemon printed "[notifier] skip <alias> — Monthly budget reached …" on EVERY
scan (26 lines in 40s at --interval 2). It now prints once per (agent, reason) and
re-arms when the pause lifts.

Run: ORCHA_TEST_DB_NAME=orcha_test_fq_cli_notifier_hooks pytest tests/test_notifier_sweep_and_budget_log.py
"""
import time

import pytest
from fastapi.testclient import TestClient

import main
from orcha_cli import notifier_request_sweep as sweep
from orcha_cli import notifier_wake_candidate as nwc


# ---- EX-01: unit ---------------------------------------------------------------------

class _Svc:
    def __init__(self, members, fail_post=False):
        self.members = members
        self.fail_post = fail_post
        self.gets, self.posts = [], []

    def _get_json(self, url, timeout=8.0):
        self.gets.append(url)
        return {"members": self.members}

    def _post_json(self, url, body, timeout=8.0):
        self.posts.append(url)
        if self.fail_post:
            raise RuntimeError("boom")
        return {"escalated_count": 1, "request_ids": ["abcdef0123"]}


@pytest.fixture
def clock(monkeypatch):
    sweep._LAST_SWEEP.clear()
    now = [1000.0]
    monkeypatch.setattr(sweep, "_monotonic", lambda: now[0])
    yield now
    sweep._LAST_SWEEP.clear()


def test_sweep_is_throttled_prefers_owner_and_never_raises(clock, capsys):
    members = [
        {"agent_id": "v1", "member_role": "viewer", "pending": False},
        {"agent_id": "p1", "member_role": "owner", "pending": True},
        {"agent_id": "o1", "member_role": "owner", "pending": False},
    ]
    svc = _Svc(members)
    sweep.maybe_sweep_expired("http://api", "cid-1", svc)
    assert svc.posts == ["http://api/api/containers/cid-1/sweep?actor_agent_id=o1"]
    assert "escalated 1 expired request" in capsys.readouterr().out
    sweep.maybe_sweep_expired("http://api", "cid-1", svc)  # throttled
    assert len(svc.posts) == 1
    clock[0] += sweep.SWEEP_EVERY_SECS + 1
    svc.fail_post = True
    assert sweep.maybe_sweep_expired("http://api", "cid-1", svc, quiet=True) is None  # swallowed
    assert len(svc.posts) == 2
    clock[0] += sweep.SWEEP_EVERY_SECS + 1
    sweep.maybe_sweep_expired("http://api", "cid-1", svc, dry_run=True)
    assert len(svc.posts) == 2  # dry-run never sweeps


def test_sweep_falls_back_to_any_member_and_skips_empty(clock):
    svc = _Svc([{"agent_id": "m1", "member_role": "member", "pending": False}])
    sweep.maybe_sweep_expired("http://api", "cid-2", svc, quiet=True)
    assert svc.posts == ["http://api/api/containers/cid-2/sweep?actor_agent_id=m1"]
    empty = _Svc([])
    assert sweep.maybe_sweep_expired("http://api", "cid-3", empty, quiet=True) is None
    assert empty.posts == []


def test_notifier_loop_wires_the_sweep():
    """Both the --once path and the daemon loop call the sweep hook."""
    import inspect
    from orcha_cli import notifier_command
    src = inspect.getsource(notifier_command.cmd_notifier)
    assert src.count("_request_sweep.maybe_sweep_expired(") == 2


# ---- EX-01: integration against the real sweep route ----------------------------------

def test_expired_ai_held_ask_escalates_via_notifier_hook(clock, db):
    tc = TestClient(main.app)
    r = tc.post("/api/containers", json={"name": "sweep-arena"})
    assert r.status_code == 201, r.text
    cid = r.json()["container_id"]

    def mk(alias, kind):
        body = {"alias": alias, "role": "worker", "kind": kind}
        if kind == "ai":
            body["prompt"] = "You are a test agent."
        resp = tc.post(f"/api/containers/{cid}/agents", json=body)
        assert resp.status_code in (200, 201), resp.text
        return resp.json()["agent_id"]

    human = mk("hussein", "human")
    atlas = mk("Atlas", "ai")
    mk("Quill", "ai")
    resp = tc.post(f"/api/containers/{cid}/requests", json={
        "requester_agent_id": atlas, "payload": "need a hand", "type": "info",
        "priority": 100, "expires_minutes": 0, "target_alias": "Quill",
    })
    assert resp.status_code == 201, resp.text
    rid = resp.json().get("request_id") or resp.json()["id"]
    time.sleep(0.05)

    class Live:
        @staticmethod
        def _get_json(url, timeout=8.0):
            got = tc.get(url.replace("http://test", ""))
            return got.json() if got.status_code == 200 else None

        @staticmethod
        def _post_json(url, body, timeout=8.0):
            got = tc.post(url.replace("http://test", ""), json=body)
            assert got.status_code == 200, got.text
            return got.json()

    out = sweep.maybe_sweep_expired("http://test", cid, Live, quiet=True)
    assert out["escalated_count"] == 1 and rid in out["request_ids"]
    row = db.execute("SELECT target_id, status FROM requests WHERE id=%s", (rid,))[0]
    assert str(row["target_id"]) == human and row["status"] == "open"


# ---- B27: one skip line per (agent, reason) ---------------------------------------------

class _Boom:
    def __getattr__(self, name):
        raise AssertionError("notifier must not touch services for a paused candidate")


def _paused(reason="Monthly budget reached ($0.00 of $0.00)"):
    return {"agent_id": "a1", "alias": "Atlas", "should_wake": True, "budget_paused": True,
            "budget_held_wake": True, "budget_reason": reason}


def _call(cand):
    return nwc.process_candidate("http://x", cand, context={}, dry_run=False, quiet=False,
                                 lease_ttl=60, live_workers={}, services=_Boom())


def test_budget_skip_line_prints_once_per_reason_and_rearms(capsys):
    nwc._BUDGET_SKIP_LOGGED.clear()
    for _ in range(20):
        assert _call(_paused()) is None
    assert capsys.readouterr().out.count("[notifier] skip Atlas") == 1
    # a different reason (e.g. the project cap now blocks) is news — print it once
    for _ in range(5):
        _call(_paused("Project budget reached"))
    assert capsys.readouterr().out.count("Project budget reached") == 1
    # pause lifts: a not-paused, not-wakeable candidate re-arms the line
    assert _call({"agent_id": "a1", "alias": "Atlas", "should_wake": False}) is None
    _call(_paused("Project budget reached"))
    assert capsys.readouterr().out.count("[notifier] skip Atlas") == 1
    nwc._BUDGET_SKIP_LOGGED.clear()
