"""GH #258 PR 6 (plan R2): `orcha up/down/status` for a native-runtime project.

The compose wrapper is a tripwire here: a native project must never reach it.
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import types

import pytest

from orcha_cli import (
    cli_bridge,
    cli_native_lifecycle,
    cli_project_commands,
    cli_serve_support,
    cli_service,
    cli_stacks_registry,
    cli_status,
)


class _Tripwire:
    def _compose(self, *_a, **_k):
        raise AssertionError("compose must never run for a native project")

    def stop_daemon(self, *_a, **_k):
        raise AssertionError("serve owns the notifier under native")

    def ensure_daemon(self, *_a, **_k):
        raise AssertionError("serve owns the notifier under native")

    def _install_project_preferences(self, _cwd):
        return None


@pytest.fixture(autouse=True)
def _no_launchd(monkeypatch):
    """The launchd branches have their own suite (test_cli_service.py); here the service is
    never installed, so `up`/`down` take the plain-process path on any OS."""
    monkeypatch.setattr(cli_service, "PLATFORM", "linux")


@pytest.fixture
def native(tmp_path, monkeypatch):
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path / "home")
    root = tmp_path / "proj"
    (root / ".claude").mkdir(parents=True)
    (root / ".claude" / "orcha.json").write_text(json.dumps(
        {"project_name": "proj", "runtime": "native", "api_port": 8123, "bridge_port": 8770,
         "api_base_url": "http://localhost:8123"}))
    monkeypatch.chdir(root)
    return root


def _sleeper():
    return subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])


def _state(root, pid, **children):
    cli_serve_support.write_state(root, {"status": "running", "serve_pid": pid,
                                         "children": children})


def test_up_spawns_detached_serve(native):
    spawned = []

    def fake_popen(argv, **kw):
        spawned.append((argv, kw))
        return types.SimpleNamespace(pid=4242)

    cli_native_lifecycle.up(native, popen=fake_popen, http_ok=lambda _u: True)
    (argv, kw), = spawned
    assert argv[1:] == ["-m", "orcha_cli", "serve", "--project-dir", str(native)]
    assert kw["start_new_session"] is True and kw["cwd"] == str(native)
    assert (native / ".orcha" / "logs" / "serve.log").exists()


def test_cmd_up_dispatches_native(native, monkeypatch):
    calls = []
    monkeypatch.setattr(cli_native_lifecycle, "up", lambda root: calls.append(root))
    cli_project_commands.cmd_up(types.SimpleNamespace(project=None), _Tripwire())
    assert calls == [native]


def test_up_is_a_no_op_when_serve_and_portal_answer(native, capsys):
    proc = _sleeper()
    try:
        _state(native, proc.pid)
        cli_native_lifecycle.up(native, popen=lambda *a, **k: pytest.fail("respawned"),
                                http_ok=lambda _u: True)
    finally:
        proc.kill()
    assert f"already running (orcha serve pid {proc.pid})" in capsys.readouterr().out


def test_up_warns_when_portal_never_answers(native, capsys):
    cli_native_lifecycle.up(native, popen=lambda *a, **k: types.SimpleNamespace(pid=1),
                            http_ok=lambda _u: False, wait_secs=0)
    assert "portal did not answer" in capsys.readouterr().out


def test_down_sigterms_serve_and_unregisters(native, capsys):
    cli_stacks_registry.register("proj", path=native, api_port=8123, bridge_port=8770,
                                 cli_version="t")
    proc = _sleeper()
    _state(native, proc.pid)
    sent = []

    def kill(pid, sig):
        sent.append(sig)
        os.kill(pid, sig)

    cli_project_commands.cmd_down(types.SimpleNamespace(project=None, volumes=False), _Tripwire())
    proc.wait(timeout=5)
    assert proc.returncode == -signal.SIGTERM
    assert "proj" not in cli_stacks_registry.read_registry()
    cli_native_lifecycle.down(native, kill=kill)  # second call: nothing running, still clean
    assert sent == [] and "not running" in capsys.readouterr().out


def test_down_escalates_to_sigkill(native):
    proc = subprocess.Popen([sys.executable, "-c",
                             "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN);"
                             "print('ready', flush=True); time.sleep(60)"],
                            stdout=subprocess.PIPE)
    proc.stdout.readline()
    _state(native, proc.pid)
    cli_native_lifecycle.down(native, stop_secs=0.5)
    proc.wait(timeout=5)
    assert proc.returncode == -signal.SIGKILL


def _make_db(root):
    db = root / ".orcha" / "orcha.db"
    db.parent.mkdir(exist_ok=True)
    for suffix in ("", "-wal", "-shm"):
        db.with_name(db.name + suffix).write_text("x")
    return db


def test_down_v_needs_yes_off_a_terminal_and_deletes_nothing(native, monkeypatch):
    db = _make_db(native)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: False)
    with pytest.raises(SystemExit, match="pass --yes"):
        cli_project_commands.cmd_down(
            types.SimpleNamespace(project=None, volumes=True, yes=False), _Tripwire())
    assert db.exists()


def test_down_v_yes_deletes_db_wal_shm(native):
    db = _make_db(native)
    cli_project_commands.cmd_down(
        types.SimpleNamespace(project=None, volumes=True, yes=True), _Tripwire())
    assert not any(db.with_name(db.name + s).exists() for s in ("", "-wal", "-shm"))


@pytest.mark.parametrize("answer,kept", [("n", True), ("y", False)])
def test_down_v_prompt(native, monkeypatch, answer, kept):
    db = _make_db(native)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: True)
    monkeypatch.setattr("builtins.input", lambda _p: answer)
    try:
        cli_native_lifecycle.down(native, volumes=True)
    except SystemExit:
        pass
    assert db.exists() is kept


def test_status_native_block(native, capsys):
    _make_db(native)
    proc = _sleeper()
    try:
        _state(native, proc.pid, portal={"pid": 11, "status": "running", "restarts": 2})
        cli_status.status_command(None, _Tripwire())
    finally:
        proc.kill()
    out = capsys.readouterr().out
    assert "runtime:              native" in out and "db port" not in out
    assert f"running (pid {proc.pid})" in out and "portal" in out and "restarts 2" in out
    assert str(native / ".orcha" / "orcha.db") in out and "orcha logs -f" in out


def test_foreground_bridge_writes_its_own_pidfile(native, monkeypatch):
    from orcha_cli import terminal_bridge

    async def fake_serve(*_a, **_k):
        return None

    monkeypatch.setattr(terminal_bridge, "serve_bridge", fake_serve)
    cli_bridge.terminal_bridge_command(types.SimpleNamespace(
        ensure=False, api_base=None, host=None, port=None, quiet=True))
    pidfile = native / ".claude" / ".orcha-terminal-bridge.pid"
    assert pidfile.read_text() == str(os.getpid())


# --- `orcha init --runtime native|docker` ----------------------------------------------


def _init_ns(**over):
    ns = dict(name="demo", api_port=None, db_port=None, bridge_port=None, force=False,
              reset_data=False, no_container=False, objective="x", as_user="tester",
              no_github=True, runtime="docker")
    ns.update(over)
    return types.SimpleNamespace(**ns)


@pytest.fixture
def init_stubs(tmp_path, monkeypatch):
    from orcha_cli import __main__ as cli
    from orcha_cli import terminal_bridge as tb

    calls = {"compose": [], "copy": [], "daemon": [], "bridge": [], "native_up": []}
    monkeypatch.setattr(cli, "_compose", lambda *a, **k: calls["compose"].append(a[1:]))
    monkeypatch.setattr(cli, "_copy_tree", lambda *a, **k: calls["copy"].append(a))
    monkeypatch.setattr(cli, "ensure_daemon", lambda *a, **k: calls["daemon"].append(a))
    monkeypatch.setattr(tb, "ensure_bridge", lambda *a, **k: calls["bridge"].append(a))
    monkeypatch.setattr(cli, "_wait_for_portal", lambda *a, **k: None)
    monkeypatch.setattr(cli, "_find_free_port", lambda start, span=100: start)
    monkeypatch.setattr(cli, "_post_json", lambda url, body: (
        {"container_id": "cid-1"} if url.endswith("/api/containers") else {"agent_id": "a-1"}))
    monkeypatch.setattr(cli, "_put_json", lambda url, body: dict(body))
    monkeypatch.setattr(cli_native_lifecycle, "up", lambda root: calls["native_up"].append(root))
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path / "home")
    root = tmp_path / "fresh"
    root.mkdir()
    monkeypatch.chdir(root)
    return cli, calls, root


def test_init_native_writes_runtime_and_never_touches_docker(init_stubs, capsys):
    cli, calls, root = init_stubs
    cli.cmd_init(_init_ns(runtime="native"))
    cfg = json.loads((root / ".claude" / "orcha.json").read_text())
    assert cfg["runtime"] == "native" and cfg["db_path"] == ".orcha/orcha.db"
    assert cfg["bind"] == "loopback" and "db_port" not in cfg
    assert not (root / ".orcha" / "docker-compose.yml").exists()
    assert calls["compose"] == [] and calls["copy"] == []
    assert calls["daemon"] == [] and calls["bridge"] == []  # serve owns them
    assert calls["native_up"] == [root]
    assert f"db:       {root / '.orcha' / 'orcha.db'}" in capsys.readouterr().out


def test_init_runtime_docker_is_unchanged_and_says_deprecated(init_stubs, capsys):
    cli, calls, root = init_stubs
    cli.cmd_init(_init_ns())
    cfg = json.loads((root / ".claude" / "orcha.json").read_text())
    assert "runtime" not in cfg and cfg["db_port"] == 5432
    assert (root / ".orcha" / "docker-compose.yml").exists()
    assert ("up", "-d", "--build") in calls["compose"] and calls["native_up"] == []
    assert "Docker runtime is deprecated" in capsys.readouterr().out


def test_init_parser_runtime_flag_defaults_to_native():
    from orcha_cli import __main__ as cli

    parser = cli.build_parser()
    ns = parser.parse_args(["init"])
    assert ns.runtime == "native" and ns.no_service is False and ns.progress_json is False
    assert parser.parse_args(["init", "--runtime", "docker"]).runtime == "docker"
    assert parser.parse_args(["init", "--no-service", "--progress-json"]).no_service is True
    with pytest.raises(SystemExit):
        parser.parse_args(["init", "--runtime", "podman"])


def _installs(monkeypatch, *, fail=False):
    """Turn the launchd service on (as on a Mac) with `install` recorded, not run."""
    seen = []

    def install(root):
        seen.append(root)
        if fail:
            raise cli_service.ServiceError("Bootstrap failed: 5: I/O error")
        return {"plist": "/h/Library/LaunchAgents/io.openorcha.demo.plist", "changed": True}

    monkeypatch.setattr(cli_service, "PLATFORM", "darwin")
    monkeypatch.setattr(cli_service, "install", install)
    return seen


def test_init_native_installs_the_service_before_starting(init_stubs, monkeypatch):
    cli, calls, root = init_stubs
    seen = _installs(monkeypatch)
    monkeypatch.setattr(cli_native_lifecycle, "up", lambda r: calls["native_up"].append(
        ("up", list(seen))))
    cli.cmd_init(_init_ns(runtime="native"))
    assert seen == [root] and calls["native_up"] == [("up", [root])]  # install, then up


def test_init_no_service_and_docker_never_install(init_stubs, monkeypatch):
    cli, calls, root = init_stubs
    seen = _installs(monkeypatch)
    cli.cmd_init(_init_ns(runtime="native", no_service=True))
    assert seen == [] and calls["native_up"] == [root]


def test_init_service_failure_is_a_warning_not_a_dead_init(init_stubs, monkeypatch, capsys):
    cli, calls, root = init_stubs
    _installs(monkeypatch, fail=True)
    plist = cli_service.plist_path("demo")
    plist.parent.mkdir(parents=True)
    plist.write_text("half-written")
    cli.cmd_init(_init_ns(runtime="native"))
    assert calls["native_up"] == [root] and not plist.exists()  # up falls back to a plain serve
    assert "background service not installed" in capsys.readouterr().out


def _lines(out):
    return [json.loads(line) for line in out.splitlines()]


def test_init_progress_json_only_json_on_stdout(init_stubs, monkeypatch, capsys):
    cli, calls, root = init_stubs
    _installs(monkeypatch)
    cli.cmd_init(_init_ns(runtime="native", progress_json=True))
    captured = capsys.readouterr()
    lines = _lines(captured.out)  # every stdout line parses
    assert [(e["step"], e["status"]) for e in lines] == [
        ("ports", "ok"), ("config", "ok"), ("service", "start"), ("service", "ok"),
        ("start", "start"), ("start", "ok"), ("wait-portal", "start"), ("wait-portal", "ok"),
        ("create-container", "start"), ("create-container", "ok"),
        ("register-human", "start"), ("register-human", "ok"), ("done", "ok")]
    assert {e["step"] for e in lines} <= set(cli_init_steps())
    done = lines[-1]["detail"]
    assert done["container_id"] == "cid-1" and done["runtime"] == "native"
    assert done["api_base_url"] == "http://localhost:8000"
    assert done["db_path"] == str(root / ".orcha" / "orcha.db")
    assert "[orcha] ✓ initialized" in captured.err  # the human text moved to stderr


def cli_init_steps():
    from orcha_cli import cli_init
    return cli_init.STEPS


def test_init_progress_json_reports_the_failed_step(init_stubs, monkeypatch, capsys):
    cli, calls, root = init_stubs

    def boom(url, body):
        raise RuntimeError("HTTP 500")

    monkeypatch.setattr(cli, "_post_json", boom)
    with pytest.raises(SystemExit):
        cli.cmd_init(_init_ns(runtime="native", no_service=True, progress_json=True))
    lines = _lines(capsys.readouterr().out)
    assert ("service", "skip") in [(e["step"], e["status"]) for e in lines]
    last = lines[-1]
    assert (last["step"], last["status"]) == ("done", "error")
    assert last["detail"]["failed_step"] == "create-container"
    assert "HTTP 500" in last["detail"]["error"]


# ── native `orcha upgrade` / `orcha update` (plan R-D1 DB-tip guard) ─────────────────────

def _migrated_db(root, *versions):
    import sqlite3
    db = root / ".orcha" / "orcha.db"
    db.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY)")
    con.executemany("INSERT INTO schema_migrations VALUES (?)", [(v,) for v in versions])
    con.commit()
    con.close()
    return db


def test_db_tip_prefers_the_running_portal(native):
    _migrated_db(native, "005_a.sql")
    seen = []

    def get_json(url, timeout=5.0):
        seen.append(url)
        return {"applied": ["001_init.sql", "090_x.sql"], "count": 2, "tip": 90}

    assert cli_native_lifecycle.db_migration_tip(native, get_json=get_json) == 90
    assert seen == ["http://localhost:8123/api/admin/migrations"]


def test_db_tip_reads_the_sqlite_file_when_the_portal_is_down(native):
    _migrated_db(native, "001_init.sql", "072_next.sql", "baseline-note")
    tip = cli_native_lifecycle.db_migration_tip(native, get_json=lambda *_a, **_k: None)
    assert tip == 72


def test_db_tip_is_none_without_a_database(native):
    assert cli_native_lifecycle.db_migration_tip(
        native, get_json=lambda *_a, **_k: None) is None


class _UpgradeServices(_Tripwire):
    PKG_TEMPLATES = __import__("pathlib").Path("/nonexistent")

    def __init__(self, cli_tip):
        self.cli_tip, self.calls = cli_tip, []

    def _migration_tip(self, _source):
        return self.cli_tip

    def _install_orcha_skill_templates(self, root):
        self.calls.append("skills")
        return ["c"], ["s"]

    def _write_hook_config(self, claude_dir):
        self.calls.append(("hooks", claude_dir.name))
        return False


@pytest.fixture
def upgrade_stubs(native, monkeypatch):
    calls = []
    monkeypatch.setattr(cli_native_lifecycle, "down", lambda root, **k: calls.append(("down", k)))
    monkeypatch.setattr(cli_native_lifecycle, "up", lambda root, **k: calls.append(("up", k)))
    monkeypatch.setattr(cli_native_lifecycle.cli_http, "_get_json", lambda *_a, **_k: None)
    return calls


def _upgrade_args(**kw):
    return types.SimpleNamespace(allow_downgrade=False, **kw)


def test_native_upgrade_refuses_a_newer_database(native, upgrade_stubs):
    _migrated_db(native, "001_init.sql", "080_future.sql")
    services = _UpgradeServices(cli_tip=71)
    with pytest.raises(SystemExit) as exc:
        cli_project_commands.cmd_upgrade(_upgrade_args(), services)
    assert "080" in str(exc.value) and "071" in str(exc.value)
    assert services.calls == [] and upgrade_stubs == []  # refused before any write/restart


def test_native_upgrade_refreshes_hooks_and_restarts_serve(native, upgrade_stubs, capsys):
    _migrated_db(native, "001_init.sql", "071_now.sql")
    services = _UpgradeServices(cli_tip=72)
    cli_project_commands.cmd_upgrade(_upgrade_args(), services)
    assert services.calls == ["skills", ("hooks", ".claude")]
    assert [c[0] for c in upgrade_stubs] == ["down", "up"]
    assert upgrade_stubs[0][1] == {}  # never down -v
    assert "✓ upgraded" in capsys.readouterr().out


def test_native_upgrade_allow_downgrade_overrides(native, upgrade_stubs):
    _migrated_db(native, "080_future.sql")
    cli_project_commands.cmd_upgrade(
        types.SimpleNamespace(allow_downgrade=True), _UpgradeServices(cli_tip=71))
    assert [c[0] for c in upgrade_stubs] == ["down", "up"]


def test_native_update_leaves_notifier_and_bridge_to_serve(native, monkeypatch, capsys):
    from orcha_cli import cli_update, terminal_bridge

    def boom(*_a, **_k):
        raise AssertionError("serve owns the notifier and bridge under native")

    monkeypatch.setattr(terminal_bridge, "ensure_bridge", boom)
    upgraded = []
    cli_update.update_command(
        types.SimpleNamespace(no_self=True, no_bridge=False),
        source_root=None, brew_keg=None, reinstall_cli=None, brew_upgrade=None,
        upgrade=upgraded.append, ensure_notifier=boom,
    )
    assert len(upgraded) == 1
    assert "orcha serve restarted" in capsys.readouterr().out
