"""GH#36 — empty-inbox headless worker stuck in boot → stall → watchdog-kill loop.

A `request_answered` event grades as a T2 `ack_close`. When the cheap-act can't complete it
(`acted:false`) the daemon used to fall through to a FULL headless boot — even when the request
was already RESOLVED (closed/escalated), so the booted worker found an empty inbox, stalled, and
was watchdog-killed, re-arming the same wake indefinitely (and leaking a worktree per cycle).

Two complementary fixes, both covered here (each test carries its mutation note):

  Fix A (notifier._apply_wake_act / GET /api/requests/{rid}) — an ack_close whose request is
    PROVABLY non-actionable is a no-op: advance the cursor, DON'T boot. A still-'answered' request
    proceeds to the real cheap-act; an unreachable read escalates conservatively (never drop work).

  Fix B (notifier.reap_workers) — a NO-OP ephemeral worker (no task, no diff) that stalls into a
    watchdog kill re-asserts the cursor advance to the trigger ts it consumed, so it can't re-arm.
    A worker that made progress (a task wake, or a dirty diff) leaves the cursor ALONE.
"""
import json
import time
import types
import uuid

import pytest

from orcha_cli import notifier  # noqa: E402 (conftest puts orcha-cli on sys.path)


# ===========================================================================================
# GET /api/requests/{rid} — the read the daemon uses to tell actionable from resolved
# ===========================================================================================

@pytest.mark.asyncio
async def test_get_request_reports_status_across_lifecycle(client, container, make_agent, make_request):
    """INTEGRATION: the new read surfaces a request's live status so the daemon can tell an
    ACTIONABLE ack_close ('answered') from a resolved no-op ('closed'). MUTATION: drop the endpoint
    → the daemon's _request_actionable reads None → conservatively boots (the loop) → this RED."""
    a = await make_agent("Asker")
    b = await make_agent("Teller")
    req = await make_request(a["agent_id"], "q", target_alias="Teller")

    r = await client.get(f"/api/requests/{req['id']}")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "open"

    await client.post(f"/api/requests/{req['id']}/respond",
                      json={"responder_agent_id": b["agent_id"], "response": "ok"})
    assert (await client.get(f"/api/requests/{req['id']}")).json()["status"] == "answered"

    await client.post(f"/api/requests/{req['id']}/triage-close", json={"triage_reason": "x"})
    assert (await client.get(f"/api/requests/{req['id']}")).json()["status"] == "closed"


@pytest.mark.asyncio
async def test_get_request_404_and_400(client):
    """A well-formed but unknown id → 404 (definitive: the daemon may suppress); a malformed id → 400."""
    assert (await client.get(f"/api/requests/{uuid.uuid4()}")).status_code == 404
    assert (await client.get("/api/requests/not-a-uuid")).status_code == 400


# ===========================================================================================
# Fix A — _apply_wake_act resolves an already-handled ack_close WITHOUT a boot
# ===========================================================================================

def _fake_llm(decision=None, raise_exc=None):
    def handoff_ack(text, *, config=None, api_key=None):
        if raise_exc:
            raise raise_exc
        return decision
    return types.SimpleNamespace(handoff_ack=handoff_ack)


def test_ack_close_already_resolved_advances_cursor_no_boot(monkeypatch):
    """GH#36 (Fix A): an ack_close whose request is no longer 'answered' (already closed) is a pure
    no-op — _apply_wake_act advances the cursor and returns True (so tick does NOT boot) WITHOUT
    ever touching the cheap substrate or the triage-close write. MUTATION: drop the actionability
    short-circuit → it consults handoff_ack (here raising) / escalates to a boot → RED."""
    posts = []
    monkeypatch.setattr(notifier, "_get_json", lambda url, **k: {"status": "closed"})
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: posts.append((url, body)) or {})
    # If the substrate were consulted the test would error — the no-op path must short-circuit before it.
    monkeypatch.setattr(notifier, "_llm_util",
                        _fake_llm(raise_exc=AssertionError("substrate must not be consulted")))
    cand = {"agent_id": "a-1", "alias": "X", "ack_through_ts": 7.0, "max_event_ts": 9.0}
    verdict = {"tier": "act", "action": "ack_close", "request_id": "r-9", "text": "the answer"}

    ok = notifier._apply_wake_act("http://api", cand, "request_answered", verdict, quiet=True)

    assert ok is True
    assert not any("triage-close" in u for u, _ in posts)      # NO cheap write
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack["delivered_ts"] == 7.0                          # cursor advanced through the trigger
    assert ack["kind"] == "skipped" and ack["release_lease"] is False


def test_ack_close_still_answered_proceeds_to_cheap_act(monkeypatch):
    """GH#36 guard: a request STILL in 'answered' state is actionable — the no-op shortcut must NOT
    fire; _apply_wake_act proceeds to the normal cheap-act (triage-close + cursor). Keeps the T2
    contract intact for a genuine pure-ack answer. MUTATION: treat any non-None status as resolved →
    the real close never fires → RED (no triage-close post)."""
    posts = []
    monkeypatch.setattr(notifier, "_get_json", lambda url, **k: {"status": "answered"})
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: posts.append((url, body)) or {})
    monkeypatch.setattr(notifier, "_llm_util", _fake_llm({"ack": True, "text": "thanks, closing"}))
    cand = {"agent_id": "a-1", "alias": "X", "ack_through_ts": 7.0, "max_event_ts": 9.0}
    verdict = {"tier": "act", "action": "ack_close", "request_id": "r-9", "text": "the answer"}

    ok = notifier._apply_wake_act("http://api", cand, "request_answered", verdict, quiet=True)

    assert ok is True
    assert any("/api/requests/r-9/triage-close" in u for u, _ in posts)   # the real cheap-act fired


def test_ack_close_unreachable_status_escalates_conservatively(monkeypatch):
    """GH#36 conservative: an UNREACHABLE status read (_get_json None — a 404 is indistinguishable
    from a dead API) must NOT trigger the no-op shortcut. With no cheap substrate it ESCALATES to a
    boot (returns False, no writes), never silently dropping a possibly-still-actionable request.
    MUTATION: treat None as 'resolved' → it would advance the cursor + skip the boot → RED."""
    posts = []
    monkeypatch.setattr(notifier, "_get_json", lambda url, **k: None)
    monkeypatch.setattr(notifier, "_post_json", lambda url, body, **k: posts.append((url, body)) or {})
    monkeypatch.setattr(notifier, "_llm_util", None)
    cand = {"agent_id": "a-1", "alias": "X", "max_event_ts": 9.0}
    verdict = {"tier": "act", "action": "ack_close", "request_id": "r-9", "text": "x"}

    ok = notifier._apply_wake_act("http://api", cand, "request_answered", verdict, quiet=True)

    assert ok is False and posts == []


def test_request_actionable_maps_status(monkeypatch):
    """Unit: _request_actionable is True only for 'answered'; False for any other definitive status;
    None when the read can't tell (unreachable / malformed)."""
    monkeypatch.setattr(notifier, "_get_json", lambda url, **k: {"status": "answered"})
    assert notifier._request_actionable("http://api", "r-1") is True
    monkeypatch.setattr(notifier, "_get_json", lambda url, **k: {"status": "closed"})
    assert notifier._request_actionable("http://api", "r-1") is False
    monkeypatch.setattr(notifier, "_get_json", lambda url, **k: {"status": "escalated"})
    assert notifier._request_actionable("http://api", "r-1") is False
    monkeypatch.setattr(notifier, "_get_json", lambda url, **k: None)
    assert notifier._request_actionable("http://api", "r-1") is None
    monkeypatch.setattr(notifier, "_get_json", lambda url, **k: {})
    assert notifier._request_actionable("http://api", "r-1") is None


# ===========================================================================================
# Fix B — reap_workers: a NO-OP stall-kill re-acks the trigger; a progressing kill does not
# ===========================================================================================

class _FakeProc:
    def __init__(self, pid=4321):
        self.pid = pid
        self.returncode = None      # still alive (not exited)
    def poll(self):
        return self.returncode


def _wire_stall_kill(monkeypatch, posts, *, diff):
    """Drive reap_workers down the genuine STALL-kill branch: alive proc, log-silent, NOT live,
    not completed, not over-cap, not respawnable. Records every _post_json (renew returns no stop)."""
    def _post(url, body=None, **k):
        posts.append((url, body))
        return {"renewed": True} if url.endswith("/wake-renew") else {}
    monkeypatch.setattr(notifier, "_post_json", _post)
    monkeypatch.setattr(notifier, "_pump_one", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "_kill_worker",
                        lambda proc, graceful=False, grace_secs=10.0: None)
    monkeypatch.setattr(notifier, "_capture_diff", lambda wt, cap=200_000: diff)
    monkeypatch.setattr(notifier, "_finish_run", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "_safe_teardown_worktree", lambda base, wt, br: "preserved")
    # GH#61 made these runtime-aware (Codex vs Claude log schema) — match the kwarg signature.
    monkeypatch.setattr(notifier, "_terminal_status", lambda lp, runtime=None: None)  # not completed
    monkeypatch.setattr(notifier, "_worker_is_live", lambda lp, runtime=None: False)  # genuinely stalled
    monkeypatch.setattr(notifier, "_last_event_type", lambda lp: "stream_event")


def _stalled_worker(**extra):
    now = time.time()
    w = {"proc": _FakeProc(), "hard_deadline": now + 1000,         # not over-cap
         "last_size": 0, "last_progress_ts": now - 1000,           # log-silent > stall_secs
         "run_id": "RUN-1", "log_path": None,
         "worktree": None, "branch": None, "base_cwd": "/c"}
    w.update(extra)
    return w


def test_noop_stall_kill_readvances_cursor(monkeypatch):
    """GH#36 (Fix B): a NO-OP ephemeral worker (no task attributed, no diff) killed for STALL
    re-asserts the cursor advance to the trigger ts it consumed — so the SAME wake can't re-arm.
    MUTATION: drop the delivered_ts branch in the kill ack → the trigger stays pending → RED."""
    posts = []
    _wire_stall_kill(monkeypatch, posts, diff="")
    live = {"a-X": _stalled_worker(wake_task_id=None, wake_ack_ts=42.0,
                                   wake_event="request_answered")}

    notifier.reap_workers("http://x", live, quiet=True)

    assert live == {}
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack["kind"] == "worker_stalled_killed" and ack["release_lease"] is True
    assert ack["delivered_ts"] == 42.0                 # GH#36 backstop advanced the cursor


def test_task_wake_stall_kill_leaves_cursor(monkeypatch):
    """A worker booted for a TASK wake that stalls must NOT have its trigger acked-away — its work
    isn't finished, so it must stay free to re-wake. MUTATION: drop the `not wake_task_id` guard →
    a stalled task wake would be acked-away (silently dropped) → RED (delivered_ts present)."""
    posts = []
    _wire_stall_kill(monkeypatch, posts, diff="")
    live = {"a-X": _stalled_worker(wake_task_id="t-1", wake_ack_ts=42.0,
                                   wake_event="task_message")}

    notifier.reap_workers("http://x", live, quiet=True)

    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack["kind"] == "worker_stalled_killed" and ack["release_lease"] is True
    assert "delivered_ts" not in ack                   # task work left free to re-wake


def test_dirty_diff_stall_kill_leaves_cursor(monkeypatch):
    """A worker that produced uncommitted WORK (a dirty diff) before stalling did real work — leave
    its cursor alone so it can re-wake to finish. MUTATION: drop the diff guard → a worker mid-edit
    would be acked-away → RED (delivered_ts present)."""
    posts = []
    _wire_stall_kill(monkeypatch, posts, diff="diff --git a/f b/f\n+x\n")
    live = {"a-X": _stalled_worker(wake_task_id=None, wake_ack_ts=42.0,
                                   wake_event="request_answered")}

    notifier.reap_workers("http://x", live, quiet=True)

    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert "delivered_ts" not in ack
