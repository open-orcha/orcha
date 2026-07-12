"""#240 + #171/ISS-72 — human-requested GRACEFUL STOP of a worker run / resident turn.

Server-RECORDED, daemon-ENFORCED. Two halves, both covered here:

API (server records the intent + surfaces it on the existing per-tick wake-renew, zero new poll):
  * POST /api/runs/{run_id}/stop  — human-gated; sets worker_runs.stop_requested_at/by on a
    RUNNING run; idempotent; a no-op on a run that is no longer running.
  * wake-renew now returns {stop_requested, stop_run_id, stop_requested_by} — the run-scoped
    signal the daemon vets against the run IT tracks.

Notifier (the host daemon is the only side that holds the Popen handle, so it enforces):
  * reap_workers — a tracked WORKER whose stop_run_id matches is graceful-killed, finished
    'killed' (human_stop), worktree PRESERVED, lease released. A FOREIGN stop_run_id is ignored.
  * service_residents — a mid-turn RESIDENT's turn is aborted (partial flushed, '[turn stopped
    by …]' sentinel posted so resolved_through advances), lease released, conversation KEPT
    (worktree NOT torn down). An idle resident (no current_run_id) is never stopped.

Each notifier test carries a mutation note: revert the named production line → the assert RED.
"""
import json
import signal
import time

import pytest

from orcha_cli import notifier  # noqa: E402 (conftest puts orcha-cli on sys.path)


# ====================== API: POST /api/runs/{run_id}/stop ======================

async def _running_run(client, aid, *, task_id=None, lane="work"):
    """Claim a single-flight lease (so wake-renew has a LIVE lease to surface against) and record
    a running worker_run for `aid`. Returns the run_id."""
    cl = await client.post(f"/api/agents/{aid}/wake-claim", json={"lease_ttl": 300, "lane": lane})
    assert cl.status_code == 200, cl.text
    r = await client.post(f"/api/agents/{aid}/runs",
                          json={"wake_kind": "headless", "wake_event": "task_message",
                                "task_id": task_id, "lane": lane})
    assert r.status_code == 201, r.text
    return r.json()["run_id"]


@pytest.mark.asyncio
async def test_stop_records_intent_human_gated(client, make_agent, db):
    """A human stopping a RUNNING run sets stop_requested_at + stop_requested_by. Mutation: drop
    the UPDATE in stop_worker_run → stop_requested_at stays NULL → this RED."""
    worker = await make_agent("W")
    human = await make_agent("Boss", kind="human")
    run_id = await _running_run(client, worker["agent_id"])

    r = await client.post(f"/api/runs/{run_id}/stop",
                          json={"actor_agent_id": human["agent_id"]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["stop_requested"] is True
    assert body["status"] == "running"

    row = db.execute("SELECT stop_requested_at, stop_requested_by FROM worker_runs WHERE run_id=%s",
                     (run_id,))[0]
    assert row["stop_requested_at"] is not None
    assert row["stop_requested_by"] == human["agent_id"]


@pytest.mark.asyncio
async def test_stop_rejects_non_human(client, make_agent):
    """Only a human may stop a run — an AI actor gets 403. Mutation: drop the _require_kind human
    gate → an AI stop succeeds → this RED."""
    worker = await make_agent("W")
    other = await make_agent("Bot")                 # kind='ai'
    run_id = await _running_run(client, worker["agent_id"])

    r = await client.post(f"/api/runs/{run_id}/stop",
                          json={"actor_agent_id": other["agent_id"]})
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_stop_unknown_run_404(client, make_agent):
    human = await make_agent("Boss", kind="human")
    r = await client.post("/api/runs/00000000-0000-0000-0000-000000000000/stop",
                          json={"actor_agent_id": human["agent_id"]})
    assert r.status_code == 404, r.text


@pytest.mark.asyncio
async def test_stop_is_idempotent(client, make_agent):
    """Re-stopping an already-stop-requested running run is a no-op 200 (the daemon hasn't reaped
    it yet). Mutation: drop the `stop_requested_at IS NOT NULL` short-circuit → a second call
    rewrites stop_requested_by → `already_requested` missing → this RED."""
    worker = await make_agent("W")
    human = await make_agent("Boss", kind="human")
    run_id = await _running_run(client, worker["agent_id"])

    assert (await client.post(f"/api/runs/{run_id}/stop",
                              json={"actor_agent_id": human["agent_id"]})).json()["stop_requested"]
    r2 = await client.post(f"/api/runs/{run_id}/stop",
                           json={"actor_agent_id": human["agent_id"]})
    assert r2.status_code == 200, r2.text
    assert r2.json().get("already_requested") is True


@pytest.mark.asyncio
async def test_stop_finished_run_is_noop(client, make_agent):
    """A run that already finished cannot be stopped — there is nothing live to signal. Mutation:
    drop the `status != 'running'` guard → a finished run reports stop_requested=true → this RED."""
    worker = await make_agent("W")
    human = await make_agent("Boss", kind="human")
    run_id = await _running_run(client, worker["agent_id"])
    await client.post(f"/api/runs/{run_id}/finish", json={"status": "exited", "exit_code": 0})

    r = await client.post(f"/api/runs/{run_id}/stop",
                          json={"actor_agent_id": human["agent_id"]})
    assert r.status_code == 200, r.text
    assert r.json()["stop_requested"] is False
    assert r.json().get("already_finished") is True


# ====================== API: wake-renew surfaces the stop ======================

@pytest.mark.asyncio
async def test_renew_surfaces_stop_with_run_and_alias(client, make_agent):
    """The stop rides the existing per-tick renew (zero new poll): renew returns stop_requested,
    the run-scoped stop_run_id, and the requester's alias. Mutation: drop the stop SELECT in
    wake_renew → stop_requested stays False → this RED."""
    worker = await make_agent("W")
    human = await make_agent("Boss", kind="human")
    run_id = await _running_run(client, worker["agent_id"])
    await client.post(f"/api/runs/{run_id}/stop", json={"actor_agent_id": human["agent_id"]})

    r = await client.post(f"/api/agents/{worker['agent_id']}/wake-renew", json={"lease_ttl": 300})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["stop_requested"] is True
    assert body["stop_run_id"] == run_id
    assert body["stop_requested_by"] == "Boss"          # the human's alias, not the raw id


@pytest.mark.asyncio
async def test_renew_no_stop_by_default(client, make_agent):
    """A live run with no stop request surfaces stop_requested=False. Mutation: hard-code
    stop_requested=True → this RED."""
    worker = await make_agent("W")
    await _running_run(client, worker["agent_id"])
    body = (await client.post(f"/api/agents/{worker['agent_id']}/wake-renew",
                              json={"lease_ttl": 300})).json()
    assert body["stop_requested"] is False
    assert body["stop_run_id"] is None


@pytest.mark.asyncio
async def test_renew_stop_not_surfaced_once_run_finished(client, make_agent):
    """Once the run is no longer 'running' the stop is no longer surfaced (the daemon already
    reaped it). Mutation: drop the `status='running'` filter in the renew stop SELECT → a finished
    stopped run keeps surfacing → this RED."""
    worker = await make_agent("W")
    human = await make_agent("Boss", kind="human")
    run_id = await _running_run(client, worker["agent_id"])
    await client.post(f"/api/runs/{run_id}/stop", json={"actor_agent_id": human["agent_id"]})
    await client.post(f"/api/runs/{run_id}/finish", json={"status": "killed", "exit_code": -1})

    body = (await client.post(f"/api/agents/{worker['agent_id']}/wake-renew",
                              json={"lease_ttl": 300})).json()
    assert body["stop_requested"] is False


@pytest.mark.asyncio
async def test_renew_surfaces_stop_only_for_renewed_lane(client, make_agent):
    """GH #91/#90: stop lookup is lane-scoped. A stopped conversation turn must not ride a
    work-lane renew, where the daemon would reject the foreign run_id and the real conversation
    stop could stay hidden."""
    worker = await make_agent("W")
    human = await make_agent("Boss", kind="human")
    aid = worker["agent_id"]
    conversation_run = await _running_run(client, aid, lane="conversation")
    work_run = await _running_run(client, aid, lane="work")
    await client.post(f"/api/runs/{conversation_run}/stop",
                      json={"actor_agent_id": human["agent_id"]})

    work = (await client.post(f"/api/agents/{aid}/wake-renew",
                              json={"lease_ttl": 300, "lane": "work"})).json()
    assert work["renewed"] is True
    assert work["stop_requested"] is False
    assert work["stop_run_id"] is None

    conv = (await client.post(f"/api/agents/{aid}/wake-renew",
                              json={"lease_ttl": 300, "lane": "conversation"})).json()
    assert conv["renewed"] is True
    assert conv["stop_requested"] is True
    assert conv["stop_run_id"] == conversation_run
    assert conv["stop_run_id"] != work_run


# ====================== Notifier: reap_workers enforcement ======================

class FakeProc:
    """Stands in for subprocess.Popen — poll() None while alive, records nothing else needed here."""
    def __init__(self, pid=4321, exited=False):
        self.pid = pid
        self.returncode = 0 if exited else None
    def poll(self):
        return self.returncode


def _recording_post(posts, renew_ret):
    """A _post_json double: record every (url, body); return `renew_ret` for the wake-renew tick
    (the stop signal), {} otherwise."""
    def _post(url, body=None, **k):
        posts.append((url, body))
        if url.endswith("/wake-renew"):
            return renew_ret
        return {}
    return _post


def _stub_kill(monkeypatch):
    killed = []
    monkeypatch.setattr(notifier, "_kill_worker",
                        lambda proc, graceful=False, grace_secs=10.0: killed.append((proc, graceful)))
    monkeypatch.setattr(notifier, "_capture_diff", lambda wt, cap=200_000: "")
    return killed


def test_reap_workers_human_stop_kills_and_preserves(monkeypatch):
    """reap_workers: a tracked worker whose stop_run_id matches the renew signal is GRACEFUL-killed,
    finished 'killed' with a human_stop reason, its (possibly dirty) worktree PRESERVED via
    _safe_teardown_worktree, lease released, and it stops being tracked. Mutation: drop the stop
    branch in reap_workers → no kill → this RED."""
    posts = []
    monkeypatch.setattr(notifier, "_post_json", _recording_post(posts, {
        "renewed": True, "stop_requested": True, "stop_run_id": "RUN-1",
        "stop_requested_by": "Boss"}))
    monkeypatch.setattr(notifier, "_pump_one", lambda *a, **k: None)
    killed = _stub_kill(monkeypatch)
    teardown = []
    monkeypatch.setattr(notifier, "_safe_teardown_worktree",
                        lambda base, wt, br: teardown.append((base, wt, br)) or "preserved")
    proc = FakeProc(exited=False)
    live = {"agent-X": {"proc": proc, "hard_deadline": time.time() + 100,
                        "last_size": 0, "last_progress_ts": time.time(),
                        "run_id": "RUN-1", "log_path": None,
                        "worktree": "/wt", "branch": "b", "base_cwd": "/c"}}

    notifier.reap_workers("http://x", live, quiet=True)

    assert killed and killed[0][1] is True                    # graceful kill fired
    assert live == {}                                         # no longer tracked
    assert teardown == [("/c", "/wt", "b")]                   # worktree preserved-or-torn via SAFE path
    finish = next(b for u, b in posts if u.endswith("/runs/RUN-1/finish"))
    assert finish["status"] == "killed"
    assert json.loads(finish["kill_reason"])["cause"] == "human_stop"
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack["kind"] == "worker_human_stopped" and ack["release_lease"] is True


def test_reap_workers_ignores_foreign_stop_run_id(monkeypatch):
    """The daemon vets stop_run_id against the run IT tracks — a stop for a DIFFERENT run must NOT
    kill this worker (never reap a stale/foreign run). Mutation: drop the `== w.run_id` identity
    check → this worker is wrongly killed → this RED (proc stays tracked, never killed)."""
    posts = []
    monkeypatch.setattr(notifier, "_post_json", _recording_post(posts, {
        "renewed": True, "stop_requested": True, "stop_run_id": "OTHER-RUN",
        "stop_requested_by": "Boss"}))
    monkeypatch.setattr(notifier, "_pump_one", lambda *a, **k: None)
    killed = _stub_kill(monkeypatch)
    proc = FakeProc(exited=False)
    live = {"agent-X": {"proc": proc, "hard_deadline": time.time() + 100,
                        "last_size": 0, "last_progress_ts": time.time(),
                        "run_id": "RUN-1", "log_path": None, "worktree": None}}

    notifier.reap_workers("http://x", live, quiet=True)

    assert killed == []                                       # foreign stop ignored
    assert "agent-X" in live                                  # still tracked, left to work


# ====================== Notifier: service_residents enforcement ======================

def _resident_env(monkeypatch, posts, renew_ret, conv_id="C1", agent_id="A1"):
    """Wire the container-wide reads service_residents makes so a single live claude resident reaches
    the renew tick: an active-conversations scan listing the conversation, no dead-pid reap, no
    in-flight result yet."""
    monkeypatch.setattr(notifier, "_get_json",
                        lambda url, **k: {"conversations": [
                            {"conversation_id": conv_id, "agent_id": agent_id,
                             "agent_alias": "Res", "pending_human": False,
                             "last_turn_seq": 1}]})
    monkeypatch.setattr(notifier, "_reap_dead_pid_resident_runs", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "_pump_one", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "_result_after", lambda lp, off=0: None)   # turn not finished
    monkeypatch.setattr(notifier, "_post_json", _recording_post(posts, renew_ret))
    monkeypatch.setattr(notifier, "_capture_diff", lambda wt, cap=200_000: "")


def test_service_residents_human_stop_aborts_turn_keeps_conversation(monkeypatch):
    """service_residents: a mid-turn resident whose stop_run_id matches current_run_id has its TURN
    aborted — partial flushed, a '[turn stopped by Boss]' sentinel posted (so resolved_through
    advances and the turn is NOT re-run), lease released — but the conversation/worktree is KEPT
    (NO _safe_teardown_worktree). Mutation: drop the resident stop branch → no reply, no kill →
    this RED."""
    posts = []
    _resident_env(monkeypatch, posts, {
        "renewed": True, "stop_requested": True, "stop_run_id": "RUN-9",
        "stop_requested_by": "Boss"})
    killed = []
    monkeypatch.setattr(notifier, "_kill_worker",
                        lambda proc, graceful=False, grace_secs=10.0: killed.append(graceful))
    replies = []
    monkeypatch.setattr(notifier, "_post_conversation_reply",
                        lambda api, cid, r, text, meta=None: replies.append(text) or True)
    teardown = []
    monkeypatch.setattr(notifier, "_safe_teardown_worktree",
                        lambda base, wt, br: teardown.append((base, wt, br)))

    live = {"C1": {"proc": FakeProc(exited=False), "agent_id": "A1", "alias": "Res",
                   "runtime": "claude", "current_run_id": "RUN-9", "awaiting_result": True,
                   "awaiting_since": time.time(), "serviced_seq": 1,
                   "log_path": None, "worktree": "/wt", "branch": "b", "base_cwd": "/c",
                   "last_activity_ts": time.time(), "hard_deadline": time.time() + 999}}

    notifier.service_residents("http://x", "cid", live, quiet=True)

    assert killed == [True]                                   # graceful turn-kill
    assert replies == ["[turn stopped by Boss]"]             # sentinel advances resolved_through
    assert teardown == []                                     # worktree KEPT (conversation stays active)
    assert live == {}                                        # lease released → no longer tracked
    finish = next(b for u, b in posts if "/finish" in u)
    assert finish["status"] == "killed"
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack["kind"] == "resident_human_stopped" and ack["release_lease"] is True


def test_service_residents_stop_ignored_when_idle(monkeypatch):
    """An IDLE resident (no current_run_id, not awaiting) is never 'stopped' — there is no turn to
    abort, so a stale stop signal must not kill the warm session. Mutation: drop the
    `r.get('current_run_id')` guard → an idle resident is killed → this RED."""
    posts = []
    _resident_env(monkeypatch, posts, {
        "renewed": True, "stop_requested": True, "stop_run_id": "RUN-9",
        "stop_requested_by": "Boss"})
    killed = []
    monkeypatch.setattr(notifier, "_kill_worker",
                        lambda proc, graceful=False, grace_secs=10.0: killed.append(graceful))
    monkeypatch.setattr(notifier, "_post_conversation_reply", lambda *a, **k: True)
    monkeypatch.setattr(notifier, "_close_resident", lambda *a, **k: None)

    live = {"C1": {"proc": FakeProc(exited=False), "agent_id": "A1", "alias": "Res",
                   "runtime": "claude", "current_run_id": None, "awaiting_result": False,
                   "serviced_seq": 1, "log_path": None, "worktree": "/wt", "branch": "b",
                   "base_cwd": "/c", "last_activity_ts": time.time(),
                   "hard_deadline": time.time() + 999}}

    notifier.service_residents("http://x", "cid", live, quiet=True)

    assert killed == []                                      # idle resident untouched by the stop


def test_service_residents_ignores_foreign_stop_run_id(monkeypatch):
    """A mid-turn resident vets stop_run_id against the run IT is executing — a stop for a DIFFERENT
    run (stale/foreign) must NOT abort this turn. Resident analogue of
    test_reap_workers_ignores_foreign_stop_run_id, and the teeth for the run-id identity guard
    (`str(stop_run_id) == str(current_run_id)`). Mutation: drop that `==` clause → a live resident
    (current_run_id truthy) is wrongly killed on any foreign stop → this RED."""
    posts = []
    _resident_env(monkeypatch, posts, {
        "renewed": True, "stop_requested": True, "stop_run_id": "OTHER-RUN",
        "stop_requested_by": "Boss"})
    killed = []
    monkeypatch.setattr(notifier, "_kill_worker",
                        lambda proc, graceful=False, grace_secs=10.0: killed.append(graceful))
    replies = []
    monkeypatch.setattr(notifier, "_post_conversation_reply",
                        lambda api, cid, r, text, meta=None: replies.append(text) or True)
    monkeypatch.setattr(notifier, "_close_resident", lambda *a, **k: None)

    live = {"C1": {"proc": FakeProc(exited=False), "agent_id": "A1", "alias": "Res",
                   "runtime": "claude", "current_run_id": "RUN-9", "awaiting_result": True,
                   "awaiting_since": time.time(), "serviced_seq": 1,
                   "log_path": None, "worktree": "/wt", "branch": "b", "base_cwd": "/c",
                   "last_activity_ts": time.time(), "hard_deadline": time.time() + 999}}

    notifier.service_residents("http://x", "cid", live, quiet=True)

    assert killed == []                                      # foreign stop ignored — turn left running
    assert replies == []                                     # no '[turn stopped]' sentinel posted
    assert "C1" in live                                      # resident still tracked (turn not aborted)


def test_service_residents_codex_human_stop_aborts_turn(monkeypatch):
    """P1: a live CODEX conversation worker has a worker_runs row, so POST /runs/{id}/stop targets it
    — the codex branch of service_residents must ENFORCE the stop, not discard the renew. A matching
    stop_run_id graceful-kills the turn, posts a '[turn stopped]' sentinel (resolved_through advances),
    finishes 'killed', releases the lease, KEEPS the conversation. Mutation: drop the codex stop branch
    → the worker runs on to exit/hard-cap → killed==[] and C1 survives → this RED."""
    posts = []
    _resident_env(monkeypatch, posts, {
        "renewed": True, "stop_requested": True, "stop_run_id": "RUN-CODEX",
        "stop_requested_by": "Boss"})
    killed = []
    monkeypatch.setattr(notifier, "_kill_worker",
                        lambda proc, graceful=False, grace_secs=10.0: killed.append(graceful))
    replies = []
    monkeypatch.setattr(notifier, "_post_conversation_reply",
                        lambda api, cid, r, text, meta=None: replies.append(text) or True)

    live = {"C1": {"proc": FakeProc(exited=False), "agent_id": "A1", "alias": "Res",
                   "runtime": notifier.RUNTIME_CODEX, "current_run_id": "RUN-CODEX",
                   "serviced_seq": 1, "log_path": None, "worktree": "/wt", "branch": "b",
                   "base_cwd": "/c", "last_activity_ts": time.time(),
                   "hard_deadline": time.time() + 999}}

    notifier.service_residents("http://x", "cid", live, quiet=True)

    assert killed == [True]                                  # graceful turn-kill
    assert replies == ["[turn stopped by Boss]"]            # sentinel advances resolved_through
    assert live == {}                                        # lease released → no longer tracked
    finish = next(b for u, b in posts if "/finish" in u)
    assert finish["status"] == "killed"
    ack = next(b for u, b in posts if u.endswith("/wake-ack"))
    assert ack["kind"] == "codex_conversation_human_stopped" and ack["release_lease"] is True


def test_service_residents_codex_ignores_foreign_stop_run_id(monkeypatch):
    """A live codex conversation worker vets stop_run_id against the run IT executes — a foreign/stale
    stop (RUN-CODEX vs OTHER-RUN) must NOT abort it. Mutation: drop the `==` identity clause in the
    codex stop branch → wrongly killed → this RED."""
    posts = []
    _resident_env(monkeypatch, posts, {
        "renewed": True, "stop_requested": True, "stop_run_id": "OTHER-RUN",
        "stop_requested_by": "Boss"})
    killed = []
    monkeypatch.setattr(notifier, "_kill_worker",
                        lambda proc, graceful=False, grace_secs=10.0: killed.append(graceful))
    replies = []
    monkeypatch.setattr(notifier, "_post_conversation_reply",
                        lambda api, cid, r, text, meta=None: replies.append(text) or True)

    live = {"C1": {"proc": FakeProc(exited=False), "agent_id": "A1", "alias": "Res",
                   "runtime": notifier.RUNTIME_CODEX, "current_run_id": "RUN-CODEX",
                   "serviced_seq": 1, "log_path": None, "worktree": "/wt", "branch": "b",
                   "base_cwd": "/c", "last_activity_ts": time.time(),
                   "hard_deadline": time.time() + 999}}

    notifier.service_residents("http://x", "cid", live, quiet=True)

    assert killed == []                                      # foreign stop ignored
    assert replies == []                                     # no sentinel
    assert "C1" in live                                      # codex turn left running
