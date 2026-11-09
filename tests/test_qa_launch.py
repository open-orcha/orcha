"""Orcha QA: a project with QA on gives its workers the orcha-qa tool server (orcha_cli/qa/launch.py).

Off by default (no `.orcha/qa/mcp.json`): launches are unchanged. On: Claude workers get
`--mcp-config <file>`, Codex workers `-c mcp_servers.orcha-qa.*`, from the project root even when
the worker runs in a worktree; sandboxed workers never get it.
"""

from __future__ import annotations

import json
import pathlib

import pytest

from orcha_cli import notifier, notifier_headless
from orcha_cli.qa import launch


def _project(tmp_path: pathlib.Path, *, sandboxed: bool = False) -> pathlib.Path:
    (tmp_path / ".claude").mkdir()
    cfg = {"api_base_url": "http://127.0.0.1:8000", "current_container_id": "CID-QA"}
    if sandboxed:
        cfg["sandbox"] = {"enabled": True}
        (tmp_path / ".orcha").mkdir()
        (tmp_path / ".orcha" / "docker-compose.yml").write_text("name: orcha-proj\n")
    (tmp_path / ".claude" / "orcha.json").write_text(json.dumps(cfg))
    return tmp_path


class _Popen:
    calls: list = []

    def __init__(self, argv, **kw):
        _Popen.calls.append({"argv": list(argv), "env": dict(kw.get("env") or {})})
        self.pid = 4242


@pytest.fixture
def popen(monkeypatch):
    _Popen.calls = []
    monkeypatch.setattr(notifier.subprocess, "Popen", _Popen)
    monkeypatch.setattr(notifier, "_resolve_runtime_executable", lambda runtime: f"/usr/bin/{runtime}")
    monkeypatch.setitem(notifier_headless._CODEX_HOOK_TRUST_BYPASS, "/usr/bin/codex", False)
    monkeypatch.delenv("ORCHA_QA_TOOLS", raising=False)
    return _Popen


def test_off_by_default_no_flags(tmp_path):
    proj = _project(tmp_path)
    assert launch.config_path(proj) is None
    assert launch.claude_flags(proj) == []
    assert launch.codex_flags(proj) == []


def test_enable_writes_the_server_and_disable_removes_it(tmp_path, monkeypatch):
    monkeypatch.setattr(launch.shutil, "which", lambda name: "/opt/bin/orcha")
    proj = _project(tmp_path)
    path = launch.enable(proj)
    assert path == proj / ".orcha" / "qa" / "mcp.json"
    assert json.loads(path.read_text()) == {"mcpServers": {"orcha-qa": {"command": "/opt/bin/orcha", "args": ["qa", "mcp"]}}}
    assert launch.claude_flags(proj) == ["--mcp-config", str(path)]
    assert launch.codex_flags(proj) == [
        "-c", 'mcp_servers.orcha-qa.command="/opt/bin/orcha"',
        "-c", 'mcp_servers.orcha-qa.args=["qa", "mcp"]',
        "-c", "mcp_servers.orcha-qa.tool_timeout_sec=300",
    ]
    assert launch.disable(proj) is True
    assert launch.claude_flags(proj) == []
    assert launch.disable(proj) is False


def test_a_worktree_resolves_to_its_project(tmp_path):
    proj = _project(tmp_path)
    launch.enable(proj)
    gitdir = proj / ".git" / "worktrees" / "w1"
    gitdir.mkdir(parents=True)
    wt = proj / ".orcha-worktrees" / "w1"
    wt.mkdir(parents=True)
    (wt / ".git").write_text(f"gitdir: {gitdir}\n")
    assert launch.claude_flags(wt) == ["--mcp-config", str(proj / ".orcha" / "qa" / "mcp.json")]


def test_sandboxed_or_switched_off_gets_nothing(tmp_path, monkeypatch):
    proj = _project(tmp_path)
    launch.enable(proj)
    assert launch.claude_flags(proj, sandboxed=True) == []
    monkeypatch.setenv("ORCHA_QA_TOOLS", "off")
    assert launch.claude_flags(proj) == []


def test_a_garbled_config_is_ignored(tmp_path):
    proj = _project(tmp_path)
    path = launch.enable(proj)
    path.write_text("{not json")
    assert launch.claude_flags(proj) == []
    assert launch.codex_flags(proj) == []


def test_headless_claude_worker_gets_the_tools_only_when_on(tmp_path, popen):
    proj = _project(tmp_path)
    notifier.spawn_headless(str(proj), "do it", None, False, alias="Ada", runtime="claude")
    assert "--mcp-config" not in popen.calls[-1]["argv"]
    path = launch.enable(proj)
    notifier.spawn_headless(str(proj), "do it", None, False, alias="Ada", runtime="claude")
    argv = popen.calls[-1]["argv"]
    assert argv[argv.index("--mcp-config") + 1] == str(path)


def test_headless_codex_worker_gets_the_tools_before_the_prompt(tmp_path, popen):
    proj = _project(tmp_path)
    launch.enable(proj)
    notifier.spawn_headless(str(proj), "do it", None, False, alias="Ada", runtime="codex")
    argv = popen.calls[-1]["argv"]
    i = argv.index("-c", argv.index("--json"))
    assert any(a.startswith("mcp_servers.orcha-qa.command=") for a in argv)
    assert i < len(argv) - 1 and "do it" in argv[-1]


def test_resident_claude_worker_gets_the_tools(tmp_path, popen):
    proj = _project(tmp_path)
    path = launch.enable(proj)
    notifier.spawn_resident(str(proj), alias="Ada")
    argv = popen.calls[-1]["argv"]
    assert argv[argv.index("--mcp-config") + 1] == str(path)
