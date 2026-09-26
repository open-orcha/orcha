# tests/test_sandbox_preflight.py
"""Preflight: Docker reachable, image present, disk headroom (spec §3.5).
A failed preflight returns a human-readable reason; the caller fails the wake."""
import os
import stat
import subprocess

from orcha_cli import sandbox


def _shim(tmp_path, monkeypatch, script: str):
    d = tmp_path / "bin"
    d.mkdir(exist_ok=True)
    f = d / "docker"
    f.write_text("#!/bin/sh\n" + script)
    f.chmod(f.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", f"{d}:{os.environ['PATH']}")


def test_preflight_ok(tmp_path, monkeypatch):
    _shim(tmp_path, monkeypatch, 'exit 0\n')          # `docker info` and `docker image inspect` succeed
    monkeypatch.setattr(sandbox, "_free_disk_gb", lambda path: 100.0)
    assert sandbox.preflight(sandbox.SandboxConfig(enabled=True), str(tmp_path)) is None


def test_preflight_docker_not_installed(tmp_path, monkeypatch):
    empty = tmp_path / "empty"
    empty.mkdir()
    monkeypatch.setenv("PATH", str(empty))
    reason = sandbox.preflight(sandbox.SandboxConfig(enabled=True), str(tmp_path))
    assert reason is not None and "not installed" in reason


def test_preflight_daemon_timeout_returns_reason_not_exception(tmp_path, monkeypatch):
    _shim(tmp_path, monkeypatch, 'exit 0\n')          # docker IS on PATH; run() itself hangs
    def _hang(*a, **k):
        raise subprocess.TimeoutExpired(cmd="docker", timeout=1)
    monkeypatch.setattr(sandbox.subprocess, "run", _hang)
    reason = sandbox.preflight(sandbox.SandboxConfig(enabled=True), str(tmp_path))
    assert reason is not None and "docker" in reason.lower()


def test_preflight_docker_down(tmp_path, monkeypatch):
    _shim(tmp_path, monkeypatch, 'echo "Cannot connect" >&2; exit 1\n')
    reason = sandbox.preflight(sandbox.SandboxConfig(enabled=True), str(tmp_path))
    assert reason is not None and "docker" in reason.lower()


def test_preflight_missing_image(tmp_path, monkeypatch):
    _shim(tmp_path, monkeypatch,
          'if [ "$1" = "info" ]; then exit 0; fi\nexit 1\n')   # info ok, image inspect fails
    reason = sandbox.preflight(sandbox.SandboxConfig(enabled=True), str(tmp_path))
    assert reason is not None and "image" in reason.lower()


def test_preflight_image_inspect_timeout_blames_daemon_not_image(tmp_path, monkeypatch):
    # Tracked follow-up (Task 3 review): a HUNG daemon on `docker image inspect`
    # used to misreport as "image not present" with `docker pull` advice —
    # actively wrong. rc 124 (the _docker timeout sentinel) must blame the daemon.
    def _fake_docker(args, timeout=10):
        if args[:2] == ["image", "inspect"]:
            return subprocess.CompletedProcess(args=args, returncode=124,
                                               stdout="", stderr="timed out")
        return subprocess.CompletedProcess(args=args, returncode=0,
                                           stdout="ok", stderr="")
    monkeypatch.setattr(sandbox, "_docker", _fake_docker)
    monkeypatch.setattr(sandbox.shutil, "which", lambda _name: "/usr/bin/docker")
    monkeypatch.setattr(sandbox, "_free_disk_gb", lambda path: 100.0)
    reason = sandbox.preflight(sandbox.SandboxConfig(enabled=True), str(tmp_path))
    assert reason is not None and "timed out" in reason
    assert "docker pull" not in reason and "not present" not in reason


def test_preflight_disk_watermark(tmp_path, monkeypatch):
    _shim(tmp_path, monkeypatch, 'exit 0\n')
    monkeypatch.setattr(sandbox, "_free_disk_gb", lambda path: 1.0)
    reason = sandbox.preflight(sandbox.SandboxConfig(enabled=True), str(tmp_path))
    assert reason is not None and "disk" in reason.lower()
