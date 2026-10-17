"""Hook timeouts on every Orcha hook + personal desktop tabs never take an agent identity.

1. Every command hook Orcha writes into a project's .claude/settings.json (and the Codex
   .codex/hooks.json) carries an explicit, bounded ``timeout``; ``orcha upgrade`` brings the
   timeout of ALREADY-registered Orcha hooks to the template value idempotently, without
   touching user-authored hooks.
2. Orcha Desktop marks every pty it launches with ORCHA_PERSONAL_SESSION=1. The hooks that
   bind or inject an agent identity (rehydrate, watch, poll-inbox, unwatch,
   task-claim-guard) exit 0 silently there; infrastructure hooks keep working; and no
   managed-session spawn path (notifier daemon, headless / resident workers, terminal
   bridge, paired `orcha use`) lets the marker leak into an agent.
"""
import argparse
import json
import os
import pathlib

import pytest

from orcha_cli import __main__ as cli  # noqa: E402  (conftest puts orcha-cli on sys.path)
from orcha_cli import cli_hooks, notifier, personal_session, terminal_bridge
from orcha_cli.terminal_bridge_protocol import build_spawn_env


# ---------------------------------------------------------------- 1. timeouts


def _all_hooks(settings: dict):
    for event, entries in settings["hooks"].items():
        for entry in entries:
            for hook in entry.get("hooks", []):
                yield event, hook


def test_every_template_hook_has_a_bounded_timeout():
    for spec in cli_hooks.HOOKS + cli_hooks.CODEX_HOOKS:
        assert len(spec) == 4, spec
        event, command, _matcher, timeout = spec
        assert command.startswith("orcha "), spec
        assert isinstance(timeout, int) and 0 < timeout <= 660, spec
        if event == "SessionStart":
            assert timeout <= 10, spec  # daemons / --ensure / reachability / rehydrate
    # The blocking file-lock guard keeps a cap ABOVE its own wait budget, never unbounded.
    from orcha_cli import cli_file_lock
    blocking = {(e, c): t for e, c, _m, t in cli_hooks.HOOKS}[("PreToolUse", "orcha file-guard")]
    assert cli_file_lock.DEFAULT_WAIT_SECS < blocking <= 660


def test_fresh_settings_get_a_timeout_on_every_orcha_hook(tmp_path):
    claude = tmp_path / ".claude"
    claude.mkdir()
    assert cli_hooks.write_hook_config(claude) is True
    settings = json.loads((claude / "settings.json").read_text())
    expected = {(e, c): t for e, c, _m, t in cli_hooks.HOOKS}
    seen = {}
    for event, hook in _all_hooks(settings):
        seen[(event, hook["command"])] = hook.get("timeout")
    assert seen == expected
    codex = json.loads((tmp_path / ".codex" / "hooks.json").read_text())
    assert all(isinstance(h.get("timeout"), int) for _e, h in _all_hooks(codex))


def _make_project(tmp_path: pathlib.Path, settings: dict) -> pathlib.Path:
    orcha = tmp_path / ".orcha"
    orcha.mkdir()
    (orcha / "docker-compose.yml").write_text("services: {}\n")
    claude = tmp_path / ".claude"
    claude.mkdir()
    (claude / "orcha.json").write_text(json.dumps(
        {"project_name": "demo", "db_port": 5432, "api_port": 8000, "bridge_port": 8765}))
    (claude / "settings.json").write_text(json.dumps(settings, indent=2) + "\n")
    return claude


def test_upgrade_adds_timeouts_to_existing_orcha_hooks_and_leaves_user_hooks(tmp_path, monkeypatch):
    user_hook = {"type": "command", "command": "./my-own-startup.sh"}
    legacy = {"hooks": {
        "SessionStart": [
            {"hooks": [{"type": "command", "command": "orcha watch --detach"}]},
            {"hooks": [{"type": "command", "command": "orcha rehydrate"}]},
            {"hooks": [dict(user_hook)]},
        ],
        "PreToolUse": [
            {"matcher": "*", "hooks": [{"type": "command", "command": "orcha file-guard",
                                        "timeout": 660}]},
            {"matcher": "Bash", "hooks": [{"type": "command", "command": "user-guard",
                                           "timeout": 999}]},
        ],
    }}
    claude = _make_project(tmp_path, legacy)
    monkeypatch.setattr(cli, "_compose", lambda *a, **k: None)
    monkeypatch.setattr(cli, "_copy_tree", lambda *a, **k: None)
    monkeypatch.setattr(cli, "ensure_daemon", lambda *a, **k: None)
    monkeypatch.setattr(terminal_bridge, "ensure_bridge", lambda *a, **k: None)
    monkeypatch.chdir(tmp_path)

    cli.cmd_upgrade(argparse.Namespace())
    first = (claude / "settings.json").read_text()
    settings = json.loads(first)

    expected = {(e, c): t for e, c, _m, t in cli_hooks.HOOKS}
    for event, hook in _all_hooks(settings):
        key = (event, hook["command"])
        if key in expected:
            assert hook.get("timeout") == expected[key], key
    start = [h for _e, h in _all_hooks(settings) if _e == "SessionStart"]
    assert user_hook in start                                  # user hook untouched (no timeout added)
    pre = settings["hooks"]["PreToolUse"]
    assert {"type": "command", "command": "user-guard", "timeout": 999} in pre[1]["hooks"]
    # No duplicate registrations of the pre-existing Orcha hooks.
    cmds = [h["command"] for h in start]
    assert cmds.count("orcha watch --detach") == 1 and cmds.count("orcha rehydrate") == 1

    cli.cmd_upgrade(argparse.Namespace())                      # idempotent
    assert (claude / "settings.json").read_text() == first


def test_write_hook_config_refreshes_a_stale_orcha_timeout(tmp_path):
    claude = tmp_path / ".claude"
    claude.mkdir()
    cli_hooks.write_hook_config(claude)
    settings = json.loads((claude / "settings.json").read_text())
    for _e, hook in _all_hooks(settings):
        if hook["command"] == "orcha rehydrate":
            hook["timeout"] = 600
    (claude / "settings.json").write_text(json.dumps(settings))
    assert cli_hooks.write_hook_config(claude) is True
    again = json.loads((claude / "settings.json").read_text())
    assert [h["timeout"] for _e, h in _all_hooks(again) if h["command"] == "orcha rehydrate"] == [10]
    assert cli_hooks.write_hook_config(claude) is False        # nothing left to change


# ---------------------------------------------------------------- 2. personal sessions

BINDING = {"alias": "Atlas", "agent_id": "a-1", "container_id": "c-1", "kind": "ai"}


@pytest.fixture
def project(tmp_path, monkeypatch):
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "orcha.json").write_text(json.dumps({"api_base_url": "http://x"}))
    monkeypatch.chdir(tmp_path)
    for var in ("ORCHA_HEADLESS_WORKER", "ORCHA_LIVE", personal_session.ENV):
        monkeypatch.delenv(var, raising=False)
    return tmp_path


def _personal(monkeypatch):
    monkeypatch.setenv(personal_session.ENV, "1")


def test_marker_must_be_exactly_one(monkeypatch):
    monkeypatch.delenv(personal_session.ENV, raising=False)
    assert personal_session.active() is False
    monkeypatch.setenv(personal_session.ENV, "0")
    assert personal_session.active() is False
    monkeypatch.setenv(personal_session.ENV, "1")
    assert personal_session.active() is True


def _brief():
    return {"identity": {"alias": "Atlas", "role": "Architect", "id": "a-1"}}


def test_rehydrate_injects_identity_in_an_ordinary_tab(project, monkeypatch, capsys):
    monkeypatch.setattr(cli, "_resolve_any_binding", lambda *a, **k: dict(BINDING))
    monkeypatch.setattr(cli, "_get_json", lambda *a, **k: _brief())
    cli.cmd_rehydrate(argparse.Namespace(alias=None))
    assert "you are Atlas (Architect)" in capsys.readouterr().out


def test_rehydrate_is_silent_in_a_personal_tab(project, monkeypatch, capsys):
    _personal(monkeypatch)
    calls = []
    monkeypatch.setattr(cli, "_resolve_any_binding", lambda *a, **k: calls.append(1) or dict(BINDING))
    monkeypatch.setattr(cli, "_get_json", lambda *a, **k: calls.append(2) or _brief())
    cli.cmd_rehydrate(argparse.Namespace(alias=None))
    assert capsys.readouterr().out == ""
    assert calls == []


def test_watch_never_binds_a_personal_tab(project, monkeypatch, capsys):
    _personal(monkeypatch)
    calls = []
    monkeypatch.setattr(cli, "_resolve_any_binding", lambda *a, **k: calls.append(1) or dict(BINDING))
    monkeypatch.setattr(os, "fork", lambda: pytest.fail("watch forked a poller for a personal tab"))
    cli.cmd_watch(argparse.Namespace(alias=None, detach=True, interval=10))
    assert capsys.readouterr().out == ""
    assert calls == []
    assert not list((project / ".claude").glob(".orcha-watch-*.pid"))


def test_poll_inbox_surfaces_nothing_in_a_personal_tab(project, monkeypatch, capsys):
    state = project / ".claude" / ".orcha-watch-state-Atlas.json"
    state.write_text(json.dumps({"seen_ids": ["r1"], "queued": [
        {"channel": "inbox", "id": "r1", "from": "Mira", "preview": "hi"}]}))
    monkeypatch.setattr(cli, "_resolve_any_binding", lambda *a, **k: dict(BINDING))
    _personal(monkeypatch)
    cli.cmd_poll_inbox(argparse.Namespace(alias=None))
    assert capsys.readouterr().out == ""
    assert json.loads(state.read_text())["queued"]              # not drained: still Atlas's
    monkeypatch.delenv(personal_session.ENV)
    cli.cmd_poll_inbox(argparse.Namespace(alias=None))
    assert "new item for Atlas" in capsys.readouterr().out      # ordinary tab still works


def test_unwatch_leaves_agents_watchers_alone_in_a_personal_tab(project, monkeypatch, capsys):
    pid_file = project / ".claude" / ".orcha-watch-Atlas.pid"
    pid_file.write_text("999999")
    killed = []
    monkeypatch.setattr(os, "kill", lambda pid, sig: killed.append(pid))
    _personal(monkeypatch)
    cli.cmd_unwatch(argparse.Namespace())
    assert pid_file.exists() and killed == []
    assert capsys.readouterr().out == ""


def test_task_claim_guard_never_posts_as_the_agent_from_a_personal_tab(project, monkeypatch, capsys):
    _personal(monkeypatch)
    monkeypatch.setattr(cli, "_read_hook_stdin", lambda: pytest.fail("claim guard ran"))
    monkeypatch.setattr(cli, "_post_json", lambda *a, **k: pytest.fail("posted as the agent"))
    cli.cmd_task_claim_guard(argparse.Namespace(alias=None))
    assert capsys.readouterr().out == ""


def test_infrastructure_hooks_still_run_in_a_personal_tab(project, monkeypatch):
    _personal(monkeypatch)
    called = {}
    monkeypatch.setattr(notifier, "ensure_daemon", lambda *a, **k: called.setdefault("notifier", True))
    notifier.cmd_notifier(argparse.Namespace(ensure=True, quiet=True))
    assert called.get("notifier") is True
    posted = []
    monkeypatch.setattr(cli, "_resolve_any_binding", lambda *a, **k: dict(BINDING))
    monkeypatch.setattr(cli, "_post_json", lambda url, body: posted.append(url))
    monkeypatch.setattr(cli, "_detect_tmux_target", lambda: None)
    cli.cmd_reachability(argparse.Namespace(alias=None, quiet=True))
    assert posted == ["http://x/api/agents/a-1/reachability"]
    from orcha_cli import cli_file_lock
    assert cli_file_lock.enabled() is True


# ------------------------------------------- managed spawns never inherit the marker


def test_paired_terminal_env_strips_the_marker():
    env = build_spawn_env("Atlas", True, base_env={personal_session.ENV: "1", "PATH": "/bin"})
    assert personal_session.ENV not in env
    assert env["ORCHA_LIVE"] == "1" and env["PATH"] == "/bin"


def test_headless_worker_env_strips_the_marker(monkeypatch, tmp_path):
    captured = {}

    class FakePopen:
        def __init__(self, argv, cwd=None, env=None, **kw):
            captured["env"] = env
            self.pid = 1
    monkeypatch.setenv(personal_session.ENV, "1")
    monkeypatch.setattr(notifier.shutil, "which", lambda x: "/usr/bin/claude")
    monkeypatch.setattr(notifier.subprocess, "Popen", FakePopen)
    sent, _, _ = notifier.spawn_headless(str(tmp_path), "wake!", None, dry_run=False, alias="B")
    assert sent is True
    assert personal_session.ENV not in captured["env"]
    assert captured["env"]["ORCHA_HEADLESS_WORKER"] == "1"


def test_notifier_daemon_started_from_a_personal_tab_does_not_inherit_it(monkeypatch, tmp_path):
    wt = tmp_path / "proj"
    (wt / ".claude").mkdir(parents=True)
    (wt / ".claude" / "orcha.json").write_text(
        '{"api_base_url":"http://x","current_container_id":"cid-1"}')
    monkeypatch.setattr(notifier, "_global_pid_path", lambda cid: tmp_path / f"n-{cid}.pid")
    monkeypatch.setattr(notifier, "_probe_container", lambda api, cid: "ok")
    monkeypatch.setattr(notifier, "_pid_alive", lambda pid: False)
    monkeypatch.setattr(notifier.shutil, "which", lambda x: "/usr/bin/orcha")
    captured = {}

    class FakePopen:
        def __init__(self, argv, *a, **k):
            captured.update(k)
            self.pid = 4242
    monkeypatch.setattr(notifier.subprocess, "Popen", FakePopen)
    monkeypatch.setenv(personal_session.ENV, "1")
    assert notifier.ensure_daemon(wt, quiet=True) is True
    assert captured["env"] is not None
    assert personal_session.ENV not in captured["env"]
    assert captured["stdin"] is notifier.subprocess.DEVNULL and captured["start_new_session"]


def test_terminal_bridge_started_from_a_personal_tab_does_not_inherit_it(monkeypatch, tmp_path):
    from orcha_cli import terminal_bridge_daemon
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "orcha.json").write_text("{}")
    monkeypatch.delenv("ORCHA_HEADLESS_WORKER", raising=False)
    monkeypatch.delenv("ORCHA_LIVE", raising=False)
    monkeypatch.setenv(personal_session.ENV, "1")
    captured = {}

    class FakePopen:
        def __init__(self, argv, *a, **k):
            captured.update(k)
            self.pid = 4343
    monkeypatch.setattr(terminal_bridge_daemon.subprocess, "Popen", FakePopen)
    assert terminal_bridge.ensure_bridge(tmp_path, quiet=True) is True
    assert personal_session.ENV not in captured["env"]
    assert captured["stdin"] is terminal_bridge_daemon.subprocess.DEVNULL
    assert captured["start_new_session"] is True


def test_live_orcha_use_strips_the_marker(monkeypatch, tmp_path):
    from orcha_cli import cli_live
    monkeypatch.setenv(personal_session.ENV, "1")
    monkeypatch.setenv("ORCHA_LIVE_EXEC", "true")
    monkeypatch.setattr(cli_live, "_read_live_binding", lambda cwd, bf: ({"agent_id": "a-1"}, "http://x"))
    monkeypatch.setattr(cli_live, "_launch_selection", lambda *a, **k: (None, "claude"))
    captured = {}

    def fake_exec(cmd, argv, env):
        captured["env"] = env
        raise SystemExit(0)
    monkeypatch.setattr(cli_live.os, "execvpe", fake_exec)
    with pytest.raises(SystemExit):
        cli_live.exec_live_session(
            tmp_path, "Atlas", tmp_path / "b.json",
            boot_prefix=lambda *a: None, agent_launch=lambda *a: (None, None),
            build_argv=lambda *a: ["claude"], resolve_executable=lambda r: "claude",
            runtime_leaf=lambda r: "claude", normalize=lambda r: r,
        )
    assert personal_session.ENV not in captured["env"]
    assert captured["env"]["ORCHA_ALIAS"] == "Atlas"


# ------------------------------------- daemon-starting hooks release the hook pipe


def test_watch_detach_does_not_hold_the_hook_pipe_open(tmp_path):
    """Claude reads a hook's stdout until EOF: a detached watcher that kept the inherited
    pipe would stall SessionStart for the life of the session. Real subprocess, dead API."""
    import signal
    import subprocess
    import sys
    import time

    (tmp_path / ".claude" / "orcha-tabs").mkdir(parents=True)
    (tmp_path / ".claude" / "orcha.json").write_text('{"api_base_url":"http://127.0.0.1:9"}')
    (tmp_path / ".claude" / "orcha-tabs" / "Atlas.json").write_text(json.dumps(BINDING))
    env = {k: v for k, v in os.environ.items()
           if k not in ("ORCHA_HEADLESS_WORKER", "ORCHA_LIVE", "ORCHA_ALIAS", personal_session.ENV)}
    env["PYTHONPATH"] = str(pathlib.Path(cli.__file__).resolve().parents[1])
    proc = subprocess.Popen(
        [sys.executable, "-m", "orcha_cli", "watch", "--detach", "--interval", "30"],
        cwd=tmp_path, env=env, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    pid_file = tmp_path / ".claude" / ".orcha-watch-Atlas.pid"
    try:
        proc.communicate(timeout=10)                         # EOF, not a hang
        assert proc.returncode == 0
        deadline = time.time() + 5
        while not pid_file.exists() and time.time() < deadline:
            time.sleep(0.05)
        assert pid_file.exists()                             # the watcher really detached
    finally:
        if proc.poll() is None:
            proc.kill()
        try:
            os.kill(int(pid_file.read_text()), signal.SIGTERM)
        except (OSError, ValueError):
            pass
