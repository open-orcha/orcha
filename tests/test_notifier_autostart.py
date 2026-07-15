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


def _make_project(root: pathlib.Path, cid: str = CID) -> pathlib.Path:
    (root / ".claude").mkdir(parents=True, exist_ok=True)
    (root / ".claude" / "orcha.json").write_text(
        json.dumps({"current_container_id": cid, "api_base_url": "http://localhost:9/api"})
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


def test_up_by_project_brings_daemons_up_at_root(project, monkeypatch):
    """The --project path used to return before ensure_daemon — the reported gap."""
    calls = []
    monkeypatch.setattr(cli, "_project_exists", lambda name: True)
    monkeypatch.setattr(cli, "_by_project", lambda name, *a: calls.append(("compose", name, a)))
    monkeypatch.setattr(cli, "_project_root_for", lambda name: project)
    monkeypatch.setattr(cli, "ensure_daemon", lambda root: calls.append(("ensure", root)))
    import orcha_cli.terminal_bridge as tb
    monkeypatch.setattr(tb, "ensure_bridge", lambda root: calls.append(("bridge", root)))
    cli.cmd_up(argparse.Namespace(project="proj"))
    assert ("compose", "proj", ("up", "-d")) in calls
    assert ("ensure", project) in calls
    assert ("bridge", project) in calls


def test_up_by_project_warns_when_root_unresolvable(monkeypatch, capsys):
    monkeypatch.setattr(cli, "_project_exists", lambda name: True)
    monkeypatch.setattr(cli, "_by_project", lambda name, *a: None)
    monkeypatch.setattr(cli, "_project_root_for", lambda name: None)
    monkeypatch.setattr(cli, "ensure_daemon",
                        lambda root: pytest.fail("must not ensure without a resolved root"))
    cli.cmd_up(argparse.Namespace(project="proj"))
    assert "notifier not started" in capsys.readouterr().out


def test_down_by_project_stops_daemon_at_root(project, monkeypatch):
    calls = []
    monkeypatch.setattr(cli, "_project_exists", lambda name: True)
    monkeypatch.setattr(cli, "_by_project", lambda name, *a: calls.append(("compose", name, a)))
    monkeypatch.setattr(cli, "_project_root_for", lambda name: project)
    monkeypatch.setattr(cli, "stop_daemon", lambda root: calls.append(("stop", root)))
    import orcha_cli.terminal_bridge as tb
    monkeypatch.setattr(tb, "stop_bridge", lambda root: calls.append(("stop_bridge", root)))
    cli.cmd_down(argparse.Namespace(project="proj", volumes=False))
    assert ("stop", project) in calls
    assert ("stop_bridge", project) in calls
    assert ("compose", "proj", ("down",)) in calls
