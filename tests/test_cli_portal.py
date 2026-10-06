"""GH #258 PR R1: `orcha portal` runs the packaged portal as a host process.

The environment it builds must mirror templates/docker-compose.yml.j2 with host
paths in place of container mounts, with compose's precedence (shell > .orcha/.env
> derived). uvicorn itself is never started here: `uvicorn.run` is monkeypatched.
"""
import json
import pathlib
import sys
import types

import pytest

from orcha_cli import __main__ as cli  # noqa: E402 (conftest puts orcha-cli on sys.path)
from orcha_cli import cli_portal

CFG = {"project_name": "demo", "api_port": 8123, "db_port": 5499, "bridge_port": 8799}

# Every variable compose hands the portal that must also exist natively. Secrets and
# pass-throughs (LLM key, pairing host, PAT, plan) are only set when the user has them.
NATIVE_KEYS = {
    "DATABASE_URL",
    "MIGRATIONS_DIR",
    "ORCHA_ATTACHMENTS_DIR",
    "ORCHA_TERMINAL_WS_URL",
    "ORCHA_GITHUB_TOKEN_FILE",
    "ORCHA_GITHUB_TOKENS_FILE",
    "ORCHA_LOCAL_REPO_DIR",
    "ORCHA_LOCAL_REPO_NAME",
}


def _project(tmp_path: pathlib.Path, cfg=None, env_lines=()) -> pathlib.Path:
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "orcha.json").write_text(json.dumps(cfg or CFG))
    (tmp_path / ".orcha").mkdir()
    if env_lines:
        (tmp_path / ".orcha" / ".env").write_text("\n".join(env_lines) + "\n")
    return tmp_path


def test_env_has_every_native_key_with_host_paths(tmp_path):
    root = _project(tmp_path)
    env = cli_portal.build_portal_env(root, CFG, base_env={})
    assert NATIVE_KEYS <= set(env)
    assert env["DATABASE_URL"] == "postgresql://orcha:orcha@localhost:5499/orcha"
    assert env["ORCHA_TERMINAL_WS_URL"] == "ws://127.0.0.1:8799"
    assert env["ORCHA_ATTACHMENTS_DIR"] == str(root / ".claude" / ".orcha-attachments")
    assert env["ORCHA_GITHUB_TOKEN_FILE"] == str(root / ".orcha" / "github-token")
    assert env["ORCHA_GITHUB_TOKENS_FILE"] == str(root / ".orcha" / "github-tokens.json")
    assert env["ORCHA_LOCAL_REPO_DIR"] == str(root)
    assert env["ORCHA_LOCAL_REPO_NAME"] == "demo"
    migrations = pathlib.Path(env["MIGRATIONS_DIR"])
    assert (migrations / "001_init.sql").is_file()
    assert "ORCHA_WAKES_DIR" not in env   # set by compose, read by nobody


def test_native_project_gets_the_sqlite_migrations(tmp_path):
    """A native portal runs on SQLite, so it must apply migrations/sqlite (the baseline),
    never the Postgres files (001_init.sql halts SQLite on CREATE EXTENSION)."""
    cfg = {"project_name": "demo", "api_port": 8123, "bridge_port": 8799, "runtime": "native",
           "db_path": ".orcha/orcha.db"}
    root = _project(tmp_path, cfg)
    env = cli_portal.build_portal_env(root, cfg, base_env={})
    migrations = pathlib.Path(env["MIGRATIONS_DIR"])
    assert (migrations / "001_baseline.sql").is_file()
    assert not (migrations / "001_init.sql").exists()
    assert env["ORCHA_DB_PATH"] == str(root / ".orcha" / "orcha.db")
    assert "DATABASE_URL" not in env


def test_precedence_shell_over_env_file_over_derived(tmp_path):
    root = _project(
        tmp_path,
        env_lines=(
            "# comment",
            "ORCHA_SECRET_KEY=from-file",
            "ORCHA_PLAN=file-plan",
            "DATABASE_URL=postgresql://file/db",
        ),
    )
    env = cli_portal.build_portal_env(
        root, CFG, base_env={"ORCHA_PLAN": "shell-plan"}
    )
    assert env["ORCHA_PLAN"] == "shell-plan"             # shell beats .env
    assert env["ORCHA_SECRET_KEY"] == "from-file"        # .env beats nothing
    assert env["DATABASE_URL"] == "postgresql://file/db"  # .env beats the derived default


def test_mount_paths_are_not_overridable_from_env_file(tmp_path):
    root = _project(tmp_path, env_lines=("ORCHA_ATTACHMENTS_DIR=/app/orcha-attachments",))
    env = cli_portal.build_portal_env(root, CFG, base_env={})
    assert env["ORCHA_ATTACHMENTS_DIR"] == str(root / ".claude" / ".orcha-attachments")


def test_bind_is_loopback_unless_lan(tmp_path):
    assert cli_portal.bind_host(CFG) == "127.0.0.1"
    assert cli_portal.bind_host({**CFG, "bind": "lan"}) == "0.0.0.0"


def test_portal_dir_is_the_packaged_portal():
    portal = cli_portal.portal_dir()
    assert (portal / "main.py").is_file()
    assert (portal / "portal_backend" / "database.py").is_file()
    assert (portal / "static" / "dist" / "index.html").is_file()


def test_downgrade_guard(tmp_path):
    root = _project(tmp_path)
    migrations = root / ".orcha" / "migrations"
    migrations.mkdir()
    (migrations / "999_future.sql").write_text("-- newer than this CLI\n")
    with pytest.raises(SystemExit, match="migration 999"):
        cli_portal.check_migration_tip(root, allow_downgrade=False)
    cli_portal.check_migration_tip(root, allow_downgrade=True)


def test_missing_orcha_json_exits_with_hint(tmp_path):
    with pytest.raises(SystemExit, match="orcha.json"):
        cli_portal.load_project_config(tmp_path)


def test_cmd_portal_runs_uvicorn_with_project_settings(tmp_path, monkeypatch):
    root = _project(tmp_path, env_lines=("ORCHA_SECRET_KEY=k",))
    calls = []
    fake_uvicorn = types.SimpleNamespace(run=lambda app, **kw: calls.append((app, kw)))
    monkeypatch.setitem(sys.modules, "uvicorn", fake_uvicorn)
    monkeypatch.setattr(cli_portal.cli_project_setup, "export_gh_token", lambda: None)
    monkeypatch.setattr(cli_portal.cli_project_setup, "discover_pairing_host", lambda: None)
    for key in NATIVE_KEYS | {"ORCHA_SECRET_KEY"}:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(sys, "path", list(sys.path))
    monkeypatch.setattr(cli_portal.os, "environ", dict(cli_portal.os.environ))

    args = cli.build_parser().parse_args(["portal", "--project-dir", str(root)])
    args.func(args)

    assert calls == [
        (
            "main:app",
            {
                "host": "127.0.0.1",
                "port": 8123,
                "proxy_headers": True,
                "forwarded_allow_ips": "127.0.0.1",
                "log_level": "info",
            },
        )
    ]
    assert sys.path[0] == str(cli_portal.portal_dir())
    assert cli_portal.os.environ["ORCHA_SECRET_KEY"] == "k"
    assert cli_portal.os.environ["ORCHA_LOCAL_REPO_DIR"] == str(root)
    assert (root / ".claude" / ".orcha-attachments").is_dir()


def test_cli_flags_override_host_and_port(tmp_path, monkeypatch):
    root = _project(tmp_path, cfg={**CFG, "bind": "lan"}, env_lines=("ORCHA_SECRET_KEY=k",))
    calls = []
    monkeypatch.setitem(
        sys.modules, "uvicorn", types.SimpleNamespace(run=lambda app, **kw: calls.append(kw))
    )
    monkeypatch.setattr(cli_portal.cli_project_setup, "export_gh_token", lambda: None)
    monkeypatch.setattr(cli_portal.cli_project_setup, "discover_pairing_host", lambda: None)
    monkeypatch.setattr(sys, "path", list(sys.path))
    monkeypatch.setattr(cli_portal.os, "environ", dict(cli_portal.os.environ))

    args = cli.build_parser().parse_args(
        ["portal", "--project-dir", str(root), "--port", "9001"]
    )
    args.func(args)
    assert calls[0]["host"] == "0.0.0.0"
    assert calls[0]["port"] == 9001

    args = cli.build_parser().parse_args(
        ["portal", "--project-dir", str(root), "--host", "127.0.0.1"]
    )
    args.func(args)
    assert calls[1]["host"] == "127.0.0.1"


def test_portal_help_renders(capsys):
    with pytest.raises(SystemExit) as exc:
        cli.build_parser().parse_args(["portal", "--help"])
    assert exc.value.code == 0
    assert "--project-dir" in capsys.readouterr().out
