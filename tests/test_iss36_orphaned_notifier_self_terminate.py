"""Issue #36 — a running notifier daemon self-terminates when its container is gone.

Side-finding from the #36 boot-loop incident: FOUR `orcha notifier` daemons were running at
once, three of them bound to containers that were no longer current. A daemon resolves
(api_base, cid) ONCE at startup and refuses to start on a definitive 404 — but the running
loop never re-checked, so an orphan (container replaced by `orcha up`/`init --force`, or a
stale `.claude/orcha.json` pointing at a previous stack) polled a now-404 container forever
while still reading as a live process in ps.

The fix carries the startup 404-refusal posture through the daemon's whole life: the loop
periodically re-probes and, on a DEFINITIVE 'missing' (HTTP 404 — the API answered and does
not know this container), self-terminates cleanly. A transient 'unreachable' (API down /
booting / mid-restart during `orcha up`) is explicitly tolerated, so a routine API bounce can
never kill a healthy daemon.

Teeth:
  * the predicate (`_container_vanished`) discriminates missing / unreachable / ok;
  * the daemon loop self-terminates on 'missing' (RED if the in-loop probe is removed);
  * the daemon loop does NOT self-terminate on 'unreachable' (RED if the exit is over-eager).
"""
import types

from orcha_cli import notifier  # noqa: E402  (notifier lives in the CLI package)


# ---------- the predicate: only a definitive 404 means "gone" ----------

def test_container_vanished_true_only_on_missing(monkeypatch):
    """A definitive 'missing' (HTTP 404 — the API answered, doesn't know this container) is the
    ONLY verdict that means the daemon is now an orphan."""
    monkeypatch.setattr(notifier, "_probe_container", lambda *a, **k: "missing")
    assert notifier._container_vanished("http://x", "C1") is True


def test_container_vanished_false_on_unreachable(monkeypatch):
    """'unreachable' (API down / booting / mid-restart) is transient — a routine `orcha up` API
    bounce must NEVER look like a vanished container, or it would kill a healthy daemon."""
    monkeypatch.setattr(notifier, "_probe_container", lambda *a, **k: "unreachable")
    assert notifier._container_vanished("http://x", "C1") is False


def test_container_vanished_false_on_ok(monkeypatch):
    """A live container ('ok') obviously isn't gone."""
    monkeypatch.setattr(notifier, "_probe_container", lambda *a, **k: "ok")
    assert notifier._container_vanished("http://x", "C1") is False


# ---------- driving one daemon-loop pass (every other seam mocked) ----------

def _make_args():
    # Both --api-base and --container set ⇒ cmd_notifier resolves them without a config file.
    return types.SimpleNamespace(
        stop=False, restart=False, ensure=False, once=False, quiet=True,
        api_base="http://x", container="C1", dry_run=False, cooldown=0, min_idle=0,
        interval=999, lease_ttl=1200.0, stall_secs=120.0,
    )


def _stub_loop_seams(monkeypatch, tmp_path):
    """Neutralize everything in cmd_notifier except the issue-#36 liveness check."""
    monkeypatch.setattr(notifier, "_load_master_key_from_env_file", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "_pid_path", lambda cwd: tmp_path / "daemon.pid")
    monkeypatch.setattr(notifier, "_global_pid_path", lambda cid: tmp_path / f"{cid}.pid")
    monkeypatch.setattr(notifier, "_write_global_pid", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "reconcile_codex_conversation_runs", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "reap_workers", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "reap_orphan_leases", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "service_residents", lambda *a, **k: None)
    monkeypatch.setattr(notifier, "reap_orphaned_runs", lambda *a, **k: 0)
    monkeypatch.setattr(notifier.signal, "signal", lambda *a, **k: None)
    # Probe every loop pass (production cadence is 60s) so the check fires on iteration one.
    monkeypatch.setattr(notifier, "_DAEMON_LIVENESS_INTERVAL", 0.0)


def _stateful_probe(seq):
    """_probe_container fake: returns seq[0] for the startup probe, seq[1:] thereafter (last
    value sticks). Lets the startup probe pass ('ok') and the in-loop probe go 'missing'/'unreachable'."""
    calls = {"n": 0}

    def _probe(api_base, cid):
        i = calls["n"]
        calls["n"] += 1
        return seq[i] if i < len(seq) else seq[-1]

    return _probe


def test_daemon_self_terminates_when_container_missing(monkeypatch, tmp_path):
    """TEETH: startup probe is 'ok' (so the daemon starts), then the in-loop re-probe returns a
    DEFINITIVE 'missing'. The daemon must break out of its loop and return WITHOUT running a tick —
    i.e. it self-terminates instead of idling against a 404'd container. `tick` raises to bound the
    loop if the liveness check is gone: revert the in-loop probe and this goes RED (tick runs and
    raises KeyboardInterrupt, so cmd_notifier never returns cleanly)."""
    _stub_loop_seams(monkeypatch, tmp_path)
    monkeypatch.setattr(notifier, "_probe_container", _stateful_probe(["ok", "missing"]))

    tick_calls = []

    def _fake_tick(*a, **k):
        tick_calls.append(1)
        raise KeyboardInterrupt  # bound the loop IF liveness didn't already break it

    monkeypatch.setattr(notifier, "tick", _fake_tick)

    exited_cleanly = False
    try:
        notifier.cmd_notifier(_make_args())
        exited_cleanly = True
    except KeyboardInterrupt:
        pass

    assert exited_cleanly, "daemon kept ticking against a 404'd container instead of self-terminating"
    assert tick_calls == [], "daemon ran a wake tick instead of self-terminating on a missing container"


def test_daemon_does_not_self_terminate_when_unreachable(monkeypatch, tmp_path):
    """TEETH (the other side): a transient 'unreachable' (API mid-restart during `orcha up`) must
    NOT trip the self-terminate path — the daemon proceeds to its normal tick. RED if someone makes
    the loop exit on anything but a definitive 404 (it would skip the tick and never reach here)."""
    _stub_loop_seams(monkeypatch, tmp_path)
    monkeypatch.setattr(notifier, "_probe_container", _stateful_probe(["ok", "unreachable"]))

    tick_calls = []

    def _fake_tick(*a, **k):
        tick_calls.append(1)
        raise KeyboardInterrupt  # one pass then stop the loop

    monkeypatch.setattr(notifier, "tick", _fake_tick)

    try:
        notifier.cmd_notifier(_make_args())
    except KeyboardInterrupt:
        pass

    assert tick_calls, "daemon self-terminated on a transient 'unreachable' — that kills healthy daemons"
