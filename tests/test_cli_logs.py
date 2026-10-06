"""GH #258 PR 6 (plan R2): `orcha logs` reads the rotating files `orcha serve` writes,
and both new verbs are on the public parser."""
import json
import os
import types

import pytest

from orcha_cli import __main__ as cli
from orcha_cli import cli_logs


def _native(tmp_path, logs=None):
    (tmp_path / ".claude").mkdir(parents=True)
    (tmp_path / ".claude" / "orcha.json").write_text(json.dumps({"runtime": "native"}))
    (tmp_path / ".orcha" / "logs").mkdir(parents=True)
    for name, text in (logs or {}).items():
        (tmp_path / ".orcha" / "logs" / f"{name}.log").write_text(text)
    return tmp_path


def _args(root, child=None, lines=50, follow=False):
    return types.SimpleNamespace(project_dir=str(root), child=child, lines=lines, follow=follow)


def test_one_child_prints_the_last_n_lines(tmp_path, capsys):
    root = _native(tmp_path, {"portal": "".join(f"line {i}\n" for i in range(100))})
    cli_logs.cmd_logs(_args(root, "portal", lines=3))
    assert capsys.readouterr().out == "line 97\nline 98\nline 99\n"


def test_all_existing_logs_are_prefixed_with_their_child(tmp_path, capsys):
    root = _native(tmp_path, {"serve": "s1\n", "notifier": "n1\n"})
    cli_logs.cmd_logs(_args(root))
    assert capsys.readouterr().out == "serve   | s1\nnotifier| n1\n"


def test_no_logs_yet_and_docker_projects_get_a_hint(tmp_path):
    with pytest.raises(SystemExit, match="no logs yet"):
        cli_logs.cmd_logs(_args(_native(tmp_path / "n")))
    (tmp_path / "d" / ".orcha").mkdir(parents=True)
    (tmp_path / "d" / ".orcha" / "docker-compose.yml").write_text("name: x\n")
    with pytest.raises(SystemExit, match="docker compose -f .* logs -f"):
        cli_logs.cmd_logs(_args(tmp_path / "d"))


def test_follow_prints_appends_and_survives_rotation(tmp_path, capsys):
    root = _native(tmp_path, {"bridge": "old\n"})
    path = root / ".orcha" / "logs" / "bridge.log"
    steps = iter([
        lambda: path.write_text("old\nnew 1\n"),
        lambda: (os.replace(path, path.with_suffix(".log.1")), path.write_text("after rotate\n")),
        lambda: None,
    ])
    done = {"n": 0}

    def sleep(_s):
        step = next(steps, None)
        if step is None:
            done["n"] = 1
        else:
            step()

    cli_logs.follow({"bridge": path}, sleep=sleep, stop=lambda: done["n"])
    assert capsys.readouterr().out == "new 1\nafter rotate\n"


def test_serve_and_logs_are_registered():
    parser = cli.build_parser()
    args = parser.parse_args(["serve", "--project-dir", "/p", "--no-bridge"])
    assert (args.func, args.project_dir, args.no_bridge) == (cli.cmd_serve, "/p", True)
    args = parser.parse_args(["logs", "-f", "-n", "5", "notifier"])
    assert (args.func, args.follow, args.lines, args.child) == (cli.cmd_logs, True, 5, "notifier")
    with pytest.raises(SystemExit):
        parser.parse_args(["logs", "db"])
