"""GH #258 PR 6 (plan R-D4): one function decides Docker vs native for a project folder.

Truth table for `detect_runtime` / `is_project`, the `db_path` default, and the five
former `docker-compose.yml`-exists gates (up, down, upgrade, status, update) now routed
through `cli_runtime_mode` with the Docker branch unchanged.
"""
import json
import pathlib
import types

import pytest

from orcha_cli import cli_project_commands, cli_runtime_mode as rm, cli_status, cli_update


def _folder(tmp_path: pathlib.Path, cfg=None, compose=False) -> pathlib.Path:
    if cfg is not None:
        (tmp_path / ".claude").mkdir(parents=True, exist_ok=True)
        (tmp_path / ".claude" / "orcha.json").write_text(json.dumps(cfg))
    if compose:
        (tmp_path / ".orcha").mkdir(parents=True, exist_ok=True)
        (tmp_path / ".orcha" / "docker-compose.yml").write_text("name: orcha-demo\n")
    return tmp_path


# (orcha.json, compose file present) -> (detect_runtime, is_project). The cases live in a
# fixture shared with the Mac app's folderModes.test.ts (GH #258 D2) so the two rules can't drift.
_CASES = json.loads(
    (pathlib.Path(__file__).parent / "fixtures" / "runtime_mode_cases.json").read_text())["cases"]
TRUTH_TABLE = [
    pytest.param(c["orcha_json"], c["compose"], c["runtime"], c["is_project"], id=c["name"])
    for c in _CASES if c["runtime"] != "error"
]


@pytest.mark.parametrize("cfg,compose,runtime,project", TRUTH_TABLE)
def test_detect_runtime_and_is_project_truth_table(tmp_path, cfg, compose, runtime, project):
    root = _folder(tmp_path, cfg, compose)
    assert rm.detect_runtime(root) == runtime
    assert rm.is_project(root) is project


@pytest.mark.parametrize("case", [c for c in _CASES if c["runtime"] == "error"], ids=lambda c: c["name"])
def test_shared_error_cases_raise_and_are_not_projects(tmp_path, case):
    root = _folder(tmp_path, case["orcha_json"], case["compose"])
    with pytest.raises(ValueError):
        rm.detect_runtime(root)
    assert rm.is_project(root) is case["is_project"]


def test_unknown_runtime_is_an_error_not_a_silent_default(tmp_path):
    root = _folder(tmp_path, {"runtime": "podman"}, compose=True)
    with pytest.raises(ValueError, match="podman"):
        rm.detect_runtime(root)
    assert rm.is_project(root) is False
    with pytest.raises(SystemExit, match="unknown runtime 'podman'"):
        rm.require_project(root, "missing")


def test_require_project_returns_runtime_or_exits_with_the_callers_message(tmp_path):
    assert rm.require_project(_folder(tmp_path / "d", None, True), "x") == rm.DOCKER
    assert rm.require_project(_folder(tmp_path / "n", {"runtime": "native"}), "x") == rm.NATIVE
    with pytest.raises(SystemExit, match="^nope$"):
        rm.require_project(_folder(tmp_path / "e", {"connected": True}), "nope")


def test_unreadable_config_counts_as_absent(tmp_path):
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "orcha.json").write_text("{not json")
    assert rm.read_config(tmp_path) == {}
    (tmp_path / ".claude" / "orcha.json").write_text("[1, 2]")
    assert rm.read_config(tmp_path) == {}


def test_db_path_default_relative_and_absolute(tmp_path):
    assert rm.db_path(tmp_path, {}) == tmp_path / ".orcha" / "orcha.db"
    assert rm.db_path(tmp_path, {"db_path": "data/x.db"}) == tmp_path / "data" / "x.db"
    assert rm.db_path(tmp_path, {"db_path": "/var/tmp/y.db"}) == pathlib.Path("/var/tmp/y.db")
    _folder(tmp_path, {"runtime": "native", "db_path": "z.db"})
    assert rm.db_path(tmp_path) == tmp_path / "z.db"


# --- the five gates -------------------------------------------------------------------


class _Services:
    """Records compose calls; every daemon helper is a no-op."""

    def __init__(self):
        self.compose = []

    def _compose(self, orcha_dir, *args):
        self.compose.append(args)

    def _install_project_preferences(self, _cwd):
        return None

    def ensure_daemon(self, *_a, **_k):
        pass

    def stop_daemon(self, *_a, **_k):
        pass

    # native `orcha upgrade` helpers (no compose involved)
    PKG_TEMPLATES = pathlib.Path("/nonexistent")

    def _migration_tip(self, _source):
        return 0

    def _install_orcha_skill_templates(self, _root):
        return [], []

    def _write_hook_config(self, _claude_dir):
        return False


@pytest.fixture
def bridge_noop(monkeypatch):
    from orcha_cli import terminal_bridge

    monkeypatch.setattr(terminal_bridge, "ensure_bridge", lambda *a, **k: None)
    monkeypatch.setattr(terminal_bridge, "stop_bridge", lambda *a, **k: None)


def test_up_and_down_docker_branch_unchanged(tmp_path, monkeypatch, bridge_noop):
    monkeypatch.chdir(_folder(tmp_path, {"project_name": "demo"}, compose=True))
    svc = _Services()
    cli_project_commands.cmd_up(types.SimpleNamespace(project=None), svc)
    cli_project_commands.cmd_down(types.SimpleNamespace(project=None, volumes=True), svc)
    assert svc.compose == [("up", "-d"), ("down", "-v")]


@pytest.mark.parametrize("verb", ["cmd_up", "cmd_down"])
def test_up_down_refuse_a_folder_that_owns_no_stack(tmp_path, monkeypatch, bridge_noop, verb):
    monkeypatch.chdir(_folder(tmp_path, {"connected": True, "api_port": 8004}))
    svc = _Services()
    with pytest.raises(SystemExit, match="no .orcha/docker-compose.yml here"):
        getattr(cli_project_commands, verb)(types.SimpleNamespace(project=None, volumes=False), svc)
    assert svc.compose == []


@pytest.mark.parametrize("verb", ["cmd_up", "cmd_down", "cmd_upgrade"])
def test_native_project_never_reaches_compose(tmp_path, monkeypatch, bridge_noop, verb):
    monkeypatch.chdir(_folder(tmp_path, {"runtime": "native", "api_port": 8123}, compose=True))
    from orcha_cli import cli_native_lifecycle

    monkeypatch.setattr(cli_native_lifecycle, "up", lambda *a, **k: None)
    monkeypatch.setattr(cli_native_lifecycle, "down", lambda *a, **k: None)
    monkeypatch.setattr(cli_native_lifecycle.cli_http, "_get_json", lambda *a, **k: None)
    svc = _Services()
    args = types.SimpleNamespace(project=None, volumes=False, allow_downgrade=False)
    getattr(cli_project_commands, verb)(args, svc)  # native branches complete without compose
    assert svc.compose == []


def test_upgrade_still_requires_orcha_json_for_docker(tmp_path, monkeypatch):
    monkeypatch.chdir(_folder(tmp_path, None, compose=True))
    with pytest.raises(SystemExit, match="`orcha upgrade` is for an existing project"):
        cli_project_commands.cmd_upgrade(types.SimpleNamespace(), _Services())


def test_status_runs_compose_ps_only_for_docker(tmp_path, monkeypatch, capsys):
    svc = _Services()
    monkeypatch.chdir(_folder(tmp_path / "d", {"project_name": "d"}, compose=True))
    cli_status.status_command(None, svc)
    monkeypatch.chdir(_folder(tmp_path / "n", {"project_name": "n", "runtime": "native"}, compose=True))
    cli_status.status_command(None, svc)
    assert svc.compose == [("ps",)]


def test_update_gate(tmp_path, monkeypatch):
    calls = []
    kwargs = dict(
        source_root=lambda: None, brew_keg=lambda: None, reinstall_cli=lambda _p: True,
        brew_upgrade=lambda _k: True, upgrade=lambda a: calls.append("upgrade"),
        ensure_notifier=lambda *a, **k: calls.append("notifier"),
    )
    monkeypatch.chdir(_folder(tmp_path / "none", {"connected": True}))
    with pytest.raises(SystemExit, match="run `orcha update` from an existing project"):
        cli_update.update_command(types.SimpleNamespace(no_self=True), **kwargs)
    monkeypatch.chdir(_folder(tmp_path / "compose-only", None, compose=True))
    with pytest.raises(SystemExit, match="run `orcha update` from an existing project"):
        cli_update.update_command(types.SimpleNamespace(no_self=True), **kwargs)
    assert calls == []
