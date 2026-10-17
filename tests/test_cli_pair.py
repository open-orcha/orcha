"""`orcha pair --lan | --local` (plan R-D3): flip orcha.json's bind, restart only the portal."""

import json
import signal

from orcha_cli import __main__ as cli  # noqa: E402 (conftest puts orcha-cli on sys.path)
from orcha_cli import cli_pair


def _project(tmp_path, **cfg):
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "orcha.json").write_text(json.dumps({"runtime": "native", "api_port": 8000, **cfg}))
    return tmp_path


def _run(*argv):
    args = cli.build_parser().parse_args(["pair", *argv])
    args.func(args)


def _cfg(root):
    return json.loads((root / ".claude" / "orcha.json").read_text())


def test_lan_writes_bind_and_restarts_the_running_portal(tmp_path, monkeypatch, capsys):
    root = _project(tmp_path)
    killed = []
    monkeypatch.setattr(cli_pair, "serve_running", lambda r: 4242)
    monkeypatch.setattr(cli_pair, "read_state", lambda r: {"children": {"portal": {"pid": 777}}})
    monkeypatch.setattr(cli_pair.os, "kill", lambda pid, sig: killed.append((pid, sig)))

    _run("--lan", "--project-dir", str(root))

    assert _cfg(root) == {"runtime": "native", "api_port": 8000, "bind": "lan"}
    assert killed == [(777, signal.SIGTERM)]
    assert "portal is restarting" in capsys.readouterr().out


def test_local_turns_it_back_off_without_serve(tmp_path, monkeypatch, capsys):
    root = _project(tmp_path, bind="lan")
    monkeypatch.setattr(cli_pair, "serve_running", lambda r: None)

    _run("--local", "--project-dir", str(root))

    assert _cfg(root)["bind"] == "loopback"
    assert "orcha up" in capsys.readouterr().out


def test_no_flag_prints_the_setting_and_writes_nothing(tmp_path, capsys):
    root = _project(tmp_path)

    _run("--project-dir", str(root))

    assert "off (this computer only)" in capsys.readouterr().out
    assert "bind" not in _cfg(root)


def test_docker_project_is_left_alone(tmp_path, capsys):
    root = _project(tmp_path, runtime="docker")

    _run("--lan", "--project-dir", str(root))

    assert "bind" not in _cfg(root)
    assert "Docker" in capsys.readouterr().out
