# tests/test_sandbox_cli.py
"""`orcha sandbox on|off|status|build-image` — the CLI surface for sandbox mode
(spec §3.3a/§3.3b). These are host-CLI unit tests only: on/off/status exercise
real read-modify-write of .claude/orcha.json; build-image fakes the `docker
build` subprocess so no image is ever actually built here (Task 7 covers real
docker).
"""
import argparse
import json
import pathlib

import pytest

from orcha_cli import __main__ as cli  # noqa: E402  (conftest puts orcha-cli on sys.path)
from orcha_cli import sandbox


def _ns(action: str, **over) -> argparse.Namespace:
    base = {"action": action}
    base.update(over)
    return argparse.Namespace(**base)


def _make_project(tmp_path: pathlib.Path, extra: dict | None = None) -> pathlib.Path:
    claude = tmp_path / ".claude"
    claude.mkdir()
    cfg = {"project_name": "demo", "api_base_url": "http://localhost:8003"}
    if extra:
        cfg.update(extra)
    (claude / "orcha.json").write_text(json.dumps(cfg, indent=2) + "\n")
    return claude / "orcha.json"


def _read(cfg_path: pathlib.Path) -> dict:
    return json.loads(cfg_path.read_text())


# --------------------------------------------------------------------------- on/off

def test_sandbox_on_sets_enabled_true_preserving_other_keys(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    cfg_path = _make_project(tmp_path, {"db_port": 5432, "current_container_id": "abc"})

    cli.cmd_sandbox(_ns("on"))

    cfg = _read(cfg_path)
    assert cfg["sandbox"] == {"enabled": True}
    assert cfg["db_port"] == 5432
    assert cfg["current_container_id"] == "abc"
    assert cfg["project_name"] == "demo"


def test_sandbox_off_sets_enabled_false_preserving_other_keys(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    cfg_path = _make_project(tmp_path, {"db_port": 5432, "sandbox": {"enabled": True}})

    cli.cmd_sandbox(_ns("off"))

    cfg = _read(cfg_path)
    assert cfg["sandbox"]["enabled"] is False
    assert cfg["db_port"] == 5432


def test_sandbox_on_off_on_preserves_custom_sandbox_subkeys(tmp_path, monkeypatch):
    """A custom image (or other sandbox sub-key) must survive an on -> off -> on
    round trip — only `enabled` is touched."""
    monkeypatch.chdir(tmp_path)
    cfg_path = _make_project(tmp_path, {"sandbox": {"image": "custom/runner:9"}})

    cli.cmd_sandbox(_ns("on"))
    assert _read(cfg_path)["sandbox"] == {"image": "custom/runner:9", "enabled": True}

    cli.cmd_sandbox(_ns("off"))
    assert _read(cfg_path)["sandbox"] == {"image": "custom/runner:9", "enabled": False}

    cli.cmd_sandbox(_ns("on"))
    assert _read(cfg_path)["sandbox"] == {"image": "custom/runner:9", "enabled": True}


# --------------------------------------------------------------------------- status

def test_sandbox_status_prints_effective_config(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    _make_project(tmp_path, {"sandbox": {"enabled": True, "memory": "8g", "cpus": "4"}})

    cli.cmd_sandbox(_ns("status"))

    out = capsys.readouterr().out
    assert "enabled" in out and "True" in out
    assert sandbox.DEFAULT_IMAGE in out
    assert "8g" in out
    assert "4" in out
    assert str(sandbox.DEFAULT_PIDS) in out
    assert str(sandbox.DEFAULT_MAX_RUNTIME_SECS) in out


_KEY_VARS = ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ORCHA_LLM_API_KEY",
             "CLAUDE_CODE_OAUTH_TOKEN")


def _clear_key_env(monkeypatch):
    for k in _KEY_VARS:
        monkeypatch.delenv(k, raising=False)


def test_sandbox_status_warns_when_no_provider_key_in_env(tmp_path, monkeypatch, capsys):
    """Pre-dogfood fix 3: the container gets provider keys ONLY via the daemon-env
    `-e` passthrough — host OAuth logins don't reach it. With sandbox enabled and
    none of the three key vars set, status must warn (soft: preflight unchanged)."""
    monkeypatch.chdir(tmp_path)
    _make_project(tmp_path, {"sandbox": {"enabled": True}})
    _clear_key_env(monkeypatch)

    cli.cmd_sandbox(_ns("status"))

    out = capsys.readouterr().out
    assert "no provider API key in the daemon environment" in out
    assert "sandbox wakes will fail auth" in out


def test_sandbox_status_no_warning_when_any_provider_key_set(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    _make_project(tmp_path, {"sandbox": {"enabled": True}})
    _clear_key_env(monkeypatch)
    monkeypatch.setenv("ORCHA_LLM_API_KEY", "sk-test")

    cli.cmd_sandbox(_ns("status"))

    assert "no provider API key" not in capsys.readouterr().out


def test_sandbox_status_no_warning_when_subscription_token_set(tmp_path, monkeypatch, capsys):
    """Subscription (BYOC) auth: a `claude setup-token` CLAUDE_CODE_OAUTH_TOKEN in
    the daemon env reaches the container via the same `-e` passthrough as an API
    key — it must silence the creds warning just like one."""
    monkeypatch.chdir(tmp_path)
    _make_project(tmp_path, {"sandbox": {"enabled": True}})
    _clear_key_env(monkeypatch)
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-test")

    cli.cmd_sandbox(_ns("status"))

    assert "no provider API key" not in capsys.readouterr().out


def test_sandbox_status_no_key_warning_when_disabled(tmp_path, monkeypatch, capsys):
    """Disabled sandbox → nothing will spawn a container, so no auth warning noise."""
    monkeypatch.chdir(tmp_path)
    _make_project(tmp_path)                      # sandbox absent → disabled
    _clear_key_env(monkeypatch)

    cli.cmd_sandbox(_ns("status"))

    assert "no provider API key" not in capsys.readouterr().out


def test_sandbox_status_exit_code_zero(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    _make_project(tmp_path)
    # Must not raise SystemExit with a nonzero code (or at all) on the happy path.
    cli.cmd_sandbox(_ns("status"))


# --------------------------------------------------------------------------- guard: outside a project

def test_sandbox_on_outside_project_exits_nonzero_mentioning_file(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)  # no .claude/orcha.json laid down
    with pytest.raises(SystemExit) as exc:
        cli.cmd_sandbox(_ns("on"))
    assert exc.value.code != 0
    assert ".claude/orcha.json" in str(exc.value)


def test_sandbox_off_outside_project_exits_nonzero_mentioning_file(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    with pytest.raises(SystemExit) as exc:
        cli.cmd_sandbox(_ns("off"))
    assert exc.value.code != 0
    assert ".claude/orcha.json" in str(exc.value)


def test_sandbox_status_outside_project_exits_nonzero_mentioning_file(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    with pytest.raises(SystemExit) as exc:
        cli.cmd_sandbox(_ns("status"))
    assert exc.value.code != 0
    assert ".claude/orcha.json" in str(exc.value)


# --------------------------------------------------------------------------- guard: corrupt orcha.json

def _corrupt_project(tmp_path: pathlib.Path) -> pathlib.Path:
    claude = tmp_path / ".claude"
    claude.mkdir()
    cfg_path = claude / "orcha.json"
    cfg_path.write_text("{not valid json")
    return cfg_path


def test_sandbox_on_corrupt_config_exits_nonzero_mentioning_valid_json(tmp_path, monkeypatch):
    """A garbled orcha.json must NOT surface a raw JSONDecodeError traceback — it
    exits with a clean, actionable message (SystemExit carries a str, not an exc)."""
    monkeypatch.chdir(tmp_path)
    _corrupt_project(tmp_path)
    with pytest.raises(SystemExit) as exc:
        cli.cmd_sandbox(_ns("on"))
    assert exc.value.code != 0
    assert isinstance(exc.value.code, str) and "valid JSON" in exc.value.code


def test_sandbox_off_corrupt_config_exits_nonzero_mentioning_valid_json(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    _corrupt_project(tmp_path)
    with pytest.raises(SystemExit) as exc:
        cli.cmd_sandbox(_ns("off"))
    assert exc.value.code != 0
    assert isinstance(exc.value.code, str) and "valid JSON" in exc.value.code


def test_sandbox_status_corrupt_config_exits_instead_of_lying(tmp_path, monkeypatch):
    """The diagnostic command must NOT silently print `enabled: False` defaults on a
    garbled file (that would confirm a lie) — it exits with the same style of error
    BEFORE ever reaching SandboxConfig.load."""
    monkeypatch.chdir(tmp_path)
    _corrupt_project(tmp_path)
    with pytest.raises(SystemExit) as exc:
        cli.cmd_sandbox(_ns("status"))
    assert exc.value.code != 0
    assert isinstance(exc.value.code, str) and "valid JSON" in exc.value.code


# --------------------------------------------------------------------------- atomic write

def test_sandbox_on_write_is_atomic_via_os_replace(tmp_path, monkeypatch):
    """The config write goes through os.replace (crash-safe rename) — never an
    in-place truncate-then-write that could leave a half-written file on a crash."""
    monkeypatch.chdir(tmp_path)
    cfg_path = _make_project(tmp_path, {"db_port": 5432})

    replaced = {}
    real_replace = cli.os.replace

    def _spy_replace(src, dst, *a, **k):
        replaced["src"], replaced["dst"] = str(src), str(dst)
        return real_replace(src, dst, *a, **k)

    monkeypatch.setattr(cli.os, "replace", _spy_replace)

    cli.cmd_sandbox(_ns("on"))

    assert replaced["dst"] == str(cfg_path)       # final target is the real config path
    assert replaced["src"] != str(cfg_path)       # written to a temp, then renamed over
    cfg = _read(cfg_path)
    assert cfg["sandbox"] == {"enabled": True} and cfg["db_port"] == 5432


# --------------------------------------------------------------------------- parser wiring

def test_parser_wires_sandbox_subcommand_to_cmd_sandbox():
    """Task-6 review minor: prove the `sandbox` subparser is actually WIRED —
    `orcha sandbox on` must resolve func to cmd_sandbox with the action parsed
    (mirrors test_cli_version.py's build_parser().parse_args approach)."""
    args = cli.build_parser().parse_args(["sandbox", "on"])
    assert args.func is cli.cmd_sandbox
    assert args.action == "on"


# --------------------------------------------------------------------------- build-image

def test_sandbox_build_image_invokes_docker_build_with_installed_template_dir(monkeypatch, tmp_path):
    """build-image needs no .claude/orcha.json (it only needs the installed
    templates/runner dir) — run it from an empty cwd to prove that."""
    monkeypatch.chdir(tmp_path)

    captured = {}

    class _Ret:
        returncode = 0

    def _fake_run(cmd, *a, **k):
        captured["cmd"] = cmd
        return _Ret()

    monkeypatch.setattr(cli.subprocess, "run", _fake_run)

    with pytest.raises(SystemExit) as exc:
        cli.cmd_sandbox(_ns("build-image"))
    assert exc.value.code == 0

    cmd = captured["cmd"]
    assert cmd[:2] == ["docker", "build"]
    assert "-t" in cmd
    tag_idx = cmd.index("-t")
    assert cmd[tag_idx + 1] == sandbox.DEFAULT_IMAGE
    context_dir = pathlib.Path(cmd[-1])
    assert context_dir.name == "runner"
    assert (context_dir / "Dockerfile").exists()


def test_sandbox_build_image_exits_with_build_returncode(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)

    class _Ret:
        returncode = 7

    monkeypatch.setattr(cli.subprocess, "run", lambda cmd, *a, **k: _Ret())

    with pytest.raises(SystemExit) as exc:
        cli.cmd_sandbox(_ns("build-image"))
    assert exc.value.code == 7
