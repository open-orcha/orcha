"""GH #258 PR 10 (plan R3): `orcha service install|uninstall|status` — the macOS launchd
user agent that keeps a native project's `orcha serve` running across logout and reboot.

`launchctl` never really runs here: `subprocess.run` is swapped for a fake that records
argv and answers `launchctl print` from a fixture, so the suite runs the same on Linux CI.
"""
from __future__ import annotations

import json
import os
import pathlib
import plistlib
import shutil
import subprocess
import sys
import types

import pytest

from orcha_cli import cli_native_lifecycle, cli_service, cli_stacks_registry

FIXTURES = pathlib.Path(__file__).parent / "fixtures" / "cli_service"
PRINT_RUNNING = (FIXTURES / "launchctl_print_running.txt").read_text()
PY = "/opt/orcha/venv/bin/python"


class FakeLaunchctl:
    """Records every argv; `print` answers 113 until `bootstrap`, then the fixture."""

    def __init__(self, loaded: bool = False):
        self.calls: list = []
        self.loaded = loaded
        self.fail_bootstrap = False

    def __call__(self, argv, **kwargs):
        argv = list(argv)
        if argv[0] != "launchctl":
            raise AssertionError(f"unexpected subprocess {argv}")
        self.calls.append(argv[1:])
        verb = argv[1]
        if verb == "print":
            if not self.loaded:
                return subprocess.CompletedProcess(argv, 113, "", "Could not find service")
            return subprocess.CompletedProcess(argv, 0, PRINT_RUNNING, "")
        if verb == "bootstrap":
            if self.fail_bootstrap:
                return subprocess.CompletedProcess(argv, 5, "", "Bootstrap failed: 5: I/O error")
            self.loaded = True
        if verb == "bootout":
            self.loaded = False
        return subprocess.CompletedProcess(argv, 0, "", "")

    def verbs(self):
        return [c[0] for c in self.calls if c[0] != "print"]


@pytest.fixture
def mac(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr("pathlib.Path.home", lambda: home)
    monkeypatch.setattr(cli_service, "PLATFORM", "darwin")
    monkeypatch.setattr(cli_service, "capture_path", lambda shell=None: "/captured/bin:/usr/bin")
    fake = FakeLaunchctl()
    monkeypatch.setattr(cli_service.subprocess, "run", fake)
    root = tmp_path / "demo"
    (root / ".claude").mkdir(parents=True)
    (root / ".claude" / "orcha.json").write_text(json.dumps(
        {"project_name": "demo", "runtime": "native", "api_port": 8123, "bridge_port": 8770,
         "api_base_url": "http://localhost:8123"}))
    return types.SimpleNamespace(root=root.resolve(), home=home, fake=fake,
                                 domain=f"gui/{os.getuid()}")


def _plist(env) -> pathlib.Path:
    return env.home / "Library" / "LaunchAgents" / "io.openorcha.demo.plist"


# --- the plist ---------------------------------------------------------------------------


def test_plist_matches_golden_file():
    plist = cli_service.render(
        pathlib.Path("/Users/tester/demo"), "demo", python=PY,
        path_env="/Users/tester/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        home="/Users/tester")
    golden = (FIXTURES / "io.openorcha.demo.plist").read_bytes()
    assert cli_service.render_bytes(plist) == golden
    parsed = plistlib.loads(golden)
    assert parsed["ProgramArguments"] == [PY, "-m", "orcha_cli", "serve", "--project-dir",
                                          "/Users/tester/demo"]
    assert parsed["RunAtLoad"] is True and parsed["ThrottleInterval"] == 10
    # a clean stop (logout, SIGTERM) is not undone; a crash or a duplicate serve (exit 1) is
    assert parsed["KeepAlive"] == {"SuccessfulExit": False}


@pytest.mark.skipif(shutil.which("plutil") is None, reason="plutil is macOS only")
def test_golden_plist_passes_plutil_lint():
    proc = subprocess.run(["plutil", "-lint", str(FIXTURES / "io.openorcha.demo.plist")],
                          capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_capture_path_reads_the_login_shell_through_noise(tmp_path, monkeypatch):
    shell = tmp_path / "fakeshell"
    shell.write_text('#!/bin/sh\necho "Welcome back! PATH=/not/this"\n'
                     'PATH="/fake/bin:/usr/bin:/opt/homebrew/bin"\neval "$2"\necho trailing\n')
    shell.chmod(0o755)
    monkeypatch.setenv("HOME", str(tmp_path / "h"))
    got = cli_service.capture_path(str(shell)).split(":")
    assert got == [str(tmp_path / "h" / ".local" / "bin"), "/opt/homebrew/bin", "/usr/local/bin",
                   "/fake/bin", "/usr/bin"]  # install dirs first, de-duplicated


def test_capture_path_falls_back_to_the_current_path(tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", "/only/here:/usr/bin")
    got = cli_service.capture_path(str(tmp_path / "no-such-shell"))
    assert got.endswith(":/only/here:/usr/bin") and "/opt/homebrew/bin" in got


# --- install / uninstall / status ------------------------------------------------------------


def test_install_writes_plist_and_bootstraps(mac):
    res = cli_service.install(mac.root, python=PY)
    assert res == {"label": "io.openorcha.demo", "plist": str(_plist(mac)), "changed": True,
                   "loaded": True}
    assert mac.fake.calls == [["print", f"{mac.domain}/io.openorcha.demo"],
                              ["bootstrap", mac.domain, str(_plist(mac))]]
    written = plistlib.loads(_plist(mac).read_bytes())
    assert written["ProgramArguments"][0] == PY
    assert written["ProgramArguments"][-1] == str(mac.root)
    assert written["EnvironmentVariables"]["PATH"] == "/captured/bin:/usr/bin"
    assert written["EnvironmentVariables"]["HOME"] == str(mac.home)
    assert (mac.root / ".orcha" / "logs").is_dir()  # launchd opens launchd.log there


def test_install_is_idempotent_and_reloads_only_on_change(mac, monkeypatch):
    cli_service.install(mac.root, python=PY)
    mac.fake.calls.clear()
    again = cli_service.install(mac.root, python=PY)
    assert again["changed"] is False and mac.fake.verbs() == []  # nothing restarted
    monkeypatch.setattr(cli_service, "capture_path", lambda shell=None: "/new/bin:/usr/bin")
    changed = cli_service.install(mac.root, python=PY)
    assert changed["changed"] is True
    assert mac.fake.calls[-2:] == [["bootout", f"{mac.domain}/io.openorcha.demo"],
                                   ["bootstrap", mac.domain, str(_plist(mac))]]
    assert "/new/bin" in _plist(mac).read_text()


def test_install_loads_an_unloaded_unchanged_plist(mac):
    cli_service.install(mac.root, python=PY)
    mac.fake.loaded = False  # e.g. after `orcha down` (bootout)
    mac.fake.calls.clear()
    res = cli_service.install(mac.root, python=PY)
    assert res["changed"] is False and mac.fake.verbs() == ["bootstrap"]


def test_install_failure_raises_with_launchctl_message(mac):
    mac.fake.fail_bootstrap = True
    with pytest.raises(cli_service.ServiceError, match="Bootstrap failed"):
        cli_service.install(mac.root, python=PY)


def test_install_refuses_a_docker_project(mac):
    cfg = json.loads((mac.root / ".claude" / "orcha.json").read_text())
    cfg.pop("runtime")
    (mac.root / ".claude" / "orcha.json").write_text(json.dumps(cfg))
    (mac.root / ".orcha").mkdir()
    (mac.root / ".orcha" / "docker-compose.yml").write_text("services: {}\n")
    with pytest.raises(cli_service.ServiceError, match="not a native"):
        cli_service.install(mac.root, python=PY)
    assert not _plist(mac).exists() and mac.fake.calls == []


def test_uninstall_boots_out_and_removes_file_and_registry_entry(mac):
    cli_service.install(mac.root, python=PY)
    cli_stacks_registry.register("demo", path=mac.root, api_port=8123, bridge_port=8770,
                                 cli_version="t")
    mac.fake.calls.clear()
    res = cli_service.uninstall(mac.root)
    assert res["removed"] and res["was_loaded"] and res["unregistered"]
    assert ["bootout", f"{mac.domain}/io.openorcha.demo"] in mac.fake.calls
    assert not _plist(mac).exists()
    assert "demo" not in cli_stacks_registry.read_registry()
    again = cli_service.uninstall(mac.root)  # idempotent
    assert not again["removed"] and not again["was_loaded"]


def test_status_reads_launchctl_print(mac):
    assert cli_service.status(mac.root)["installed"] is False
    cli_service.install(mac.root, python=PY)
    st = cli_service.status(mac.root)
    assert st["installed"] and st["loaded"]
    assert (st["state"], st["pid"], st["last_exit"]) == ("running", 4242, "(never exited)")
    assert st["program"] == PY and st["path_env"] == "/captured/bin:/usr/bin"


def test_not_macos_is_a_clear_error_and_never_calls_launchctl(mac, monkeypatch):
    monkeypatch.setattr(cli_service, "PLATFORM", "linux")
    with pytest.raises(cli_service.ServiceError, match="macOS only"):
        cli_service.install(mac.root)
    assert cli_service.status(mac.root)["supported"] is False
    assert cli_service.installed(mac.root) is False and cli_service.stop(mac.root) is False
    assert cli_service.install_if_supported(mac.root) is None
    assert mac.fake.calls == []


def test_cmd_service_json(mac, capsys):
    ns = types.SimpleNamespace(project_dir=str(mac.root), json=True)
    cli_service.cmd_service(types.SimpleNamespace(action="install", **vars(ns)))
    out = json.loads(capsys.readouterr().out)
    assert out["ok"] and out["event"] == "result" and out["plist"] == str(_plist(mac))
    cli_service.cmd_service(types.SimpleNamespace(action="status", **vars(ns)))
    out = json.loads(capsys.readouterr().out)
    assert out["state"] == "running" and out["pid"] == 4242
    mac.fake.fail_bootstrap = True
    _plist(mac).unlink()
    mac.fake.loaded = False
    with pytest.raises(SystemExit):
        cli_service.cmd_service(types.SimpleNamespace(action="install", **vars(ns)))
    err = json.loads(capsys.readouterr().out)
    assert err["ok"] is False and "Bootstrap failed" in err["error"]


def test_parser_has_service_and_doctor():
    from orcha_cli import __main__ as cli

    parser = cli.build_parser()
    ns = parser.parse_args(["service", "install", "--json", "--project-dir", "/x"])
    assert (ns.action, ns.json, ns.project_dir) == ("install", True, "/x")
    assert parser.parse_args(["doctor", "--json"]).json is True
    with pytest.raises(SystemExit):
        parser.parse_args(["service", "restart"])


# --- `orcha up` / `orcha down` with the unit installed -------------------------------------------


def test_up_with_unit_refreshes_and_kickstarts_never_spawns(mac, monkeypatch):
    cli_service.install(mac.root, python=PY)
    mac.fake.calls.clear()

    def popen(*_a, **_k):
        raise AssertionError("launchd owns serve; up must not spawn a second one")

    monkeypatch.setattr(cli_native_lifecycle.cli_serve, "serve_running", lambda root: None)
    monkeypatch.setattr(cli_service, "capture_path", lambda shell=None: "/later/claude:/usr/bin")
    cli_native_lifecycle.up(mac.root, popen=popen, http_ok=lambda url: True, wait_secs=0.1)
    verbs = mac.fake.verbs()
    assert verbs == ["bootout", "bootstrap", "kickstart"]  # PATH changed -> reloaded
    assert ["kickstart", f"{mac.domain}/io.openorcha.demo"] in mac.fake.calls  # no -k
    assert "/later/claude" in _plist(mac).read_text()


def test_up_with_unit_and_healthy_serve_restarts_nothing(mac, monkeypatch, capsys):
    monkeypatch.setattr(cli_service, "capture_path", lambda shell=None: "/captured/bin:/usr/bin")
    monkeypatch.setattr(cli_service.sys, "executable", PY)
    cli_service.install(mac.root)
    mac.fake.calls.clear()
    monkeypatch.setattr(cli_native_lifecycle.cli_serve, "serve_running", lambda root: 4242)
    cli_native_lifecycle.up(mac.root, popen=None, http_ok=lambda url: True, wait_secs=0.1)
    assert mac.fake.verbs() == ["kickstart"]
    assert "already running" in capsys.readouterr().out


def test_down_with_unit_boots_out(mac, monkeypatch):
    cli_service.install(mac.root, python=PY)
    mac.fake.calls.clear()
    monkeypatch.setattr(cli_native_lifecycle.cli_serve, "serve_running", lambda root: None)

    def kill(*_a):
        raise AssertionError("launchd stopped serve; nothing left to signal")

    cli_native_lifecycle.down(mac.root, kill=kill, stop_secs=0.1)
    assert mac.fake.verbs() == ["bootout"]
    assert _plist(mac).exists()  # down keeps the unit; uninstall removes it
