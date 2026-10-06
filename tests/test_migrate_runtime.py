"""GH #258 plan Part 6 M2 (PR 8) — `orcha migrate-runtime` (orcha_cli.cli_migrate_runtime).

Docker, the notifier, the bridge, the converter and the native `up`/`down` are all fakes that
append to one call log, so these tests pin the exact order of the forward path, that nothing
on it ever passes `-v` or `down`, that a failed copy leaves the project exactly as it was,
that --rollback restores orcha.json byte for byte, and that --purge-docker refuses while the
native portal is not answering.
"""
import argparse
import io
import json
import pathlib
import subprocess

import pytest

from orcha_cli import cli_migrate_runtime as mr
from orcha_cli import db_convert

CID = "6f1c1a52-0c1b-4c4e-9d1e-2b1f0f7e3a11"
ORIGINAL_CFG = {
    "api_base_url": "http://localhost:8123", "project_name": "demo", "api_port": 8123,
    "db_port": 5499, "bridge_port": 8899, "current_container_id": CID,
}


@pytest.fixture
def project(tmp_path):
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".orcha").mkdir()
    (tmp_path / ".orcha" / "docker-compose.yml").write_text("services: {}\n")
    (tmp_path / ".orcha" / "portal").mkdir()
    (tmp_path / ".orcha" / "migrations").mkdir()
    # deliberately not the CLI's own formatting, so "byte for byte" is a real check
    (tmp_path / ".claude" / "orcha.json").write_text(json.dumps(ORIGINAL_CFG, indent=4))
    return tmp_path


class Fake:
    def __init__(self, *, db_running=True, convert_fails=False, portal_up=True,
                 containers=(CID,), confirm=True):
        self.calls = []
        self.db_running = db_running
        self.convert_fails = convert_fails
        self.portal_up = portal_up
        self.containers = containers
        self.answer = confirm

    def deps(self):
        return mr.Deps(
            compose=self.compose, stop_daemon=self._rec("stop_daemon"),
            stop_bridge=self._rec("stop_bridge"), ensure_daemon=self._rec("ensure_daemon"),
            ensure_bridge=self._rec("ensure_bridge"), convert=self.convert,
            native_up=self._rec("native_up"), native_down=self._rec("native_down"),
            write_hooks=self._rec("write_hooks"), http_ok=self.http_ok,
            get_json=self.get_json, confirm=self.confirm,
        )

    def _rec(self, name):
        def f(*args, **kwargs):
            self.calls.append((name,))
        return f

    def compose(self, orcha_dir, *args, check=True, capture=False):
        self.calls.append(("compose",) + args)
        if args[:1] == ("ps",):
            out = "db\nportal\n" if self.db_running else ""
            return subprocess.CompletedProcess(args, 0, stdout=out, stderr="")
        return subprocess.CompletedProcess(args, 0, stdout="", stderr="")

    def convert(self, url, out, progress=None, **kwargs):
        self.calls.append(("convert", url, pathlib.Path(out).name))
        if self.convert_fails:
            pathlib.Path(out).write_bytes(b"half")  # the real converter cleans up; be harsh
            raise db_convert.ConvertError("tasks: Postgres has 3 rows, SQLite 2")
        pathlib.Path(out).write_bytes(b"SQLite format 3\x00")
        progress({"stage": "done"})
        rep = db_convert.Report(out=str(out))
        rep.tables = [db_convert.TableReport("containers", 1, 0.0),
                      db_convert.TableReport("tasks", 3, 0.0)]
        return rep

    def http_ok(self, url):
        self.calls.append(("http_ok", url))
        return self.portal_up

    def get_json(self, url, timeout=None):
        self.calls.append(("get_json", url))
        return {"containers": [{"id": c} for c in self.containers]}

    def confirm(self, question):
        self.calls.append(("confirm",))
        return self.answer


def _args(project, **kw):
    base = dict(project_dir=str(project), rollback=False, purge_docker=False, yes=False,
                pg_url=None, no_service=False, keep_docker_running=False, json=False)
    base.update(kw)
    return argparse.Namespace(**base)


def _run(project, fake, **kw):
    buf = io.StringIO()
    out = mr.Output(kw.get("json", False), stream=buf)
    code = mr.run(_args(project, **kw), fake.deps(), out)
    return code, buf.getvalue()


def _cfg_bytes(project):
    return (project / ".claude" / "orcha.json").read_bytes()


# ---------------------------------------------------------------- forward

def test_forward_call_order_and_never_down_or_volumes(project):
    before = _cfg_bytes(project)
    fake = Fake()
    code, _ = _run(project, fake)
    assert code == 0
    names = [c[0] if c[0] != "compose" else " ".join(c) for c in fake.calls]
    assert names == [
        "compose ps --status running --services",
        "stop_daemon", "stop_bridge", "compose stop portal",
        "convert",
        "compose stop",
        "write_hooks", "native_up", "get_json",
    ]
    assert ("convert", "postgresql://orcha:orcha@localhost:5499/orcha", "orcha.db.partial") in fake.calls
    for call in fake.calls:
        if call[0] == "compose":
            assert "down" not in call and "-v" not in call, call
    db = project / ".orcha" / "orcha.db"
    assert db.exists() and not (project / ".orcha" / "orcha.db.partial").exists()
    cfg = json.loads(_cfg_bytes(project))
    assert cfg["runtime"] == "native" and cfg["db_path"] == ".orcha/orcha.db"
    assert cfg["bind"] == "loopback" and cfg["legacy_db_port"] == 5499 and "db_port" not in cfg
    assert {k: v for k, v in cfg.items() if k not in ("runtime", "db_path", "bind", "legacy_db_port")} \
        == {k: v for k, v in ORIGINAL_CFG.items() if k != "db_port"}
    assert (project / ".orcha" / "orcha.json.docker").read_bytes() == before


def test_keep_docker_running_skips_the_compose_stop(project):
    fake = Fake()
    assert _run(project, fake, keep_docker_running=True)[0] == 0
    assert ("compose", "stop") not in fake.calls
    assert ("compose", "stop", "portal") in fake.calls  # writers are still quiesced


def test_explicit_pg_url_wins(project):
    fake = Fake()
    assert _run(project, fake, pg_url="postgresql://u:p@box:6000/orcha")[0] == 0
    assert ("convert", "postgresql://u:p@box:6000/orcha", "orcha.db.partial") in fake.calls


def test_failed_copy_leaves_nothing_behind_and_restarts_docker(project):
    before = _cfg_bytes(project)
    fake = Fake(convert_fails=True)
    code, text = _run(project, fake, json=True)
    assert code == 1
    assert _cfg_bytes(project) == before
    assert not list((project / ".orcha").glob("orcha.db*"))
    assert not (project / ".orcha" / "orcha.json.docker").exists()
    after_convert = fake.calls[[c[0] for c in fake.calls].index("convert") + 1:]
    assert after_convert[0] == ("compose", "start", "portal")
    assert ("ensure_daemon",) in after_convert and ("ensure_bridge",) in after_convert
    assert ("native_up",) not in fake.calls and ("compose", "stop") not in fake.calls
    err = json.loads(text.strip().splitlines()[-1])
    assert err["event"] == "error" and "nothing was changed" in err["error"]


def test_docker_not_running_prints_the_start_docker_once_message(project):
    fake = Fake(db_running=False)
    buf = io.StringIO()
    code = mr.run(_args(project), fake.deps(), mr.Output(True, stream=buf))
    assert code == 1
    assert json.loads(buf.getvalue())["error"] == (
        "Your project's data is still inside Docker. Start Docker once, run `orcha up`, "
        "then run this command again.")
    assert [c for c in fake.calls if c[0] != "compose"] == []


def test_refuses_when_an_orcha_db_already_exists(project):
    (project / ".orcha" / "orcha.db").write_bytes(b"keep")
    before = _cfg_bytes(project)
    fake = Fake()
    code, _ = _run(project, fake)
    assert code == 1 and fake.calls == []
    assert (project / ".orcha" / "orcha.db").read_bytes() == b"keep" and _cfg_bytes(project) == before


def test_refuses_an_already_native_project(project):
    cfg = dict(ORIGINAL_CFG, runtime="native")
    (project / ".claude" / "orcha.json").write_text(json.dumps(cfg))
    fake = Fake()
    assert _run(project, fake)[0] == 1 and fake.calls == []


def test_container_missing_after_start_is_an_error_with_the_rollback_hint(project):
    fake = Fake(containers=("someone-else",))
    code, text = _run(project, fake, json=True)
    assert code == 1
    assert "--rollback" in json.loads(text.strip().splitlines()[-1])["error"]


def test_json_mode_is_one_object_per_line_ending_in_a_result(project):
    code, text = _run(project, Fake(), json=True)
    assert code == 0
    lines = [json.loads(line) for line in text.strip().splitlines()]
    assert all(line["event"] == "progress" for line in lines[:-1])
    assert lines[-1]["event"] == "result" and lines[-1]["counts"] == {"containers": 1, "tasks": 3}
    assert lines[-1]["rows"] == 4


def test_service_is_installed_unless_no_service(project):
    fake = Fake()
    installed = []
    deps = fake.deps()
    deps.service_install = installed.append
    assert mr.run(_args(project), deps, mr.Output(False, stream=io.StringIO())) == 0
    assert installed == [project.resolve()]


def test_no_service_skips_the_install(project):
    installed = []
    deps = Fake().deps()
    deps.service_install = installed.append
    assert mr.run(_args(project, no_service=True), deps,
                  mr.Output(False, stream=io.StringIO())) == 0
    assert installed == []


def test_service_install_failure_still_migrates_and_clears_the_unit(project):
    fake = Fake()
    removed = []
    deps = fake.deps()

    def broken(root):
        raise RuntimeError("Bootstrap failed: 5")

    deps.service_install, deps.service_uninstall = broken, removed.append
    buf = io.StringIO()
    assert mr.run(_args(project, json=True), deps, mr.Output(True, stream=buf)) == 0
    assert removed == [project.resolve()] and ("native_up",) in fake.calls
    assert any("Bootstrap failed" in line for line in buf.getvalue().splitlines())


def test_rollback_removes_the_background_service(project):
    assert _run(project, Fake())[0] == 0
    fake = Fake()
    removed = []
    deps = fake.deps()
    deps.service_uninstall = lambda root: (removed.append(root), fake.calls.append(("uninstall",)))
    assert mr.run(_args(project, rollback=True), deps,
                  mr.Output(False, stream=io.StringIO())) == 0
    assert removed == [project.resolve()]
    assert fake.calls[:2] == [("native_down",), ("uninstall",)]  # before Docker comes back


# ---------------------------------------------------------------- rollback

def test_rollback_restores_config_byte_for_byte_and_keeps_the_sqlite_file(project):
    before = _cfg_bytes(project)
    assert _run(project, Fake())[0] == 0
    (project / ".orcha" / "orcha.db-wal").write_bytes(b"wal")
    fake = Fake()
    code, _ = _run(project, fake, rollback=True)
    assert code == 0
    assert _cfg_bytes(project) == before
    assert not (project / ".orcha" / "orcha.json.docker").exists()
    assert not (project / ".orcha" / "orcha.db").exists()
    kept = sorted(p.name for p in (project / ".orcha").glob("orcha.db.rolled-back-*"))
    assert len(kept) == 2 and kept[1] == kept[0] + "-wal"
    assert fake.calls[0] == ("native_down",)
    assert ("compose", "up", "-d") in fake.calls and ("ensure_daemon",) in fake.calls


def test_rollback_without_a_migration_refuses(project):
    fake = Fake()
    assert _run(project, fake, rollback=True)[0] == 1 and fake.calls == []


# ---------------------------------------------------------------- purge

def test_purge_refuses_while_the_native_portal_is_down(project):
    assert _run(project, Fake())[0] == 0
    fake = Fake(portal_up=False)
    code, _ = _run(project, fake, purge_docker=True, yes=True)
    assert code == 1
    assert [c[0] for c in fake.calls] == ["http_ok"]
    assert (project / ".orcha" / "docker-compose.yml").exists()


def test_purge_needs_a_yes(project):
    assert _run(project, Fake())[0] == 0
    fake = Fake(confirm=False)
    assert _run(project, fake, purge_docker=True)[0] == 1
    assert not any(c[0] == "compose" for c in fake.calls)
    assert (project / ".orcha" / "docker-compose.yml").exists()


def test_purge_removes_docker_and_the_legacy_port(project):
    assert _run(project, Fake())[0] == 0
    fake = Fake()
    assert _run(project, fake, purge_docker=True, yes=True)[0] == 0
    assert ("compose", "down", "-v", "--rmi", "local") in fake.calls
    assert ("confirm",) not in fake.calls
    for name in ("docker-compose.yml", "portal", "migrations", "orcha.json.docker"):
        assert not (project / ".orcha" / name).exists(), name
    cfg = json.loads(_cfg_bytes(project))
    assert "legacy_db_port" not in cfg and cfg["runtime"] == "native"
    assert (project / ".orcha" / "orcha.db").exists()
    # and rollback is now refused, with the reason
    assert _run(project, Fake(), rollback=True)[0] == 1


def test_purge_refuses_a_docker_project(project):
    fake = Fake()
    assert _run(project, fake, purge_docker=True, yes=True)[0] == 1 and fake.calls == []


# ---------------------------------------------------------------- the nudge

def test_up_on_a_docker_project_prints_the_nudge(project, monkeypatch, capsys):
    from orcha_cli import cli_project_commands

    class Services:
        def _compose(self, *a, **k):
            pass

        def _install_project_preferences(self, root):
            return None

        def ensure_daemon(self, root):
            pass

    monkeypatch.chdir(project)
    monkeypatch.setattr("orcha_cli.terminal_bridge.ensure_bridge", lambda root: None)
    cli_project_commands.cmd_up(argparse.Namespace(project=None), Services())
    assert "orcha migrate-runtime" in capsys.readouterr().out


def test_parser_wires_the_command():
    from orcha_cli.__main__ import build_parser

    a = build_parser().parse_args(["migrate-runtime", "--purge-docker", "--yes", "--json"])
    assert a.func.__name__ == "cmd_migrate_runtime" and a.purge_docker and a.yes and a.json
