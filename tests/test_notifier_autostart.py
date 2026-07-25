"""Notifier login-autostart (launchd LaunchAgent) — install/uninstall lifecycle.

Covers the reboot-persistence gap (task c6497477): `orcha notifier --ensure` only
helps while something calls it, so ensure now installs a per-container LaunchAgent
watchdog (RunAtLoad + StartInterval) and an explicit stop removes it.

Everything host-touching is monkeypatched through autostart.py's seams
(`_platform`, `_which`, `_launchctl`, `_launch_agents_dir`) — no test here may
ever call the real launchctl or write under the real ~/Library/LaunchAgents
(conftest additionally exports ORCHA_NO_AUTOSTART=1 for the rest of the suite).
"""
import argparse
import json
import pathlib
import plistlib
import subprocess

import pytest

from orcha_cli import __main__ as cli  # noqa: E402  (conftest puts orcha-cli on sys.path)
from orcha_cli import autostart, notifier

CID = "cafebabe-0000-4000-8000-000000000001"


class FakeLaunchctl:
    """Records launchctl invocations and models the loaded-label set."""

    def __init__(self):
        self.calls = []
        self.loaded = set()

    def __call__(self, *args):
        self.calls.append(args)
        verb = args[0]
        if verb == "print":
            label = args[1].rsplit("/", 1)[1]
            return subprocess.CompletedProcess(args, 0 if label in self.loaded else 3, "", "")
        if verb == "bootstrap":
            label = pathlib.Path(args[2]).stem
            self.loaded.add(label)
            return subprocess.CompletedProcess(args, 0, "", "")
        if verb == "bootout":
            label = args[1].rsplit("/", 1)[1]
            rc = 0 if label in self.loaded else 3
            self.loaded.discard(label)
            return subprocess.CompletedProcess(args, rc, "", "")
        return subprocess.CompletedProcess(args, 1, "", "unknown verb")

    def verbs(self):
        return [c[0] for c in self.calls]


def _make_project(root: pathlib.Path, cid: str = CID, name: str | None = None) -> pathlib.Path:
    (root / ".claude").mkdir(parents=True, exist_ok=True)
    (root / ".claude" / "orcha.json").write_text(
        json.dumps({"current_container_id": cid, "api_base_url": "http://localhost:9/api",
                    "project_name": name or root.name})
    )
    return root


@pytest.fixture
def project(tmp_path):
    return _make_project(tmp_path / "proj")


@pytest.fixture
def mac(monkeypatch, tmp_path):
    """Simulate a darwin host with a recorded launchctl and a sandboxed LaunchAgents dir."""
    fake = FakeLaunchctl()
    monkeypatch.delenv("ORCHA_NO_AUTOSTART", raising=False)
    monkeypatch.setattr(autostart, "_platform", lambda: "darwin")
    monkeypatch.setattr(
        autostart, "_which",
        lambda name: {"launchctl": "/bin/launchctl", "orcha": "/usr/local/bin/orcha"}.get(name),
    )
    monkeypatch.setattr(autostart, "_launchctl", fake)
    agents_dir = tmp_path / "LaunchAgents"
    monkeypatch.setattr(autostart, "_launch_agents_dir", lambda: agents_dir)
    return fake


# ---------- install ----------

def test_install_writes_plist_and_loads(mac, project):
    assert autostart.install_autostart(project, CID) is True
    path = autostart.plist_path(CID)
    assert path.exists()
    data = plistlib.loads(path.read_bytes())
    assert data["Label"] == f"io.openorcha.notifier.{CID}"
    assert data["ProgramArguments"] == ["/usr/local/bin/orcha", "notifier", "--ensure", "--quiet"]
    assert data["WorkingDirectory"] == str(project)
    assert data["RunAtLoad"] is True
    assert data["StartInterval"] == autostart._START_INTERVAL
    assert "bootstrap" in mac.verbs()
    assert data["Label"] in mac.loaded


def test_install_is_idempotent_and_cheap(mac, project):
    autostart.install_autostart(project, CID)
    before = autostart.plist_path(CID).read_bytes()
    mac.calls.clear()
    assert autostart.install_autostart(project, CID) is True
    # unchanged content + already loaded ⇒ exactly one read-only `print`, no reload
    assert mac.verbs() == ["print"]
    assert autostart.plist_path(CID).read_bytes() == before


def test_install_reloads_if_agent_was_booted_out(mac, project):
    autostart.install_autostart(project, CID)
    mac.loaded.clear()  # e.g. the user ran `launchctl bootout` by hand
    mac.calls.clear()
    assert autostart.install_autostart(project, CID) is True
    assert "bootstrap" in mac.verbs()


def test_install_keeps_existing_valid_root(mac, project, tmp_path):
    """A second checkout (worktree) of the same container must not steal the agent —
    only one daemon per container exists, and churn would flap WorkingDirectory."""
    autostart.install_autostart(project, CID)
    other = _make_project(tmp_path / "worktree")
    assert autostart.install_autostart(other, CID) is True
    data = plistlib.loads(autostart.plist_path(CID).read_bytes())
    assert data["WorkingDirectory"] == str(project)


def test_install_rewrites_when_recorded_root_is_stale(mac, project, tmp_path):
    autostart.install_autostart(project, CID)
    (project / ".claude" / "orcha.json").unlink()  # old checkout is gone/retired
    other = _make_project(tmp_path / "fresh")
    assert autostart.install_autostart(other, CID) is True
    data = plistlib.loads(autostart.plist_path(CID).read_bytes())
    assert data["WorkingDirectory"] == str(other)
    assert "bootout" in mac.verbs() and "bootstrap" in mac.verbs()


def test_install_noop_when_opted_out_or_unsupported(mac, project, monkeypatch):
    monkeypatch.setenv("ORCHA_NO_AUTOSTART", "1")
    assert autostart.install_autostart(project, CID) is False
    monkeypatch.delenv("ORCHA_NO_AUTOSTART")
    monkeypatch.setattr(autostart, "_platform", lambda: "linux")
    assert autostart.install_autostart(project, CID) is False
    assert not autostart.plist_path(CID).exists()
    assert mac.calls == []


def test_install_requires_container_id(mac, project):
    assert autostart.install_autostart(project, None) is False
    assert mac.calls == []


def test_install_failure_is_best_effort(mac, project, monkeypatch):
    monkeypatch.setattr(autostart, "_launchctl", lambda *a: None)  # launchctl unusable
    assert autostart.install_autostart(project, CID) is False  # no exception escapes


# ---------- uninstall ----------

def test_uninstall_boots_out_and_removes_plist(mac, project):
    autostart.install_autostart(project, CID)
    assert autostart.uninstall_autostart(CID) is True
    assert not autostart.plist_path(CID).exists()
    assert f"io.openorcha.notifier.{CID}" not in mac.loaded


def test_uninstall_idempotent(mac):
    assert autostart.uninstall_autostart(CID) is False  # nothing installed


def test_uninstall_ignores_optout_env(mac, project, monkeypatch):
    """ORCHA_NO_AUTOSTART set AFTER an agent was installed must not strand it —
    a leftover watchdog would resurrect the daemon despite the opt-out."""
    autostart.install_autostart(project, CID)
    monkeypatch.setenv("ORCHA_NO_AUTOSTART", "1")
    assert autostart.uninstall_autostart(CID) is True
    assert not autostart.plist_path(CID).exists()
    assert f"io.openorcha.notifier.{CID}" not in mac.loaded


# ---------- wiring: ensure_daemon / stop_daemon ----------

@pytest.fixture
def record_autostart(monkeypatch):
    calls = {"install": [], "uninstall": []}
    monkeypatch.setattr(notifier.autostart, "install_autostart",
                        lambda cwd, cid, quiet=True: calls["install"].append((cwd, cid)) or True)
    monkeypatch.setattr(notifier.autostart, "uninstall_autostart",
                        lambda cid, quiet=True: calls["uninstall"].append(cid) or True)
    return calls


def test_ensure_daemon_installs_autostart_when_already_running(project, record_autostart, monkeypatch):
    monkeypatch.setattr(notifier, "daemon_running", lambda cwd: 4242)
    assert notifier.ensure_daemon(project, quiet=True) is True
    assert record_autostart["install"] == [(project, CID)]


def test_ensure_daemon_installs_autostart_on_spawn(project, record_autostart, monkeypatch, tmp_path):
    monkeypatch.setattr(notifier, "daemon_running", lambda cwd: None)
    monkeypatch.setattr(notifier, "_probe_container", lambda api, cid: "present")
    monkeypatch.setattr(notifier, "_claim_container", lambda cid: (True, None))
    monkeypatch.setattr(notifier, "_global_pid_path", lambda cid: tmp_path / f"claim-{cid}.pid")

    class FakeProc:
        pid = 7777
    monkeypatch.setattr(notifier.subprocess, "Popen", lambda *a, **k: FakeProc())
    assert notifier.ensure_daemon(project, quiet=True) is True
    assert record_autostart["install"] == [(project, CID)]


def test_ensure_daemon_missing_container_uninstalls_autostart(project, record_autostart, monkeypatch):
    """Definitive 404 refusal must tear the watchdog DOWN, not just decline to start:
    the LaunchAgent re-runs this ensure every minute, so a leftover agent on a dead
    container is a forever-looping launchd job that can never succeed."""
    monkeypatch.setattr(notifier, "daemon_running", lambda cwd: None)
    monkeypatch.setattr(notifier, "_probe_container", lambda api, cid: "missing")
    assert notifier.ensure_daemon(project, quiet=True) is False
    assert record_autostart["uninstall"] == [CID]
    assert record_autostart["install"] == []


def test_ensure_daemon_unreachable_api_keeps_autostart(project, record_autostart, monkeypatch, tmp_path):
    """The transient counterpart: an unreachable API (stack booting during `orcha up`)
    must NOT remove the watchdog — only a definitive 404 does."""
    monkeypatch.setattr(notifier, "daemon_running", lambda cwd: None)
    monkeypatch.setattr(notifier, "_probe_container", lambda api, cid: "unreachable")
    monkeypatch.setattr(notifier, "_claim_container", lambda cid: (True, None))
    monkeypatch.setattr(notifier, "_global_pid_path", lambda cid: tmp_path / f"claim-{cid}.pid")

    class FakeProc:
        pid = 7778
    monkeypatch.setattr(notifier.subprocess, "Popen", lambda *a, **k: FakeProc())
    assert notifier.ensure_daemon(project, quiet=True) is True
    assert record_autostart["uninstall"] == []
    assert record_autostart["install"] == [(project, CID)]


def test_stop_daemon_removes_autostart(project, record_autostart, monkeypatch):
    monkeypatch.setattr(notifier, "daemon_running", lambda cwd: None)
    monkeypatch.setattr(notifier, "daemon_running_for_container", lambda cid: None)
    monkeypatch.setattr(notifier, "_global_pid_path", lambda cid: project / f"claim-{cid}.pid")
    notifier.stop_daemon(project, quiet=True)
    assert record_autostart["uninstall"] == [CID]


def test_stop_daemon_keep_autostart_for_restart_path(project, record_autostart, monkeypatch):
    monkeypatch.setattr(notifier, "daemon_running", lambda cwd: None)
    monkeypatch.setattr(notifier, "daemon_running_for_container", lambda cid: None)
    monkeypatch.setattr(notifier, "_global_pid_path", lambda cid: project / f"claim-{cid}.pid")
    notifier.stop_daemon(project, quiet=True, keep_autostart=True)
    assert record_autostart["uninstall"] == []


def test_stop_daemon_for_container_removes_autostart(record_autostart, monkeypatch, tmp_path):
    monkeypatch.setattr(notifier, "daemon_running_for_container", lambda cid: None)
    monkeypatch.setattr(notifier, "_global_pid_path", lambda cid: tmp_path / f"claim-{cid}.pid")
    notifier.stop_daemon_for_container(CID, quiet=True)
    assert record_autostart["uninstall"] == [CID]


# ---------- explicit stop vs. an in-flight watchdog --ensure (race) ----------

def test_stop_daemon_tombstones_before_removing_autostart(project, record_autostart, monkeypatch):
    """An explicit stop must leave NO daemon and NO watchdog — and drop the tombstone an
    in-flight `--ensure` re-checks — with the tombstone written BEFORE the LaunchAgent is
    torn down, so an ensure that raced in can never observe 'agent gone but not tombstoned'."""
    order = []
    monkeypatch.setattr(notifier, "daemon_running", lambda cwd: None)
    monkeypatch.setattr(notifier, "daemon_running_for_container", lambda cid: None)
    monkeypatch.setattr(notifier, "_global_pid_path", lambda cid: project / f"claim-{cid}.pid")
    monkeypatch.setattr(notifier, "_write_stop_marker", lambda cid: order.append(("mark", cid)))
    monkeypatch.setattr(notifier.autostart, "uninstall_autostart",
                        lambda cid, quiet=True: order.append(("uninstall", cid)) or True)
    notifier.stop_daemon(project, quiet=True)
    # tombstone first, THEN the watchdog comes down — never the reverse
    assert order == [("mark", CID), ("uninstall", CID)]


def test_ensure_daemon_honors_explicit_stop_tombstone(project, record_autostart, monkeypatch):
    """A watchdog/auto `--ensure` (clear_stop=False) that fires after an explicit stop must
    refuse to resurrect the daemon and tear its own LaunchAgent down — otherwise the 60s
    watchdog respawns a deliberately-stopped notifier. The tombstone persists (stays stopped)."""
    notifier._write_stop_marker(CID)  # explicit stop already landed
    spawned = []
    monkeypatch.setattr(notifier, "daemon_running", lambda cwd: None)
    monkeypatch.setattr(notifier.subprocess, "Popen",
                        lambda *a, **k: spawned.append(a) or pytest.fail("must not spawn a stopped daemon"))
    assert notifier.ensure_daemon(project, quiet=True) is False
    assert spawned == []
    assert record_autostart["uninstall"] == [CID]
    assert record_autostart["install"] == []
    assert notifier._stop_marker_exists(CID)  # explicit stop stays stopped


def test_ensure_daemon_clear_stop_lifts_tombstone_and_spawns(project, record_autostart, monkeypatch, tmp_path):
    """An EXPLICIT bring-up (`orcha up` ⇒ clear_stop=True) lifts the tombstone and starts a
    fresh daemon — the deliberate stop is over because the user asked for the daemon back."""
    notifier._write_stop_marker(CID)
    monkeypatch.setattr(notifier, "daemon_running", lambda cwd: None)
    monkeypatch.setattr(notifier, "_probe_container", lambda api, cid: "present")
    monkeypatch.setattr(notifier, "_claim_container", lambda cid: (True, None))
    monkeypatch.setattr(notifier, "_global_pid_path", lambda cid: tmp_path / f"claim-{cid}.pid")

    class FakeProc:
        pid = 9191
    monkeypatch.setattr(notifier.subprocess, "Popen", lambda *a, **k: FakeProc())
    assert notifier.ensure_daemon(project, quiet=True, clear_stop=True) is True
    assert record_autostart["install"] == [(project, CID)]
    assert not notifier._stop_marker_exists(CID)  # tombstone lifted


def test_inflight_ensure_loses_race_to_explicit_stop(project, record_autostart, monkeypatch, tmp_path):
    """The core race: an auto `--ensure` passes the top tombstone check (none yet), then an
    explicit stop lands DURING the claim window (writes the tombstone). The final re-check
    under the claim must catch it — release the claim, tear the watchdog down, and NOT spawn
    a fresh daemon. Without it, the in-flight ensure would resurrect a just-stopped notifier."""
    claim_file = tmp_path / f"claim-{CID}.pid"
    monkeypatch.setattr(notifier, "daemon_running", lambda cwd: None)
    monkeypatch.setattr(notifier, "_probe_container", lambda api, cid: "present")
    monkeypatch.setattr(notifier, "_global_pid_path", lambda cid: claim_file)

    def _claim_then_stop_lands(cid):
        claim_file.write_text("")            # this ensure won the claim slot...
        notifier._write_stop_marker(cid)     # ...but an explicit stop lands right here
        return (True, None)
    monkeypatch.setattr(notifier, "_claim_container", _claim_then_stop_lands)
    monkeypatch.setattr(notifier.subprocess, "Popen",
                        lambda *a, **k: pytest.fail("must not spawn after an explicit stop lands"))
    assert notifier.ensure_daemon(project, quiet=True) is False
    assert record_autostart["uninstall"] == [CID]  # watchdog torn down
    assert record_autostart["install"] == []       # no autostart reinstalled
    assert not claim_file.exists()                  # claim released, not left pointing at a phantom


def test_inflight_ensure_already_running_does_not_reinstall_watchdog(project, record_autostart, monkeypatch):
    """Regression for the review race: an auto ensure can pass the initial tombstone check,
    then an explicit stop lands before it reaches the "already running" branch. It must not
    reinstall the LaunchAgent while stop_daemon is killing the old daemon."""
    monkeypatch.setattr(notifier, "daemon_running",
                        lambda cwd: notifier._write_stop_marker(CID) or 4242)
    assert notifier.ensure_daemon(project, quiet=True) is False
    assert record_autostart["install"] == []
    assert record_autostart["uninstall"] == [CID]


def test_inflight_ensure_global_holder_does_not_reinstall_watchdog(project, record_autostart, monkeypatch):
    """The same explicit-stop interleaving through the container-global holder path."""
    monkeypatch.setattr(notifier, "daemon_running", lambda cwd: None)
    monkeypatch.setattr(notifier, "_probe_container", lambda api, cid: "present")

    def _claim_after_stop_lands(cid):
        notifier._write_stop_marker(cid)
        return False, (5252, str(project))

    monkeypatch.setattr(notifier, "_claim_container", _claim_after_stop_lands)
    assert notifier.ensure_daemon(project, quiet=True) is False
    assert record_autostart["install"] == []
    assert record_autostart["uninstall"] == [CID]


def test_inflight_ensure_spawned_daemon_is_stopped_if_explicit_stop_lands(
    project, record_autostart, monkeypatch, tmp_path
):
    """Delayed variant: the watchdog ensure wins the claim and spawns, then the explicit-stop
    marker appears before autostart install. The fresh daemon must be stopped and no LaunchAgent
    left behind."""
    claim_file = tmp_path / f"claim-{CID}.pid"
    stopped = []
    monkeypatch.setattr(notifier, "daemon_running", lambda cwd: None)
    monkeypatch.setattr(notifier, "_probe_container", lambda api, cid: "present")
    monkeypatch.setattr(notifier, "_claim_container", lambda cid: (True, None))
    monkeypatch.setattr(notifier, "_global_pid_path", lambda cid: claim_file)
    monkeypatch.setattr(notifier, "_write_global_pid",
                        lambda cid, pid, cwd: notifier._write_stop_marker(cid))
    monkeypatch.setattr(notifier, "_terminate_and_wait",
                        lambda pid, cid, grace=8.0: stopped.append((pid, cid)))

    class FakeProc:
        pid = 6161

    monkeypatch.setattr(notifier.subprocess, "Popen", lambda *a, **k: FakeProc())
    assert notifier.ensure_daemon(project, quiet=True) is False
    assert stopped == [(6161, CID)]
    assert record_autostart["install"] == []
    assert record_autostart["uninstall"] == [CID]
    assert not (project / ".claude" / ".orcha-notifier.pid").exists()
    assert not claim_file.exists()


def test_stop_daemon_finally_removes_watchdog_reinstalled_by_inflight_ensure(project, monkeypatch):
    """If an already-running watchdog ensure reinstalls autostart while stop_daemon waits for
    the old daemon to exit, stop_daemon must remove it again before returning."""
    order = []
    monkeypatch.setattr(notifier, "daemon_running", lambda cwd: 4242)
    monkeypatch.setattr(notifier, "daemon_running_for_container", lambda cid: None)
    monkeypatch.setattr(notifier, "_global_pid_path", lambda cid: project / f"claim-{cid}.pid")
    monkeypatch.setattr(notifier.autostart, "uninstall_autostart",
                        lambda cid, quiet=True: order.append(("uninstall", cid)) or True)
    monkeypatch.setattr(notifier.autostart, "install_autostart",
                        lambda cwd, cid, quiet=True: order.append(("install", cid)) or True)
    monkeypatch.setattr(notifier, "_terminate_and_wait",
                        lambda pid, cid, grace=8.0: notifier.autostart.install_autostart(project, cid))
    assert notifier.stop_daemon(project, quiet=True) is True
    assert order == [("uninstall", CID), ("install", CID), ("uninstall", CID)]


# ---------- wiring: orcha up/down --project ----------

def _label_stdout(orcha_dir: pathlib.Path) -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess([], 0, stdout=f"{orcha_dir}\n{orcha_dir}\n", stderr="")


def test_project_root_for_recovers_checkout(project, monkeypatch):
    (project / ".orcha").mkdir()
    monkeypatch.setattr(cli.subprocess, "run",
                        lambda *a, **k: _label_stdout(project / ".orcha"))
    assert cli._project_root_for("proj") == project


def test_project_root_for_none_when_label_missing(monkeypatch):
    monkeypatch.setattr(cli.subprocess, "run",
                        lambda *a, **k: subprocess.CompletedProcess([], 0, stdout="\n", stderr=""))
    assert cli._project_root_for("proj") is None


def test_project_root_for_rejects_reused_checkout(project, monkeypatch, tmp_path):
    """Stale working_dir label: the path was deleted and reused for a DIFFERENT Orcha
    project. Its orcha.json names another project, so recovery must refuse — returning
    it would run the other project's compose file / stop its daemons."""
    other = _make_project(tmp_path / "other-project")
    (other / ".orcha").mkdir()
    monkeypatch.setattr(cli.subprocess, "run",
                        lambda *a, **k: _label_stdout(other / ".orcha"))
    assert cli._project_root_for("proj") is None


def test_project_root_for_skips_stale_label_and_finds_match(project, monkeypatch, tmp_path):
    """Two containers carry the label (one stale, pointing at a reused checkout;
    one current). The mismatching candidate is skipped, not fatal."""
    other = _make_project(tmp_path / "other-project")
    (other / ".orcha").mkdir()
    (project / ".orcha").mkdir()
    stdout = f"{other / '.orcha'}\n{project / '.orcha'}\n"
    monkeypatch.setattr(cli.subprocess, "run",
                        lambda *a, **k: subprocess.CompletedProcess([], 0, stdout=stdout, stderr=""))
    assert cli._project_root_for("proj") == project


def test_project_root_for_rejects_unreadable_config(project, monkeypatch):
    (project / ".orcha").mkdir()
    (project / ".claude" / "orcha.json").write_text("{not json")
    monkeypatch.setattr(cli.subprocess, "run",
                        lambda *a, **k: _label_stdout(project / ".orcha"))
    assert cli._project_root_for("proj") is None


def _make_compose_file(root: pathlib.Path) -> pathlib.Path:
    (root / ".orcha").mkdir(parents=True, exist_ok=True)
    compose = root / ".orcha" / "docker-compose.yml"
    compose.write_text("services: {}\n")
    return compose


def test_up_by_project_brings_daemons_up_at_root(project, monkeypatch):
    """The --project path used to return before ensure_daemon — the reported gap.
    Compose must run against the TARGET checkout's compose file (-f), never
    whatever file happens to sit in the current directory."""
    compose = _make_compose_file(project)
    calls = []
    monkeypatch.setattr(cli, "_project_exists", lambda name: True)
    monkeypatch.setattr(cli, "_by_project", lambda name, *a: calls.append(("compose", name, a)))
    monkeypatch.setattr(cli, "_project_root_for", lambda name: project)
    monkeypatch.setattr(cli, "ensure_daemon",
                        lambda root, clear_stop=False: calls.append(("ensure", root, clear_stop)))
    import orcha_cli.terminal_bridge as tb
    monkeypatch.setattr(tb, "ensure_bridge", lambda root: calls.append(("bridge", root)))
    cli.cmd_up(argparse.Namespace(project="proj"))
    assert ("compose", "proj", ("-f", str(compose), "up", "-d")) in calls
    # `orcha up` is an explicit bring-up ⇒ clears any prior explicit-stop tombstone
    assert ("ensure", project, True) in calls
    assert ("bridge", project) in calls


def test_up_by_project_exits_when_root_unresolvable(monkeypatch):
    """No recoverable checkout ⇒ fail BEFORE compose — running `up` against the
    current directory's compose file could start the wrong project's services."""
    monkeypatch.setattr(cli, "_project_exists", lambda name: True)
    monkeypatch.setattr(cli, "_by_project",
                        lambda name, *a: pytest.fail("must not run compose without a resolved root"))
    monkeypatch.setattr(cli, "_project_root_for", lambda name: None)
    monkeypatch.setattr(cli, "ensure_daemon",
                        lambda root: pytest.fail("must not ensure without a resolved root"))
    with pytest.raises(SystemExit) as exc:
        cli.cmd_up(argparse.Namespace(project="proj"))
    assert "checkout" in str(exc.value)


def test_up_by_project_exits_when_compose_file_missing(project, monkeypatch):
    monkeypatch.setattr(cli, "_project_exists", lambda name: True)
    monkeypatch.setattr(cli, "_by_project",
                        lambda name, *a: pytest.fail("must not run compose without a compose file"))
    monkeypatch.setattr(cli, "_project_root_for", lambda name: project)  # no .orcha/ inside
    with pytest.raises(SystemExit):
        cli.cmd_up(argparse.Namespace(project="proj"))


def test_down_by_project_stops_only_target_daemons(project, monkeypatch):
    """`down --project` must stop the TARGET's daemons and nothing else — stop_daemon
    also removes the autostart watchdog, so stopping the current directory's daemon
    here would disable another project's wakes while its stack is still up."""
    calls = []
    stops = []
    monkeypatch.setattr(cli, "_project_exists", lambda name: True)
    monkeypatch.setattr(cli, "_by_project", lambda name, *a: calls.append(("compose", name, a)))
    monkeypatch.setattr(cli, "_project_root_for", lambda name: project)
    monkeypatch.setattr(cli, "stop_daemon", lambda root: stops.append(root))
    import orcha_cli.terminal_bridge as tb
    monkeypatch.setattr(tb, "stop_bridge", lambda root: calls.append(("stop_bridge", root)))
    cli.cmd_down(argparse.Namespace(project="proj", volumes=False))
    assert stops == [project]  # target only — never the cwd
    assert ("stop_bridge", project) in calls
    assert ("compose", "proj", ("down",)) in calls


def test_up_by_project_refuses_before_compose_when_checkout_reused(monkeypatch, tmp_path):
    """End-to-end through the real _project_root_for: the label resolves to a checkout
    whose orcha.json names a DIFFERENT project ⇒ `up --project` must exit before
    compose, not start the other project's services under this project's name."""
    other = _make_project(tmp_path / "other-project")
    _make_compose_file(other)
    monkeypatch.setattr(cli, "_project_exists", lambda name: True)
    monkeypatch.setattr(cli.subprocess, "run",
                        lambda *a, **k: _label_stdout(other / ".orcha"))
    monkeypatch.setattr(cli, "_by_project",
                        lambda name, *a: pytest.fail("must not run compose against a reused checkout"))
    monkeypatch.setattr(cli, "ensure_daemon",
                        lambda root: pytest.fail("must not ensure daemons for a reused checkout"))
    with pytest.raises(SystemExit) as exc:
        cli.cmd_up(argparse.Namespace(project="proj"))
    assert "checkout" in str(exc.value)


def test_down_by_project_leaves_reused_checkout_daemons_alone(monkeypatch, tmp_path, capsys):
    """Same stale-label scenario on the way down: the other project's notifier/bridge
    (and its LaunchAgent, via stop_daemon) must NOT be stopped; the compose stack
    still goes down under its own project name."""
    other = _make_project(tmp_path / "other-project")
    _make_compose_file(other)
    calls = []
    monkeypatch.setattr(cli, "_project_exists", lambda name: True)
    monkeypatch.setattr(cli.subprocess, "run",
                        lambda *a, **k: _label_stdout(other / ".orcha"))
    monkeypatch.setattr(cli, "_by_project", lambda name, *a: calls.append(("compose", name, a)))
    monkeypatch.setattr(cli, "stop_daemon",
                        lambda root: pytest.fail("must not stop a different project's daemons"))
    monkeypatch.setattr(notifier, "stop_daemon_for_container",
                        lambda cid, quiet=True: pytest.fail("must not stop the reused checkout's daemon"))
    cli.cmd_down(argparse.Namespace(project="proj", volumes=False))
    assert ("compose", "proj", ("down",)) in calls
    # the reused path still holds another project's orcha.json ⇒ recovery skips it and warns
    assert "couldn't locate" in capsys.readouterr().out


def test_down_by_project_warns_but_still_downs_when_root_unresolvable(monkeypatch, capsys):
    calls = []
    monkeypatch.setattr(cli, "_project_exists", lambda name: True)
    monkeypatch.setattr(cli, "_by_project", lambda name, *a: calls.append(("compose", name, a)))
    monkeypatch.setattr(cli, "_project_root_for", lambda name: None)
    # no compose labels at all ⇒ no checkout to recover a daemon from
    monkeypatch.setattr(cli.subprocess, "run",
                        lambda *a, **k: subprocess.CompletedProcess([], 0, stdout="", stderr=""))
    monkeypatch.setattr(cli, "stop_daemon",
                        lambda root: pytest.fail("must not stop daemons without a resolved root"))
    cli.cmd_down(argparse.Namespace(project="proj", volumes=False))
    assert ("compose", "proj", ("down",)) in calls
    assert "couldn't locate" in capsys.readouterr().out


def test_down_by_project_cleans_orphaned_daemon_when_checkout_deleted(monkeypatch, tmp_path, capsys):
    """The reported gap: `down --project` when the checkout was DELETED (or moved) — its
    compose working_dir label points at a path that no longer holds an Orcha checkout, so
    `_project_root_for` can't hand us the container id. We must still stop that project's
    daemon and remove its LaunchAgent by recovering the id from the watchdog whose
    WorkingDirectory matches the label path; otherwise the 60s watchdog resurrects a daemon
    that polls a going-away stack forever. End state: stack down, NO autostart left behind."""
    gone = tmp_path / "deleted-checkout"          # nothing lives here anymore
    gone_wd = gone / ".orcha"                       # compose's working_dir label
    calls = []
    monkeypatch.setattr(cli, "_project_exists", lambda name: True)
    monkeypatch.setattr(cli, "_by_project", lambda name, *a: calls.append(("compose", name, a)))
    monkeypatch.setattr(cli, "_project_root_for", lambda name: None)  # checkout unresolvable
    # docker reports the compose working_dir label at the now-empty checkout path
    monkeypatch.setattr(cli.subprocess, "run",
                        lambda *a, **k: subprocess.CompletedProcess([], 0, stdout=f"{gone_wd}\n", stderr=""))
    # the LaunchAgent still records the checkout ROOT as WorkingDirectory and names the container
    monkeypatch.setattr(autostart, "container_ids_for_workdir",
                        lambda wd: [CID] if wd == gone else [])
    monkeypatch.setattr(notifier, "stop_daemon_for_container",
                        lambda cid, quiet=True: calls.append(("stop", cid)) or True)
    cli.cmd_down(argparse.Namespace(project="proj", volumes=False))
    assert ("compose", "proj", ("down",)) in calls   # stack still goes down
    assert calls.index(("stop", CID)) < calls.index(("compose", "proj", ("down",)))
    assert "couldn't locate" not in capsys.readouterr().out  # recovery succeeded ⇒ no warning


def test_down_local_stops_cwd_daemons(project, monkeypatch):
    _make_compose_file(project)
    monkeypatch.chdir(project)
    calls = []
    monkeypatch.setattr(cli, "_compose", lambda d, *a: calls.append(("compose", d, a)))
    monkeypatch.setattr(cli, "stop_daemon", lambda root: calls.append(("stop", root)))
    import orcha_cli.terminal_bridge as tb
    monkeypatch.setattr(tb, "stop_bridge", lambda root: calls.append(("stop_bridge", root)))
    cli.cmd_down(argparse.Namespace(project=None, volumes=False))
    assert ("stop", project) in calls
    assert ("stop_bridge", project) in calls
    assert ("compose", project / ".orcha", ("down",)) in calls
