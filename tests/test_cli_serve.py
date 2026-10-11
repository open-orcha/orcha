"""GH #258 PR 6 (plan R2): `orcha serve` supervises portal, notifier and bridge.

Fake children are tiny `python -c` processes, and the supervisor's clock is a
counter the test advances, so backoff and crash-loop timing are exact without
sleeping through them. One test runs a real supervisor process and SIGTERMs it.
"""
import json
import os
import pathlib
import signal
import subprocess
import sys
import textwrap
import time
import types

import pytest

from orcha_cli import cli_serve, cli_serve_support as support
from orcha_cli.cli_serve_support import ChildSpec

ORCHA_CLI = pathlib.Path(__file__).resolve().parents[1] / "orcha-cli"


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def _py(code):
    return [sys.executable, "-c", code]


def _native(tmp_path, **extra):
    (tmp_path / ".claude").mkdir(parents=True, exist_ok=True)
    cfg = {"runtime": "native", "project_name": "demo", "api_port": 8123, "bridge_port": 8799, **extra}
    (tmp_path / ".claude" / "orcha.json").write_text(json.dumps(cfg))
    return tmp_path


def _reap(child, timeout=10):
    child.proc.wait(timeout=timeout)


def test_backoff_doubles_to_the_cap_then_crashloops_and_keeps_retrying(tmp_path):
    clock = Clock()
    sup = cli_serve.Supervisor(_native(tmp_path), [ChildSpec("portal", lambda: _py("raise SystemExit(3)"), lambda: True)], clock=clock)
    child = sup.children["portal"]
    delays = []
    for _ in range(12):
        sup.tick()  # spawns
        assert child.proc is not None
        _reap(child)
        sup.tick()  # notices the exit
        assert child.last_exit == 3 and child.proc is None
        delays.append(child.next_start - clock.now)
        clock.now = child.next_start
    assert delays[:6] == [1, 2, 4, 8, 16, 30]
    assert delays[8] == 30  # ninth restart: still plain backoff
    assert delays[9:] == [60, 60, 60]  # tenth restart inside ten minutes: crashlooping, retried every 60 s
    assert child.status == "crashlooping" and child.restarts == 12
    state = json.loads((tmp_path / ".orcha" / "state.json").read_text())
    assert state["children"]["portal"]["status"] == "crashlooping"


def test_backoff_resets_after_a_stable_minute_and_crashloop_clears(tmp_path):
    clock = Clock()
    sup = cli_serve.Supervisor(_native(tmp_path), [ChildSpec("portal", lambda: _py("raise SystemExit(1)"), lambda: True)], clock=clock)
    child = sup.children["portal"]
    child.failures, child.crashlooping = 5, True
    child.recent.extend([clock.now] * 9)
    sup.tick()
    assert child.status == "crashlooping"  # running again, but not yet proven stable
    clock.now += cli_serve.STABLE_SECS
    child.proc.wait(timeout=10)
    child.proc.poll = lambda: None  # pretend it is still up after a stable minute
    sup.tick()
    assert child.status == "running" and not child.crashlooping and child.failures == 0
    child.proc.poll = lambda: 1
    sup.tick()
    assert child.next_start - clock.now == 1  # back to the first backoff step


def test_notifier_and_bridge_wait_for_the_portal(tmp_path):
    clock = Clock()
    portal_up = {"ok": False}
    specs = [
        ChildSpec("portal", lambda: _py("import time; time.sleep(30)"), lambda: portal_up["ok"]),
        ChildSpec("notifier", lambda: _py("import time; time.sleep(30)"), lambda: True),
    ]
    sup = cli_serve.Supervisor(_native(tmp_path), specs, clock=clock, portal_wait=30)
    try:
        sup.tick()
        assert sup.children["portal"].proc is not None
        assert sup.children["notifier"].proc is None
        clock.now += 10
        sup.tick()
        assert sup.children["notifier"].proc is None
        portal_up["ok"] = True
        sup.tick()
        assert sup.children["notifier"].proc is not None
    finally:
        sup.stop()


def test_gate_opens_after_the_portal_wait_even_if_it_never_answers(tmp_path):
    clock = Clock()
    specs = [
        ChildSpec("portal", lambda: _py("import time; time.sleep(30)"), lambda: False),
        ChildSpec("bridge", lambda: _py("import time; time.sleep(30)"), lambda: True),
    ]
    sup = cli_serve.Supervisor(_native(tmp_path), specs, clock=clock, portal_wait=30)
    try:
        sup.tick()
        clock.now += 30
        sup.tick()
        assert sup.children["bridge"].proc is not None
    finally:
        sup.stop()


def test_child_that_cannot_start_yet_waits_and_retries(tmp_path):
    clock = Clock()
    argv = {"value": None}
    sup = cli_serve.Supervisor(_native(tmp_path), [ChildSpec("notifier", lambda: argv["value"], lambda: True)], clock=clock)
    sup.tick()
    assert sup.children["notifier"].status == "waiting"
    argv["value"] = _py("pass")
    sup.tick()
    assert sup.children["notifier"].proc is None  # not due yet
    clock.now += cli_serve.NOT_READY_RETRY_SECS
    sup.tick()
    assert sup.children["notifier"].proc is not None
    _reap(sup.children["notifier"])


def test_child_output_lands_in_its_rotating_log(tmp_path):
    sup = cli_serve.Supervisor(_native(tmp_path), [ChildSpec("bridge", lambda: _py("print('hello from bridge')"), lambda: True)], clock=Clock())
    sup.tick()
    _reap(sup.children["bridge"])
    log = tmp_path / ".orcha" / "logs" / "bridge.log"
    for _ in range(50):
        if log.exists() and "hello from bridge" in log.read_text():
            break
        time.sleep(0.05)
    assert "hello from bridge" in log.read_text()
    handler = support.rotating_logger(tmp_path, "bridge").handlers[0]
    assert (handler.maxBytes, handler.backupCount) == (10 * 2**20, 5)
    assert "started bridge pid" in (tmp_path / ".orcha" / "logs" / "serve.log").read_text()


def test_stop_sigterms_then_sigkills_a_child_that_ignores_it(tmp_path, monkeypatch):
    monkeypatch.setattr(cli_serve, "STOP_GRACE_SECS", 1.0)
    polite = "import signal,sys,time; signal.signal(signal.SIGTERM, lambda *a: sys.exit(0)); print('up', flush=True); time.sleep(60)"
    stubborn = "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print('up', flush=True); time.sleep(60)"
    sup = cli_serve.Supervisor(_native(tmp_path), [
        ChildSpec("portal", lambda: _py(polite), lambda: True),
        ChildSpec("notifier", lambda: _py(stubborn), lambda: True),
    ])
    sup.tick()
    procs = {n: c.proc for n, c in sup.children.items()}
    time.sleep(0.5)  # let both install their handlers
    sup.stop()
    assert procs["portal"].returncode == 0
    assert procs["notifier"].returncode == -signal.SIGKILL
    state = json.loads((tmp_path / ".orcha" / "state.json").read_text())
    assert state["status"] == "stopped" and state["serve_pid"] is None
    assert {c["pid"] for c in state["children"].values()} == {None}


def test_state_file_shape(tmp_path):
    sup = cli_serve.Supervisor(_native(tmp_path, bind="lan"), [ChildSpec("portal", lambda: _py("import time; time.sleep(30)"), lambda: True)], clock=Clock())
    try:
        sup.tick()
        state = support.read_state(tmp_path)
        assert set(state) == {"runtime", "status", "serve_pid", "children", "api_port", "bridge_port",
                              "bind", "started_at", "updated_at", "cli_version", "db_path"}
        assert state["runtime"] == "native" and state["status"] == "running"
        assert state["serve_pid"] == os.getpid()
        assert state["children"]["portal"] == {"pid": sup.children["portal"].proc.pid, "status": "running",
                                               "restarts": 0, "last_exit": None}
        assert (state["api_port"], state["bridge_port"], state["bind"]) == (8123, 8799, "lan")
        assert state["db_path"] == str(tmp_path / ".orcha" / "orcha.db")
        assert not list((tmp_path / ".orcha").glob(".state.*.tmp"))
    finally:
        sup.stop()


def test_child_specs_use_this_interpreter_and_current_config(tmp_path):
    root = _native(tmp_path)
    specs = {s.name: s for s in support.child_specs(root)}
    assert specs["portal"].argv() == [sys.executable, "-m", "orcha_cli", "portal", "--project-dir", str(root)]
    assert specs["notifier"].argv() is None  # no container yet
    _native(tmp_path, current_container_id="c-1")
    assert specs["notifier"].argv() == [sys.executable, "-m", "orcha_cli", "notifier", "--quiet", "--container", "c-1"]
    assert specs["bridge"].argv()[-2:] == ["--port", "8799"]
    assert [s.name for s in support.child_specs(root, no_bridge=True)] == ["portal", "notifier"]


def test_heartbeat_fresh(tmp_path):
    (tmp_path / ".claude").mkdir()
    assert support.heartbeat_fresh(tmp_path) is False
    (tmp_path / ".claude" / ".orcha-notifier.hb").write_text(f"123 {time.time()}")
    assert support.heartbeat_fresh(tmp_path) is True
    assert support.heartbeat_fresh(tmp_path, now=time.time() + 1000) is False


def test_cmd_serve_refuses_docker_projects_and_a_second_supervisor(tmp_path, monkeypatch):
    (tmp_path / "d" / ".orcha").mkdir(parents=True)
    (tmp_path / "d" / ".orcha" / "docker-compose.yml").write_text("name: x\n")
    with pytest.raises(SystemExit, match="runs on Docker"):
        cli_serve.cmd_serve(types.SimpleNamespace(project_dir=str(tmp_path / "d"), no_bridge=False))
    root = _native(tmp_path / "n")
    sleeper = subprocess.Popen(_py("import time; time.sleep(30)"))
    try:
        support.write_state(root, {"status": "running", "serve_pid": sleeper.pid})
        with pytest.raises(SystemExit, match=f"already running for this project \\(pid {sleeper.pid}\\)"):
            cli_serve.cmd_serve(types.SimpleNamespace(project_dir=str(root), no_bridge=False))
    finally:
        sleeper.kill()
        sleeper.wait()


def test_real_supervisor_fans_sigterm_out_to_every_child(tmp_path):
    root = _native(tmp_path)
    script = textwrap.dedent(f"""
        import sys
        sys.path.insert(0, {str(ORCHA_CLI)!r})
        from orcha_cli.cli_serve import Supervisor
        from orcha_cli.cli_serve_support import ChildSpec
        sleep = [sys.executable, "-c", "import time; time.sleep(120)"]
        specs = [ChildSpec(n, lambda: sleep, lambda: True) for n in ("portal", "notifier", "bridge")]
        sys.exit(Supervisor({str(root)!r}, specs).run())
    """)
    serve = subprocess.Popen([sys.executable, "-c", script])
    try:
        pids = []
        for _ in range(100):
            state = support.read_state(root)
            pids = [c.get("pid") for c in state.get("children", {}).values()]
            if len(pids) == 3 and all(pids):
                break
            time.sleep(0.1)
        assert len(pids) == 3 and all(pids), state
        serve.send_signal(signal.SIGTERM)
        assert serve.wait(timeout=15) == 0
        for pid in pids:
            with pytest.raises(ProcessLookupError):
                os.kill(pid, 0)
        assert support.read_state(root)["status"] == "stopped"
    finally:
        if serve.poll() is None:
            serve.kill()


# --- #297: follow a reinstalled/updated orcha-cli without `orcha upgrade` -------------

SLEEPER = "import time; time.sleep(60)"


def _following(tmp_path, *, idle):
    clock = Clock()
    fp = {"v": (("a", 1),)}
    specs = [ChildSpec(n, lambda: _py(SLEEPER), lambda: True) for n in ("portal", "notifier", "bridge")]
    sup = cli_serve.Supervisor(_native(tmp_path), specs, clock=clock,
                               fingerprint=lambda: fp["v"], idle=lambda: idle["v"])
    for _ in range(3):
        sup.tick()
    assert all(c.proc is not None for c in sup.children.values())
    return sup, clock, fp


def _advance(sup, clock, secs):
    clock.now += secs
    sup.tick()


def _pids(sup):
    return {n: c.proc.pid if c.proc else None for n, c in sup.children.items()}


def _settle_update(sup, clock, fp):
    fp["v"] = (("b", 2),)
    _advance(sup, clock, cli_serve.INSTALL_CHECK_SECS)  # first sight of the new install
    _advance(sup, clock, cli_serve.INSTALL_SETTLE_SECS)  # unchanged since: settled


def _wait_exit(child):
    if child.proc is not None:
        child.proc.wait(timeout=10)


def test_update_restarts_portal_and_idle_notifier_but_never_the_bridge(tmp_path):
    idle = {"v": True}
    sup, clock, fp = _following(tmp_path, idle=idle)
    before = _pids(sup)
    try:
        _settle_update(sup, clock, fp)  # SIGTERMs the portal and, being idle, the notifier
        _wait_exit(sup.children["portal"])
        _wait_exit(sup.children["notifier"])
        for _ in range(3):
            _advance(sup, clock, cli_serve.TICK_SECS)
        after = _pids(sup)
        assert after["portal"] not in (None, before["portal"])
        assert after["notifier"] not in (None, before["notifier"])
        assert after["bridge"] == before["bridge"]  # open terminals survive the update
        portal = sup.children["portal"]
        assert portal.failures == 0 and not portal.crashlooping  # planned, not a crash
        assert sup.stale == {}
    finally:
        sup.stop()


def test_notifier_waits_for_agent_runs_to_finish(tmp_path):
    idle = {"v": False}
    sup, clock, fp = _following(tmp_path, idle=idle)
    notifier_pid = sup.children["notifier"].proc.pid
    try:
        _settle_update(sup, clock, fp)
        for _ in range(4):
            _advance(sup, clock, cli_serve.INSTALL_CHECK_SECS)
        assert sup.children["notifier"].proc.pid == notifier_pid  # an agent is mid-run
        assert "notifier" in sup.stale
        idle["v"] = True
        _advance(sup, clock, cli_serve.INSTALL_CHECK_SECS)
        _wait_exit(sup.children["notifier"])
        for _ in range(3):
            _advance(sup, clock, cli_serve.TICK_SECS)
        assert sup.children["notifier"].proc.pid != notifier_pid
    finally:
        sup.stop()


def test_a_half_written_install_is_left_alone(tmp_path):
    sup, clock, fp = _following(tmp_path, idle={"v": True})
    before = _pids(sup)
    try:
        fp["v"] = (None,)  # files missing while uv rewrites the package
        for _ in range(4):
            _advance(sup, clock, cli_serve.INSTALL_CHECK_SECS)
        assert _pids(sup) == before and sup.stale == {}
    finally:
        sup.stop()


def test_install_fingerprint_tracks_the_sentinels(tmp_path):
    for rel in support.INSTALL_SENTINELS:
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / rel).write_text("v1")
    first = support.install_fingerprint(tmp_path)
    assert None not in first
    index = tmp_path / support.INSTALL_SENTINELS[-1]
    index.write_text("v2 with a new bundle name")
    assert support.install_fingerprint(tmp_path) != first
    index.unlink()
    assert support.install_fingerprint(tmp_path)[-1] is None


def test_agents_idle_is_busy_when_the_portal_cannot_answer(tmp_path):
    root = _native(tmp_path, current_container_id="c1", api_port=1)  # nothing listens on :1
    assert support.agents_idle(root) is False
    assert support.agents_idle(_native(tmp_path / "fresh")) is True  # no container yet
