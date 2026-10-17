"""GH #258 PR 10 (plan R4): `orcha doctor [--json]` — the one screen a non-engineer pastes
into a bug report. Read-only: nothing here starts, stops or writes anything."""
from __future__ import annotations

import collections
import json
import pathlib
import plistlib
import types

import pytest

from orcha_cli import cli_doctor, cli_serve_support, cli_service


def _tool(bindir: pathlib.Path, name: str) -> None:
    bindir.mkdir(parents=True, exist_ok=True)
    exe = bindir / name
    exe.write_text("#!/bin/sh\n")
    exe.chmod(0o755)


@pytest.fixture
def native(tmp_path, monkeypatch):
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path / "home")
    monkeypatch.setattr(cli_service, "PLATFORM", "linux")
    monkeypatch.setattr(cli_serve_support, "tcp_open", lambda port, **k: True)
    monkeypatch.setattr(cli_serve_support, "http_ok", lambda url, **k: True)
    bindir = tmp_path / "bin"
    for name in ("claude", "git"):
        _tool(bindir, name)
    monkeypatch.setenv("PATH", str(bindir))
    root = tmp_path / "proj"
    (root / ".claude").mkdir(parents=True)
    (root / ".claude" / "orcha.json").write_text(json.dumps(
        {"project_name": "proj", "runtime": "native", "api_port": 8123, "bridge_port": 8770,
         "db_path": ".orcha/orcha.db"}))
    (root / ".orcha").mkdir()
    (root / ".orcha" / "orcha.db").write_bytes(b"x" * 2048)
    return types.SimpleNamespace(root=root.resolve(), bindir=bindir)


def test_healthy_native_project_reports_everything_and_ok(native):
    rep = cli_doctor.collect(native.root)
    assert rep["runtime"] == "native" and rep["is_project"] and rep["ok"], rep["problems"]
    assert rep["tools"]["claude"] == str(native.bindir / "claude")
    assert rep["tools"]["git"] == str(native.bindir / "git")
    assert rep["tools"]["codex"] is None and rep["tools"]["gh"] is None
    assert rep["ports"]["api"] == {"port": 8123, "listening": True, "answers": True}
    assert rep["ports"]["bridge"] == {"port": 8770, "listening": True}
    assert rep["database"]["size_bytes"] == 2048
    assert rep["sqlite"]["ok"] and rep["disk"]["ok"]
    assert rep["service"]["supported"] is False  # not a Mac here: never a problem
    json.dumps(rep)  # the --json form serialises


def test_problems_are_plain_english(native, monkeypatch):
    monkeypatch.setattr(cli_serve_support, "http_ok", lambda url, **k: False)
    monkeypatch.setattr(cli_doctor.sqlite3, "sqlite_version", "3.37.2")
    usage = collections.namedtuple("usage", "total used free")
    monkeypatch.setattr(cli_doctor.shutil, "disk_usage", lambda p: usage(10 << 30, 0, 100 << 20))
    for name in ("claude", "git"):
        (native.bindir / name).unlink()
    rep = cli_doctor.collect(native.root)
    assert rep["ok"] is False
    text = " | ".join(rep["problems"])
    for needle in ("git was not found", "neither the claude nor the codex",
                   "SQLite 3.37.2 is too old", "less than 1 GB", "portal is not answering"):
        assert needle in text


def test_tools_are_looked_up_on_the_service_path(native, monkeypatch, tmp_path):
    """The service runs with the PATH captured at install; that is what agents get."""
    svc_bin = tmp_path / "svc-bin"
    for name in ("codex", "git", "gh"):
        _tool(svc_bin, name)
    monkeypatch.setattr(cli_service, "PLATFORM", "darwin")
    monkeypatch.setattr(cli_service, "loaded_status", lambda name: {
        "loaded": True, "state": "running", "pid": 77, "last_exit": None})
    plist = cli_service.plist_path("proj")
    plist.parent.mkdir(parents=True)
    plist.write_bytes(plistlib.dumps(cli_service.render(
        native.root, "proj", python="/py", path_env=str(svc_bin), home=str(tmp_path / "home"))))
    rep = cli_doctor.collect(native.root)
    assert rep["path_source"] == "service" and rep["path_env"] == str(svc_bin)
    assert rep["tools"]["codex"] == str(svc_bin / "codex") and rep["tools"]["claude"] is None
    assert rep["service"]["state"] == "running" and rep["service"]["pid"] == 77
    assert rep["ok"], rep["problems"]


def test_missing_service_on_a_mac_is_a_problem(native, monkeypatch):
    monkeypatch.setattr(cli_service, "PLATFORM", "darwin")
    monkeypatch.setattr(cli_service, "loaded_status", lambda name: {
        "loaded": False, "state": None, "pid": None, "last_exit": None})
    rep = cli_doctor.collect(native.root)
    assert any("orcha service install" in p for p in rep["problems"])


def test_log_tails_are_the_last_20_lines(native):
    logs = native.root / ".orcha" / "logs"
    logs.mkdir()
    (logs / "portal.log").write_text("".join(f"line {i}\n" for i in range(30)))
    (logs / "launchd.log").write_text("boot\n")
    rep = cli_doctor.collect(native.root)
    assert rep["logs"]["portal"] == [f"line {i}" for i in range(10, 30)]
    assert rep["logs"]["launchd"] == ["boot"] and "notifier" not in rep["logs"]
    text = cli_doctor.render(rep)
    assert "--- portal.log (last 20 lines) ---" in text and "line 29" in text


def test_outside_a_project_only_machine_checks_run(tmp_path, monkeypatch):
    monkeypatch.setattr(cli_service, "PLATFORM", "linux")
    rep = cli_doctor.collect(tmp_path)
    assert rep["is_project"] is False and rep["runtime"] is None
    assert "ports" not in rep and rep["service"] is None
    assert any("not an Orcha project" in p for p in rep["problems"])
    assert "no project here" in cli_doctor.render(rep)


def test_docker_project_points_at_compose_logs(tmp_path, monkeypatch):
    monkeypatch.setattr(cli_service, "PLATFORM", "linux")
    monkeypatch.setattr(cli_serve_support, "http_ok", lambda url, **k: True)
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "orcha.json").write_text(json.dumps({"api_port": 8000}))
    (tmp_path / ".orcha").mkdir()
    (tmp_path / ".orcha" / "docker-compose.yml").write_text("services: {}\n")
    rep = cli_doctor.collect(tmp_path)
    assert rep["runtime"] == "docker" and "docker compose" in rep["logs_hint"]
    assert "database" not in rep and rep["service"] is None


def test_cmd_doctor_json_and_text(native, capsys):
    cli_doctor.cmd_doctor(types.SimpleNamespace(project_dir=str(native.root), json=True))
    rep = json.loads(capsys.readouterr().out)
    assert rep["ok"] is True and rep["runtime"] == "native"
    cli_doctor.cmd_doctor(types.SimpleNamespace(project_dir=str(native.root), json=False))
    text = capsys.readouterr().out
    assert text.startswith("Orcha doctor") and "No problems found." in text
    assert "api port:    8123 (listening yes, answers yes)" in text
    assert "bridge port: 8770 (listening yes)" in text


def test_doctor_never_writes(native):
    before = sorted(p.relative_to(native.root) for p in native.root.rglob("*"))
    cli_doctor.collect(native.root)
    assert sorted(p.relative_to(native.root) for p in native.root.rglob("*")) == before
