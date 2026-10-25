"""GH #315: worktree housekeeping must never hold up the wake scan or the heartbeat.

The portal chip reads "Not running" when no wake scan reached the server for 120 s
(RUNTIME_SERVED_WINDOW_SECS in container_snapshot_routes.py). On main the daemon loop ran
``notifier_worktree_gc.service_worktrees`` (inventory / sweep: git + du per worktree, 20+ min
with thousands of worktrees) synchronously right before ``tick()``, so a slow pass stopped both
the scan and the heartbeat. These tests drive the real ``cmd_notifier`` loop on a thread with
every network seam stubbed and housekeeping stubbed to block past the 120 s window (a fake wall
clock jumps 130 s while it is blocked) — no live daemon, no portal.

Run: .venv-test/bin/python -m pytest -p no:cacheprovider tests/test_gh315_housekeeping_off_scan_loop.py
"""
import os
import threading
import time
import types

import pytest

from orcha_cli import notifier  # noqa: E402 (conftest puts orcha-cli on sys.path)
from orcha_cli import notifier_preview
from orcha_cli import notifier_request_sweep
from orcha_cli import notifier_routines
from orcha_cli import notifier_verdikt_sweep
from orcha_cli import notifier_worktree_gc
from orcha_cli import worktree_gc

try:  # new in the fix; the repro test above does not need it, so it still runs on main
    from orcha_cli import notifier_housekeeper as hkmod
except ImportError:  # pragma: no cover - main e5f9add7
    hkmod = None

# On main e5f9add7 only the repro test (and the daemon-level ones) run; these skip there.
needs_fix = pytest.mark.skipif(hkmod is None, reason="notifier_housekeeper is new in the fix")

CID = "c315"
CHIP_WINDOW_S = 120.0  # RUNTIME_SERVED_WINDOW_SECS
HK_THREAD = "orcha-worktree-gc"


def _ws(tmp_path):
    (tmp_path / ".claude").mkdir(parents=True, exist_ok=True)
    return tmp_path


class _Clocks:
    """Real clocks plus a forward-only offset, so a stub can make time 'pass'."""

    def __init__(self, monkeypatch):
        self.wall = 0.0
        self.mono = 0.0
        real_time, real_mono = time.time, time.monotonic
        monkeypatch.setattr(time, "time", lambda: real_time() + self.wall)
        monkeypatch.setattr(time, "monotonic", lambda: real_mono() + self.mono)


class _Daemon:
    """``cmd_notifier`` on a thread, every network seam stubbed; ``stop()`` = SIGTERM."""

    def __init__(self, monkeypatch, tmp_path, *, tick, housekeeping):
        self.ws = _ws(tmp_path)
        monkeypatch.chdir(self.ws)
        self.handlers = []
        self.heartbeats = []
        self.housekeeping_running = lambda: False
        real_hb = notifier._write_heartbeat

        def _hb(cwd):
            self.heartbeats.append(self.housekeeping_running())
            real_hb(cwd)

        for name, value in {
            "_load_master_key_from_env_file": lambda *a, **k: None,
            "_write_global_pid": lambda *a, **k: None,
            "_global_pid_path": lambda cid: tmp_path / "claim.pid",
            "reconcile_codex_conversation_runs": lambda *a, **k: None,
            "reap_workers": lambda *a, **k: None,
            "reap_orphan_leases": lambda *a, **k: None,
            "reap_orphaned_runs": lambda *a, **k: 0,
            "live_sandbox_shield": lambda *a, **k: frozenset(),
            "reap_terminal_task_worktrees": lambda *a, **k: None,
            "service_residents": lambda *a, **k: None,
            "_probe_container": lambda *a, **k: "ok",
            "_container_vanished": lambda *a, **k: False,
            "_superseded_by": lambda *a, **k: None,
            "_pump_one": lambda *a, **k: False,
            "_write_heartbeat": _hb,
            "tick": tick,
        }.items():
            monkeypatch.setattr(notifier, name, value)
        monkeypatch.setattr(notifier.signal, "signal", lambda sig, fn: self.handlers.append(fn))
        monkeypatch.setattr(notifier_routines, "maybe_fire_routines", lambda *a, **k: None)
        monkeypatch.setattr(notifier_request_sweep, "maybe_sweep_expired", lambda *a, **k: None)
        monkeypatch.setattr(notifier_preview, "service_previews", lambda *a, **k: None)
        monkeypatch.setattr(notifier_preview, "stop_all", lambda *a, **k: None)
        monkeypatch.setattr(notifier_verdikt_sweep, "maybe_sweep", lambda *a, **k: None)
        monkeypatch.setattr(notifier_worktree_gc, "service_worktrees", housekeeping)
        self.args = types.SimpleNamespace(
            stop=False, restart=False, ensure=False, once=False, quiet=True,
            api_base="http://x", container=CID, dry_run=True, cooldown=0, min_idle=0,
            interval=0.02, lease_ttl=1200.0, stall_secs=120.0,
        )
        self.thread = threading.Thread(target=notifier.cmd_notifier, args=(self.args,),
                                       name="test-daemon", daemon=True)

    def start(self):
        self.thread.start()
        return self

    def stop(self, timeout=5.0):
        deadline = time.perf_counter() + 2.0
        while not self.handlers and time.perf_counter() < deadline:
            time.sleep(0.01)
        for fn in self.handlers[:1]:
            fn(15, None)
        self.thread.join(timeout)
        return not self.thread.is_alive()


def _wait_for(pred, secs):
    deadline = time.perf_counter() + secs
    while time.perf_counter() < deadline:
        if pred():
            return True
        time.sleep(0.01)
    return pred()


def _blocking_housekeeping(clocks, blocks=1):
    """First call(s) jump the wall clock past the chip window, then block until released."""
    hk = {"calls": 0, "running": 0, "max_running": 0, "release": threading.Event(),
          "started": threading.Event()}
    lock = threading.Lock()

    def _service_worktrees(*a, **k):
        with lock:
            hk["calls"] += 1
            n = hk["calls"]
            hk["running"] += 1
            hk["max_running"] = max(hk["max_running"], hk["running"])
        try:
            if n <= blocks:
                clocks.wall += CHIP_WINDOW_S + 10
                hk["started"].set()
                hk["release"].wait(10)
        finally:
            with lock:
                hk["running"] -= 1

    return hk, _service_worktrees


def _hk_threads():
    return [t for t in threading.enumerate() if t.name == HK_THREAD and t.is_alive()]


# ---------- DoD 1 + 2: the repro (fails on main e5f9add7) ----------

def test_scan_and_heartbeat_keep_going_while_housekeeping_is_blocked(monkeypatch, tmp_path):
    """REPRO. Housekeeping blocks for longer than the 120 s chip window. On main the loop ran it
    synchronously before tick(), so zero scans and zero heartbeats landed until it finished and
    --ensure read the heartbeat as stale (wedged). Fixed: the scan keeps its cadence, the
    heartbeat stays fresh, and housekeeping is never entered twice at once.
    Mutation: call service_worktrees inline again in the loop → RED (0 scans while blocked)."""
    clocks = _Clocks(monkeypatch)
    hk, housekeeping = _blocking_housekeeping(clocks)
    scans = []
    d = _Daemon(monkeypatch, tmp_path, tick=lambda *a, **k: scans.append(hk["running"] > 0),
                housekeeping=housekeeping)
    d.housekeeping_running = lambda: hk["running"] > 0
    d.start()
    try:
        assert hk["started"].wait(5), "housekeeping never started"
        _wait_for(lambda: scans.count(True) >= 3 and d.heartbeats.count(True) >= 3, 3.0)
        scans_while_blocked = scans.count(True)
        heartbeats_while_blocked = d.heartbeats.count(True)
        verdict = notifier._heartbeat_verdict(d.ws, os.getpid())
    finally:
        hk["release"].set()
        stopped = d.stop()
    assert scans_while_blocked >= 3, (
        f"{scans_while_blocked} wake scans while worktree housekeeping was blocked — the chip "
        f"would read 'Not running' (GH #315)")
    assert heartbeats_while_blocked >= 3, (
        f"{heartbeats_while_blocked} heartbeats while housekeeping was blocked")
    assert verdict is True, "--ensure would judge the daemon wedged during a slow housekeeping pass"
    assert hk["max_running"] == 1
    assert stopped, "the daemon did not stop"


# ---------- DoD 2: clean shutdown ----------

def test_housekeeping_thread_stops_with_the_daemon(monkeypatch, tmp_path):
    """SIGTERM ends the loop and the housekeeping thread with it.
    Mutation: drop housekeeper.stop() from the daemon's finally → RED (thread still alive)."""
    passes = []
    d = _Daemon(monkeypatch, tmp_path, tick=lambda *a, **k: None,
                housekeeping=lambda *a, **k: passes.append(1))
    d.start()
    assert _wait_for(lambda: len(passes) >= 2, 5.0), "housekeeping never ran"
    assert d.stop(), "the daemon did not stop"
    assert _wait_for(lambda: not _hk_threads(), 3.0), "the housekeeping thread outlived the daemon"


def test_a_blocked_housekeeping_pass_does_not_hold_up_daemon_exit(monkeypatch, tmp_path):
    """Stopping while a pass is stuck in git/du returns promptly (bounded join; the thread is a
    daemon thread so it cannot keep the process alive). Mutation: join without a timeout → RED."""
    clocks = _Clocks(monkeypatch)
    hk, housekeeping = _blocking_housekeeping(clocks)
    d = _Daemon(monkeypatch, tmp_path, tick=lambda *a, **k: None, housekeeping=housekeeping)
    d.start()
    try:
        assert hk["started"].wait(5)
        t0 = time.perf_counter()
        assert d.stop(timeout=6.0), "the daemon waited for the stuck housekeeping pass"
        assert time.perf_counter() - t0 < 5.0
        assert all(t.daemon for t in _hk_threads())
    finally:
        hk["release"].set()
    assert _wait_for(lambda: not _hk_threads(), 3.0)
    assert hk["calls"] == 1, "a new housekeeping pass started after the daemon stopped"


def test_the_daemon_hands_housekeeping_its_live_busy_worktrees_and_flags(monkeypatch, tmp_path):
    """The housekeeping thread cannot read the loop's dicts, so each poke carries a snapshot of
    the worktrees the loop's own workers use. Pin the wiring end to end through cmd_notifier: a
    worker the scan started shows up in the next pass's ``busy``, and dry_run / quiet pass through.
    Mutations: poke(()) / drop busy=busy / force dry_run=False in the lambda → RED."""
    seen = []
    worker_wt = str(tmp_path / ".orcha-worktrees" / "wk-Atlas-1790000000319")

    def _tick(*a, **k):  # the scan spawns a worker into the loop's live_workers dict
        k["live_workers"].setdefault("w1", {"worktree": worker_wt})

    d = _Daemon(monkeypatch, tmp_path, tick=_tick,
                housekeeping=lambda *a, **k: seen.append((a, dict(k))))
    d.start()
    try:
        assert _wait_for(lambda: any(worker_wt in (k.get("busy") or ()) for _, k in seen), 5.0), \
            f"the live worker's worktree never reached housekeeping: {seen[-1:] or 'no pass'}"
    finally:
        assert d.stop()
    a, k = next((a, k) for a, k in seen if worker_wt in (k.get("busy") or ()))
    assert a[:2] == ("http://x", CID) and a[2] is notifier_worktree_gc.STATE
    assert k["dry_run"] is d.args.dry_run is True and k["quiet"] is True
    assert "timer" in k and "live_workers" not in k  # never the loop's live dicts


# ---------- DoD 3: one lifecycle line for a slow loop pass ----------

def test_slow_loop_pass_logs_one_timestamped_line_with_stage_times(monkeypatch, tmp_path, capsys):
    """A loop pass over 60 s writes ONE timestamped lifecycle line (even under --quiet) naming
    each stage's seconds; fast passes write none. Mutation: drop the slow-pass log → RED."""
    clocks = _Clocks(monkeypatch)
    ticks = []

    def _tick(*a, **k):
        ticks.append(1)
        if len(ticks) == 1:
            clocks.mono += 75.0  # this scan "took" 75 s

    d = _Daemon(monkeypatch, tmp_path, tick=_tick, housekeeping=lambda *a, **k: None)
    d.start()
    assert _wait_for(lambda: len(ticks) >= 4, 5.0)
    assert d.stop()
    lines = [ln for ln in capsys.readouterr().err.splitlines() if "slow loop pass" in ln]
    assert len(lines) == 1, lines
    line = lines[0]
    assert line.startswith("[notifier 20") and line.split("]")[0].endswith("Z")
    for stage in ("reaps", "residents", "routines", "requests", "previews", "verdikt",
                  "worktrees", "scan 75"):
        assert stage in line, (stage, line)


# ---------- Housekeeper unit tests (fake clock, no daemon) ----------

class _FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


@needs_fix
def test_housekeeper_never_runs_two_passes_at_once_and_coalesces_pokes():
    """Pokes during a running pass never start a second one; they coalesce into ONE follow-up.
    Mutation: start a thread per poke → RED (max concurrency 2+ / extra passes)."""
    release, entered = threading.Event(), threading.Event()
    state = {"running": 0, "max": 0, "passes": 0}
    lock = threading.Lock()

    def _pass(busy, timer):
        with lock:
            state["running"] += 1
            state["passes"] += 1
            state["max"] = max(state["max"], state["running"])
        entered.set()
        release.wait(5)
        with lock:
            state["running"] -= 1

    h = hkmod.Housekeeper(_pass, log=lambda m: None).start()
    try:
        h.poke({"/a"})
        assert entered.wait(5)
        for _ in range(20):
            h.poke({"/b"})
        time.sleep(0.1)
        assert state["passes"] == 1 and h.busy_for() is not None
        release.set()
        assert _wait_for(lambda: state["passes"] == 2 and h.busy_for() is None, 5.0)
        time.sleep(0.1)
        assert state["passes"] == 2, "20 pokes during one pass must coalesce into one follow-up"
        assert state["max"] == 1
    finally:
        release.set()
        assert h.stop()


@needs_fix
def test_housekeeper_passes_the_latest_busy_snapshot():
    seen = []
    h = hkmod.Housekeeper(lambda busy, timer: seen.append(busy), log=lambda m: None).start()
    try:
        h.poke({"/wt/one"})
        assert _wait_for(lambda: seen, 5.0)
        assert seen[0] == frozenset({"/wt/one"})
    finally:
        assert h.stop()


@needs_fix
def test_housekeeper_survives_a_failing_pass():
    calls = []

    def _pass(busy, timer):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("git exploded")

    h = hkmod.Housekeeper(_pass, log=lambda m: None).start()
    try:
        h.poke(())
        assert _wait_for(lambda: len(calls) == 1 and h.busy_for() is None, 5.0)
        h.poke(())
        assert _wait_for(lambda: len(calls) == 2, 5.0), "one failing pass killed the thread"
    finally:
        assert h.stop()


@needs_fix
def test_housekeeper_stop_is_clean_and_starts_no_new_pass():
    calls = []
    h = hkmod.Housekeeper(lambda busy, timer: calls.append(1), log=lambda m: None).start()
    assert h.stop()
    h.poke(())
    time.sleep(0.1)
    assert calls == [] and not _hk_threads()


@needs_fix
def test_slow_housekeeping_pass_logs_one_line_with_inventory_and_sweep_times():
    """DoD 3 for the housekeeping side: >60 s → one line naming claim/actions/sweep/inventory
    seconds and the worktree count; a fast pass → no line. Mutation: drop the log → RED."""
    clock, lines = _FakeClock(), []

    def _slow(busy, timer):
        clock.t += 0.5
        timer.lap("claim")
        timer.lap("actions")
        clock.t += 610
        timer.lap("sweep")
        clock.t += 623
        timer.lap("inventory")
        timer.note("worktrees", 2458)

    h = hkmod.Housekeeper(_slow, log=lines.append, clock=clock)
    h.run_one(frozenset())
    assert len(lines) == 1
    line = lines[0]
    assert "slow worktree housekeeping pass" in line and "1234s" in line, line
    for part in ("claim 0.5s", "actions 0.0s", "sweep 610s", "inventory 623s", "2458 worktrees",
                 "wake scan"):
        assert part in line, (part, line)

    def _fast(busy, timer):
        clock.t += 3
        timer.lap("inventory")

    h2 = hkmod.Housekeeper(_fast, log=lines.append, clock=clock)
    h2.run_one(frozenset())
    assert len(lines) == 1, "a fast pass must not log"


@needs_fix
def test_stage_timer_breakdown():
    clock = _FakeClock()
    t = hkmod.StageTimer(clock)
    clock.t += 1.26
    t.lap("reaps")
    clock.t += 70
    t.lap("scan")
    assert round(t.total()) == 71
    assert t.breakdown() == "reaps 1.3s, scan 70s"


# ---------- service_worktrees records its stages and honours the busy snapshot ----------

@needs_fix
def test_service_worktrees_laps_claim_actions_sweep_inventory(monkeypatch, tmp_path):
    clock = _FakeClock()
    state = notifier_worktree_gc.GcState()
    state.started = clock.t - 3600
    posts, inv_busy = [], []

    def _post(url, body, timeout=8.0):
        posts.append(url)
        if url.endswith("/claim"):
            return {"settings": {"auto_cleanup": True, "grace_days": 7}, "busy_worktrees": ["/r"]}
        return {}

    def _inventory(base, *, busy=(), measure=True, size_cache=None, **k):
        inv_busy.append(set(busy))
        clock.t += 40
        return [{"path": "/wt/a", "name": "a", "state": worktree_gc.STATE_UNMERGED}]

    monkeypatch.setattr(worktree_gc, "inventory", _inventory)
    monkeypatch.setattr(worktree_gc, "first_seen", lambda *a, **k: {})
    timer = hkmod.StageTimer(clock)
    notifier_worktree_gc.service_worktrees(
        "http://x", CID, state, str(tmp_path), post=_post, clock=clock, timer=timer,
        busy=frozenset({"/local"}))
    names = [name for name, _ in timer.laps]
    assert names == ["claim", "actions", "sweep", "inventory"], names
    assert dict(timer.laps)["sweep"] == 40 and dict(timer.laps)["inventory"] == 40
    assert timer.notes.get("worktrees") == 1
    assert inv_busy and all(b == {"/local", "/r"} for b in inv_busy)
