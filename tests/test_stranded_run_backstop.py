"""Stranded 'running' runs must never block an agent's wakes forever.

Field bug (fleet-mate, 2026-09-30): the notifier's single loop thread spent over an
hour inside a checkout handoff that ran one `git diff --no-index` per IGNORED file of
the developer's main checkout (262k files: node_modules, ios/Pods, build output).
While it was stuck, nothing reaped finished workers: Atlas's worker exited (a zombie
of the daemon), its run row stayed 'running', its work lease lapsed, and wake-scan
said "an embodiment is still running — lapsed-lease orphan" for every later wake.
The only server cleanup only looked at LIVE leases.

Teeth, both layers:
  * server backstop: a running row with NO live lease on its lane and no activity for
    the orphan threshold is orphaned (token revoked, event logged) — and never a run
    whose lease is live or whose run/lane showed activity inside the threshold;
  * notifier: a finished worker's run is closed with its exit code; a dead or zombie
    pid (or a recycled one) left 'running' is reconciled by a fresh daemon's sweep;
    handoff patches skip wholly ignored directories and are bounded; a tracked worker
    is never overwritten by a second spawn.
"""
import os
import subprocess
import sys
import time
from urllib.parse import urlsplit

import pytest
from fastapi.testclient import TestClient

import main
from orcha_cli import notifier
from orcha_cli import notifier_embodiment
from orcha_cli import notifier_wake_candidate
from orcha_cli import notifier_worktree_cleanup as cleanup
from conftest import ts_ago
from portal_backend import sql

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")


# ============================ server: the stranded-run backstop ============================

async def _running_work_run(client, db, aid, *, silent_secs, lease="lapsed"):
    """A work-lane run recorded under a claimed lease, then aged `silent_secs`."""
    claim = await client.post(f"/api/agents/{aid}/wake-claim",
                              json={"lease_ttl": 180, "kind": "ephemeral"})
    assert claim.json()["claimed"] is True
    tok = (await client.post(f"/api/agents/{aid}/embodiment-tokens",
                             json={"lane": "work", "kind": "headless"})).json()["run_token"]
    run_id = (await client.post(f"/api/agents/{aid}/runs",
                                json={"wake_kind": "ephemeral", "pid": 91071,
                                      "token_id": tok})).json()["run_id"]
    ago = db.ago(int(silent_secs))
    db.execute("UPDATE worker_runs SET started_at = %s WHERE run_id=%s", (ago, run_id))
    db.execute("UPDATE agent_wake_state SET work_last_heartbeat_at = %s, "
               "last_woken_at = %s WHERE agent_id=%s", (ago, ago, aid))
    db.execute("UPDATE agents SET last_heartbeat_at = %s WHERE id=%s", (ago, aid))
    if lease == "lapsed":
        db.execute(f"UPDATE agent_wake_state SET wake_lease_until = {ts_ago(60)} "
                   "WHERE agent_id=%s", (aid,))
    return run_id, tok


def _status(db, run_id):
    return db.execute("SELECT status FROM worker_runs WHERE run_id=%s", (run_id,))[0]["status"]


def _revoked(db, tok):
    return db.execute("SELECT revoked_at FROM embodiment_tokens WHERE run_token=%s",
                      (tok,))[0]["revoked_at"] is not None


async def _candidate(client, cid, aid):
    scan = (await client.get(f"/api/containers/{cid}/wake-scan?cooldown=0&min_idle=0")).json()
    return next(c for c in scan["candidates"] if c["agent_id"] == aid)


async def test_lapsed_lease_running_row_is_orphaned(client, make_agent, container, db):
    """HEADLINE: the fleet-mate state — a 'running' row, lease lapsed, silent past the
    threshold — is orphaned, its token revoked, an event logged, and wakes unblock."""
    cid = container["id"]
    aid = (await make_agent("Atlas"))["agent_id"]
    run_id, tok = await _running_work_run(client, db, aid, silent_secs=2000)

    before = await _candidate(client, cid, aid)
    assert before["embodiment_running"] is True and before["lease_active"] is False
    assert "due for automatic reconciliation" in before["reason"]      # honest, not "queued"

    r = await client.post(f"/api/containers/{cid}/reap-orphan-leases")
    assert r.status_code == 200, r.text
    stranded = r.json()["stranded"]
    assert [s["run_id"] for s in stranded] == [run_id]
    assert stranded[0]["lane"] == "work" and stranded[0]["idle_seconds"] >= 2000
    assert r.json()["reaped"] == []                   # not the live-lease reaper's case

    assert _status(db, run_id) == "orphaned"
    assert _revoked(db, tok)
    ev = db.execute("SELECT detail FROM events WHERE entity_id=%s "
                    "AND event_type='stranded_run_reaped'", (aid,))
    assert len(ev) == 1

    after = await _candidate(client, cid, aid)
    assert after["embodiment_running"] is False       # the agent recovers by itself

    again = await client.post(f"/api/containers/{cid}/reap-orphan-leases")
    assert again.json()["stranded"] == []             # idempotent


async def test_live_lease_with_fresh_heartbeat_is_untouched(client, make_agent, container, db):
    """A worker whose daemon still renews its lease is governed — even a long run is left alone."""
    cid = container["id"]
    aid = (await make_agent("Busy"))["agent_id"]
    run_id, tok = await _running_work_run(client, db, aid, silent_secs=5000, lease="live")
    await client.post(f"/api/agents/{aid}/wake-renew", json={"lease_ttl": 180})  # fresh heartbeat

    r = await client.post(f"/api/containers/{cid}/reap-orphan-leases")
    assert r.json()["stranded"] == [] and r.json()["reaped"] == []
    assert _status(db, run_id) == "running"
    assert not _revoked(db, tok)


async def test_lapsed_lease_with_recent_activity_waits_for_threshold(
        client, make_agent, container, db):
    """A lapsed lease alone is not proof of death: output streamed inside the threshold keeps
    the run; once that activity is itself older than the threshold, the run is reconciled."""
    cid = container["id"]
    aid = (await make_agent("Quiet"))["agent_id"]
    run_id, tok = await _running_work_run(client, db, aid, silent_secs=3000)
    db.execute("INSERT INTO worker_run_lines (run_id, seq, line, ts) "
               f"VALUES (%s, 1, '{{}}', {ts_ago(60)})", (run_id,))

    r = await client.post(f"/api/containers/{cid}/reap-orphan-leases")
    assert r.json()["stranded"] == []
    assert _status(db, run_id) == "running"
    reason = (await _candidate(client, cid, aid))["reason"]
    assert "reconciled automatically in ~20m" in reason

    db.execute(f"UPDATE worker_run_lines SET ts = {ts_ago(1300)} "
               "WHERE run_id=%s", (run_id,))
    r = await client.post(f"/api/containers/{cid}/reap-orphan-leases")
    assert [s["run_id"] for s in r.json()["stranded"]] == [run_id]
    assert _status(db, run_id) == "orphaned" and _revoked(db, tok)


async def test_recent_lane_heartbeat_keeps_lapsed_run(client, make_agent, container, db):
    """The lane heartbeat (the worker's own /wait long-poll bumps it) also counts as activity."""
    cid = container["id"]
    aid = (await make_agent("Polling"))["agent_id"]
    run_id, _ = await _running_work_run(client, db, aid, silent_secs=3000)
    db.execute(f"UPDATE agent_wake_state SET work_last_heartbeat_at = {ts_ago(30)} "
               "WHERE agent_id=%s", (aid,))
    r = await client.post(f"/api/containers/{cid}/reap-orphan-leases")
    assert r.json()["stranded"] == [] and _status(db, run_id) == "running"


async def test_conversation_lane_stranded_run_is_orphaned(client, make_agent, container, db):
    """Same backstop for the conversation lane, keyed on the conversation lease + heartbeat."""
    cid = container["id"]
    aid = (await make_agent("Chat"))["agent_id"]
    await client.post(f"/api/agents/{aid}/wake-claim",
                      json={"lease_ttl": 180, "kind": "resident", "lease_kind": "resident"})
    run_id = (await client.post(f"/api/agents/{aid}/runs",
                                json={"wake_kind": "resident", "pid": 97263,
                                      "lane": "conversation"})).json()["run_id"]
    db.execute(f"UPDATE worker_runs SET started_at = {ts_ago(2000)} "
               "WHERE run_id=%s", (run_id,))
    db.execute(f"UPDATE agent_wake_state SET conv_lease_until = {ts_ago(60)}, "
               f"conv_last_heartbeat_at = {ts_ago(2000)}, "
               f"conv_last_woken_at = {ts_ago(2000)} WHERE agent_id=%s", (aid,))

    r = await client.post(f"/api/containers/{cid}/reap-orphan-leases")
    assert [(s["run_id"], s["lane"]) for s in r.json()["stranded"]] == [(run_id, "conversation")]
    assert _status(db, run_id) == "orphaned"


async def test_sandbox_row_gets_its_runtime_window(client, make_agent, container, db):
    """An adopted sandbox container legitimately runs without a lease after a daemon restart;
    the backstop waits out the sandbox deadline before calling it stranded."""
    cid = container["id"]
    aid = (await make_agent("Boxed"))["agent_id"]
    run_id = (await client.post(f"/api/agents/{aid}/runs",
                                json={"wake_kind": "sandbox", "pid": 1,
                                      "sandbox_container_id": "orcha-run-abc"})).json()["run_id"]
    db.execute(f"UPDATE worker_runs SET started_at = {ts_ago(2000)} "
               "WHERE run_id=%s", (run_id,))
    r = await client.post(f"/api/containers/{cid}/reap-orphan-leases")
    assert r.json()["stranded"] == [] and _status(db, run_id) == "running"

    db.execute(f"UPDATE worker_runs SET started_at = {ts_ago(9000)} "
               "WHERE run_id=%s", (run_id,))
    r = await client.post(f"/api/containers/{cid}/reap-orphan-leases")
    assert [s["run_id"] for s in r.json()["stranded"]] == [run_id]


# ============================ notifier: exit detection + reconcile ============================

def _bridge(monkeypatch, tc):
    """Route the notifier's HTTP seams into the real API (in-process)."""
    def _path(url):
        parts = urlsplit(url)
        return parts.path + (f"?{parts.query}" if parts.query else "")

    def post(url, body=None, **_):
        r = tc.post(_path(url), json=body or {})
        return r.json() if r.status_code < 300 else None

    def get(url, **_):
        r = tc.get(_path(url))
        return r.json() if r.status_code < 300 else None

    monkeypatch.setattr(notifier, "_post_json", post)
    monkeypatch.setattr(notifier, "_get_json", get)
    monkeypatch.setattr(notifier._sandbox, "managed_containers", lambda cid: [])
    monkeypatch.setattr(notifier._sandbox, "daemon_reachable", lambda: True)


def _arena(tc, alias):
    cid = tc.post("/api/containers", json={"name": f"arena-{alias}"}).json()["container_id"]
    aid = tc.post(f"/api/containers/{cid}/agents",
                  json={"alias": alias, "role": "worker", "kind": "ai",
                        "prompt": "You are a test agent."}).json()["agent_id"]
    return cid, aid


def _zombie_state(pid):
    out = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True)
    return out.stdout.strip()


def test_exited_worker_run_is_closed_with_exit_code(monkeypatch, tmp_path, db):
    """A real spawned worker exits → the reaper waits it (no zombie), closes its run with the
    real exit code, and releases the lease so the agent is wakeable again."""
    tc = TestClient(main.app)
    _bridge(monkeypatch, tc)
    cid, aid = _arena(tc, "Worker")
    assert tc.post(f"/api/agents/{aid}/wake-claim",
                   json={"lease_ttl": 180, "kind": "ephemeral"}).json()["claimed"] is True
    proc = subprocess.Popen([sys.executable, "-c", "import sys; sys.exit(3)"],
                            start_new_session=True)
    run_id = tc.post(f"/api/agents/{aid}/runs",
                     json={"wake_kind": "ephemeral", "pid": proc.pid}).json()["run_id"]
    live = {aid: {"proc": proc, "run_id": run_id, "log_path": None, "worktree": None,
                  "hard_deadline": time.time() + 100, "last_progress_ts": time.time(),
                  "agent_id": aid, "lane": "work"}}
    deadline = time.time() + 10
    while not _zombie_state(proc.pid).startswith("Z") and time.time() < deadline:
        time.sleep(0.05)                                  # exited but not yet reaped

    notifier.reap_workers("http://x", live, quiet=True)

    assert live == {}
    assert proc.returncode == 3 and _zombie_state(proc.pid) == ""   # waited: no zombie left
    row = db.execute("SELECT status, exit_code FROM worker_runs WHERE run_id=%s", (run_id,))[0]
    assert (row["status"], row["exit_code"]) == ("exited", 3)
    scan = tc.get(f"/api/containers/{cid}/wake-scan?cooldown=0&min_idle=0").json()
    me = next(c for c in scan["candidates"] if c["agent_id"] == aid)
    assert me["embodiment_running"] is False and me["lease_active"] is False


def test_fresh_daemon_reconciles_zombie_pid_run(monkeypatch, tmp_path, db):
    """The exact field state: a finished worker left as a ZOMBIE (os.kill(pid,0) still
    succeeds) with its run 'running'. A fresh daemon's sweep (no live handles) treats the
    zombie as dead, records the completed turn as exited, and releases the lease."""
    tc = TestClient(main.app)
    _bridge(monkeypatch, tc)
    cid, aid = _arena(tc, "Zombie")
    tc.post(f"/api/agents/{aid}/wake-claim", json={"lease_ttl": 180, "kind": "ephemeral"})
    log = tmp_path / "w.log"
    log.write_text('{"type":"assistant","message":"done"}\n'
                   '{"type":"result","subtype":"success","result":"ok"}\n')
    proc = subprocess.Popen([sys.executable, "-c", "pass"])   # never polled → zombie
    try:
        deadline = time.time() + 10
        while not _zombie_state(proc.pid).startswith("Z") and time.time() < deadline:
            time.sleep(0.05)
        assert _zombie_state(proc.pid).startswith("Z")
        os.kill(proc.pid, 0)                                   # "alive" to a bare os.kill
        run_id = tc.post(f"/api/agents/{aid}/runs",
                         json={"wake_kind": "ephemeral", "pid": proc.pid,
                               "log_path": str(log)}).json()["run_id"]

        assert notifier.reap_orphaned_runs("http://x", cid, frozenset()) == 1
    finally:
        proc.wait()
    row = db.execute("SELECT status, exit_code FROM worker_runs WHERE run_id=%s", (run_id,))[0]
    assert (row["status"], row["exit_code"]) == ("exited", 0)    # completed, not "killed"
    scan = tc.get(f"/api/containers/{cid}/wake-scan?cooldown=0&min_idle=0").json()
    me = next(c for c in scan["candidates"] if c["agent_id"] == aid)
    assert me["embodiment_running"] is False and me["lease_active"] is False


def test_fresh_daemon_reconciles_dead_and_recycled_pids(monkeypatch, db):
    """Startup reconcile: a dead pid is killed/-1; a pid now owned by a NEWER process (recycled)
    is not the run's process either; a live process that predates its row is left alone."""
    tc = TestClient(main.app)
    _bridge(monkeypatch, tc)
    cid, aid = _arena(tc, "Restart")

    def agent(alias):
        return tc.post(f"/api/containers/{cid}/agents",
                       json={"alias": alias, "role": "worker", "kind": "ai",
                             "prompt": "You are a test agent."}).json()["agent_id"]

    other, third = agent("Other"), agent("Third")
    dead = tc.post(f"/api/agents/{aid}/runs",
                   json={"wake_kind": "ephemeral", "pid": 2_000_000}).json()["run_id"]
    sleeper = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        # the sleeper started ~now; a row claiming it started in 2020 is a recycled pid
        recycled = tc.post(f"/api/agents/{other}/runs",
                           json={"wake_kind": "ephemeral", "pid": sleeper.pid}).json()["run_id"]
        db.execute("UPDATE worker_runs SET started_at = '2020-01-01T00:00:00Z' "
                   "WHERE run_id=%s", (recycled,))
        time.sleep(1.1)
        genuine = tc.post(f"/api/agents/{third}/runs",
                          json={"wake_kind": "ephemeral", "pid": sleeper.pid}).json()["run_id"]

        assert notifier.reap_orphaned_runs("http://x", cid, frozenset()) == 2
    finally:
        sleeper.kill()
        sleeper.wait()
    rows = {str(r["run_id"]): r for r in db.execute(
        f"SELECT run_id, status, exit_code FROM worker_runs "
        f"WHERE {sql.in_list('CAST(run_id AS TEXT)')}",
        (sql.list_param([dead, recycled, genuine]),))}
    assert (rows[dead]["status"], rows[dead]["exit_code"]) == ("killed", -1)
    assert rows[recycled]["status"] == "killed"
    assert rows[genuine]["status"] == "running"


def test_pid_liveness_treats_zombie_as_dead():
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    try:
        deadline = time.time() + 10
        while not _zombie_state(proc.pid).startswith("Z") and time.time() < deadline:
            time.sleep(0.05)
        assert notifier_embodiment.run_pid_alive(proc.pid) is False
    finally:
        proc.wait()
    assert notifier_embodiment.run_pid_alive(os.getpid()) is True
    assert notifier_embodiment.run_pid_reused(os.getpid(), None) is False   # unknown → not reused


# ============================ notifier: bounded patch building ============================

class _CountingGit:
    def __init__(self):
        self.calls = []

    def _run_git(self, args, cwd=None, timeout=30.0):
        self.calls.append(list(args))
        return notifier._run_git(args, cwd=cwd, timeout=timeout)


def _repo(tmp_path):
    repo = tmp_path / "main"
    repo.mkdir()
    run = lambda *a: subprocess.run(["git", *a], cwd=repo, check=True, capture_output=True)
    run("init", "-q", "-b", "main")
    run("config", "user.email", "t@t")
    run("config", "user.name", "t")
    (repo / ".gitignore").write_text("node_modules/\n.env\n")
    (repo / "app.py").write_text("print('hi')\n")
    run("add", ".")
    run("commit", "-qm", "init")
    run("update-ref", "refs/remotes/origin/main", "HEAD")
    return repo


def test_handoff_patch_skips_ignored_directories(tmp_path):
    """The field stall: every ignored file got its own git process. A wholly ignored directory
    (node_modules/) is now skipped as a unit while a lone ignored file (.env) is still carried."""
    repo = _repo(tmp_path)
    modules = repo / "node_modules" / "pkg"
    modules.mkdir(parents=True)
    for i in range(400):
        (modules / f"f{i}.js").write_text(f"module.exports = {i}\n")
    (repo / ".env").write_text("SECRET=1\n")
    (repo / "notes.md").write_text("draft\n")
    git = _CountingGit()

    patch = cleanup._full_patch(str(repo), git, include_ignored=True)

    assert patch is not None
    assert ".env" in patch and "notes.md" in patch
    assert "node_modules" not in patch
    per_file = [c for c in git.calls if "--no-index" in c]
    assert len(per_file) == 2                             # .env + notes.md, not 402
    paths = cleanup._status_paths(str(repo), git)
    assert paths == {".env", "notes.md"}                  # same view as the patch


def test_exact_patch_refuses_unbounded_work(tmp_path, monkeypatch):
    repo = _repo(tmp_path)
    for i in range(12):
        (repo / f"n{i}.txt").write_text("x\n")
    monkeypatch.setattr(cleanup, "MAX_PATCH_UNTRACKED_FILES", 10)
    git = _CountingGit()
    assert cleanup._full_patch(str(repo), git, include_ignored=True) is None
    assert not [c for c in git.calls if "--no-index" in c]   # refused before any per-file diff


def test_capture_diff_stops_at_its_cap(tmp_path):
    repo = _repo(tmp_path)
    for i in range(60):
        (repo / f"big{i}.txt").write_text("y" * 2000 + "\n")
    git = _CountingGit()
    out = cleanup.capture_diff(str(repo), git, cap=5000)
    assert out.endswith("...[diff truncated]...")
    assert len([c for c in git.calls if "--no-index" in c]) < 10   # not all 60


# ============================ notifier: never drop a tracked worker ============================

def test_tracked_worker_is_not_overwritten_by_a_second_spawn(monkeypatch):
    spawned = []
    monkeypatch.setattr(notifier_wake_candidate.notifier_wake_worker, "spawn",
                        lambda *a, **k: spawned.append(1) or {"sent": True})

    class Svc:
        build_wake_prompt = staticmethod(lambda c: "p")
        select_transport = staticmethod(lambda c: "ephemeral")
        derive_wake_event = staticmethod(lambda c: "e")
        decide_wake_tier = staticmethod(lambda c, triage_fn=None: {"tier": "boot"})
        _log_graded_wake = staticmethod(lambda *a: None)

    existing = {"proc": object(), "run_id": "R1"}
    live = {"A1": existing}
    out = notifier_wake_candidate.process_candidate(
        "http://x", {"agent_id": "A1", "alias": "Atlas", "should_wake": True,
                     "reason": "wake"},
        context={"triage": None, "agent_hold_until": {}, "hold_now": 0,
                 "autonomy_level": "plan", "ack_config": None, "ack_key": None},
        dry_run=True, quiet=True, lease_ttl=1200, live_workers=live, services=Svc)
    assert out is None and spawned == [] and live["A1"] is existing
