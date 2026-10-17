"""GH #258 PR 6 (plan R2): the machine-wide ``~/.orcha/stacks.json`` registry.

Register/unregister under ``flock`` (concurrent writers keep every entry), pruning of
entries whose ``state.json`` is stale or whose portal is down, ``orcha ls`` with no
``docker`` binary (the Docker lister is never called), the Docker merge when it exists,
and ``orcha serve`` registering its project on start.
"""
import json
import os
import pathlib
import subprocess
import sys
import time
import types

import pytest

from orcha_cli import cli_serve, cli_stacks_registry as reg, cli_status


@pytest.fixture(autouse=True)
def _home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    return home


def _project(tmp_path, name, *, state_age=0.0):
    root = tmp_path / name
    (root / ".orcha").mkdir(parents=True)
    state = root / ".orcha" / "state.json"
    state.write_text("{}")
    if state_age:
        old = time.time() - state_age
        os.utime(state, (old, old))
    return root


def _register(name, root, port):
    reg.register(name, path=root, api_port=port, bridge_port=port + 1000, cli_version="t")


def _portal_up(*ports):
    def get_json(url, **_):
        return {"containers": []} if any(f":{p}/" in url for p in ports) else None
    return get_json


def test_register_writes_entry_shape_and_unregister_removes(tmp_path, _home):
    root = _project(tmp_path, "alpha")
    _register("alpha", root, 8010)
    data = json.loads((_home / ".orcha" / "stacks.json").read_text())
    assert set(data) == {"alpha"}
    entry = data["alpha"]
    assert entry["path"] == str(root.resolve())
    assert (entry["api_port"], entry["bridge_port"], entry["runtime"]) == (8010, 9010, "native")
    assert entry["cli_version"] == "t" and entry["updated_at"]
    assert (_home / ".orcha" / "stacks.lock").exists()
    assert reg.unregister("alpha") is True
    assert reg.unregister("alpha") is False
    assert reg.read_registry() == {}


def test_concurrent_registers_keep_every_entry(tmp_path, _home):
    code = (
        "import sys; from orcha_cli import cli_stacks_registry as r\n"
        "for i in range(10):\n"
        "    r.register(f'{sys.argv[1]}-{i}', path='.', api_port=1, bridge_port=2, cli_version='t')\n"
    )
    pkg_parent = str(pathlib.Path(reg.__file__).resolve().parent.parent)
    env = dict(os.environ, HOME=str(_home),
               PYTHONPATH=os.pathsep.join(filter(None, [pkg_parent, os.environ.get("PYTHONPATH")])))
    procs = [subprocess.Popen([sys.executable, "-c", code, f"p{n}"], env=env) for n in range(6)]
    assert [p.wait(timeout=60) for p in procs] == [0] * 6
    assert len(reg.read_registry()) == 60


def test_live_native_stacks_prunes_stale_and_unreachable(tmp_path):
    _register("live", _project(tmp_path, "live"), 8011)
    _register("stale", _project(tmp_path, "stale", state_age=200), 8012)
    _register("down", _project(tmp_path, "down"), 8013)
    _register("gone", tmp_path / "missing", 8014)

    rows = reg.live_native_stacks(get_json=_portal_up(8011, 8012, 8014))

    assert [r["project_short"] for r in rows] == ["live"]
    assert rows[0] == {
        "project": "orcha-live", "project_short": "live", "api_port": 8011, "db_port": None,
        "portal_status": "Up (native)", "runtime": "native",
        "folder": str((tmp_path / "live").resolve()),
    }
    assert set(reg.read_registry()) == {"live"}


def test_discover_all_never_calls_docker_when_absent(tmp_path):
    _register("alpha", _project(tmp_path, "alpha"), 8020)

    def docker_stacks():
        raise AssertionError("docker lister called with no docker binary")

    rows = reg.discover_all(docker_stacks=docker_stacks, get_json=_portal_up(8020),
                            which=lambda _name: None)
    assert [(r["project_short"], r["runtime"]) for r in rows] == [("alpha", "native")]


def test_discover_all_merges_docker_and_survives_docker_failure(tmp_path, capsys):
    _register("alpha", _project(tmp_path, "alpha"), 8030)
    docker = [{"project": "orcha-beta", "project_short": "beta", "api_port": 8031,
               "db_port": 5440, "portal_status": "Up"},
              {"project": "orcha-alpha", "project_short": "alpha", "api_port": 8099,
               "db_port": 5441, "portal_status": "Up"}]
    rows = reg.discover_all(docker_stacks=lambda: docker, get_json=_portal_up(8030),
                            which=lambda _name: "/usr/bin/docker")
    assert [(r["project_short"], r["runtime"], r["api_port"]) for r in rows] == [
        ("alpha", "native", 8030), ("beta", "docker", 8031)]

    def broken():
        sys.exit("error running docker ps:\nCannot connect to the Docker daemon")

    rows = reg.discover_all(docker_stacks=broken, get_json=_portal_up(8030),
                            which=lambda _name: "/usr/bin/docker")
    assert [r["project_short"] for r in rows] == ["alpha"]
    assert "native stacks only" in capsys.readouterr().err


def test_orcha_ls_without_docker_lists_native_stack(tmp_path, monkeypatch, capsys):
    from orcha_cli import cli_project_facade as facade

    _register("alpha", _project(tmp_path, "alpha"), 8040)
    monkeypatch.setattr(reg.shutil, "which", lambda _name: None)
    monkeypatch.setattr(facade.cli_stacks, "discover_stacks",
                        lambda **_: pytest.fail("docker ps run with no docker binary"))
    get_json = lambda url, **_: ({"containers": [{"name": "Alpha", "status": "active"}]}
                                 if ":8040/" in url else None)
    monkeypatch.setattr(facade, "_get_json", get_json)
    services = types.SimpleNamespace(_discover_stacks=facade._discover_stacks,
                                     _get_json=get_json)

    cli_status.list_command(None, services)

    out = capsys.readouterr().out
    row = next(line for line in out.splitlines() if line.startswith("alpha"))
    assert "http://localhost:8040/" in row and "Alpha" in row and "active" in row
    assert row.split()[2] == "-"  # no database port for a native stack


def test_serve_registers_project_on_start(tmp_path, monkeypatch):
    root = tmp_path / "proj"
    (root / ".claude").mkdir(parents=True)
    (root / ".claude" / "orcha.json").write_text(json.dumps(
        {"project_name": "proj", "runtime": "native", "api_port": 8050, "bridge_port": 8770}))
    monkeypatch.setattr(cli_serve.cli_portal, "_prepare_host_state", lambda _root: None)
    monkeypatch.setattr(cli_serve.cli_portal, "build_portal_env", lambda *_a: {})
    monkeypatch.setattr(cli_serve.Supervisor, "run", lambda self: 0)

    with pytest.raises(SystemExit) as exc:
        cli_serve.cmd_serve(types.SimpleNamespace(project_dir=str(root), no_bridge=False))

    assert exc.value.code == 0
    entry = reg.read_registry()["proj"]
    assert (entry["path"], entry["api_port"], entry["bridge_port"]) == (
        str(root.resolve()), 8050, 8770)
