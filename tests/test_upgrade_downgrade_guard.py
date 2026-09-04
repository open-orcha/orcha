"""`orcha upgrade` downgrade guard — an outdated CLI must refuse, not silently downgrade.

Incident (2026-08-30): a stale globally-installed orcha ran `upgrade` on a stack that a
newer CLI had provisioned, re-copying pre-React templates over the modern portal — the
stack came back serving the vanilla shell with the feature routes 404ing, and nothing
said why. The guard compares the one monotonic stamp present on BOTH sides — the highest
NNN_*.sql in the CLI's packaged migrations vs the stack's .orcha/migrations copy — and
exits before any writes when the CLI is older. --allow-downgrade is the deliberate
override.
"""
import argparse
import json
import pathlib
import sys
import types

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "orcha-cli"))

from orcha_cli import cli_project_setup  # noqa: E402
from orcha_cli.cli_project_commands import cmd_upgrade  # noqa: E402


# ---- the stamp itself -------------------------------------------------------

def test_migration_tip_reads_highest_number(tmp_path):
    d = tmp_path / "migrations"
    d.mkdir()
    for name in ("001_init.sql", "026_old.sql", "048_wake_backoff.sql", "notes.md"):
        (d / name).write_text("-- x")
    assert cli_project_setup.migration_tip(d) == 48


def test_migration_tip_missing_dir_is_zero(tmp_path):
    assert cli_project_setup.migration_tip(tmp_path / "nope") == 0


def test_packaged_templates_have_a_nonzero_tip():
    from orcha_cli.cli_project_facade import PKG_TEMPLATES
    assert cli_project_setup.migration_tip(PKG_TEMPLATES / "migrations") >= 48


# ---- the upgrade guard ------------------------------------------------------

def _project(tmp_path, stack_tip: int) -> pathlib.Path:
    cwd = tmp_path / "proj"
    (cwd / ".orcha" / "migrations").mkdir(parents=True)
    (cwd / ".orcha" / "docker-compose.yml").write_text("services: {}\n")
    (cwd / ".claude").mkdir()
    (cwd / ".claude" / "orcha.json").write_text(
        json.dumps({"project_name": "proj", "db_port": 5433, "api_port": 8001,
                    "bridge_port": 8765})
    )
    (cwd / ".orcha" / "migrations" / f"{stack_tip:03d}_x.sql").write_text("-- x")
    return cwd


def _services(tmp_path, cli_tip: int):
    """Minimal fake services facade: real tip logic, templates dir with one migration.
    Everything past the guard is unused in the refusal test and stubbed loud in the
    pass-through test."""
    tpl = tmp_path / "templates"
    (tpl / "migrations").mkdir(parents=True)
    (tpl / "migrations" / f"{cli_tip:03d}_x.sql").write_text("-- x")
    svc = types.SimpleNamespace()
    svc.PKG_TEMPLATES = tpl
    svc._migration_tip = cli_project_setup.migration_tip
    svc._sanitize_name = lambda s: s
    svc._find_free_port = lambda start: start
    return svc


def test_older_cli_refuses_before_any_write(tmp_path, monkeypatch):
    cwd = _project(tmp_path, stack_tip=48)
    monkeypatch.chdir(cwd)
    compose_before = (cwd / ".orcha" / "docker-compose.yml").read_text()
    with pytest.raises(SystemExit) as e:
        cmd_upgrade(argparse.Namespace(allow_downgrade=False), _services(tmp_path, cli_tip=26))
    assert "NEWER Orcha than your CLI" in str(e.value)
    assert "048" in str(e.value) and "026" in str(e.value)
    # refused BEFORE re-rendering compose — the stack is untouched.
    assert (cwd / ".orcha" / "docker-compose.yml").read_text() == compose_before


def test_allow_downgrade_overrides_the_guard(tmp_path, monkeypatch):
    cwd = _project(tmp_path, stack_tip=48)
    monkeypatch.chdir(cwd)
    svc = _services(tmp_path, cli_tip=26)
    # The guard passes; the next thing cmd_upgrade does is read the compose template —
    # our fake templates dir lacks it, so THAT failure (not the guard's SystemExit
    # message) proves execution moved past the guard.
    with pytest.raises((FileNotFoundError, SystemExit, AttributeError)) as e:
        cmd_upgrade(argparse.Namespace(allow_downgrade=True), svc)
    assert "NEWER Orcha than your CLI" not in str(e.value)


def test_equal_tip_passes_the_guard(tmp_path, monkeypatch):
    cwd = _project(tmp_path, stack_tip=48)
    monkeypatch.chdir(cwd)
    svc = _services(tmp_path, cli_tip=48)
    with pytest.raises((FileNotFoundError, SystemExit, AttributeError)) as e:
        cmd_upgrade(argparse.Namespace(allow_downgrade=False), svc)
    assert "NEWER Orcha than your CLI" not in str(e.value)


def test_migration_tip_reaches_the_real_services_namespace():
    """Regression: cmd_upgrade receives `orcha_cli.__main__` as its services module
    (star-imported facade). The guard's `_migration_tip` is underscore-prefixed, so
    it only survives the star import via the facade's __all__ — the first deploy
    crashed with AttributeError because it wasn't listed."""
    from orcha_cli import __main__ as services
    assert hasattr(services, "_migration_tip")
    assert services._migration_tip.__module__.endswith("cli_project_facade")


def test_persisted_pairing_host_outranks_discovery(tmp_path, monkeypatch):
    """A hosted box pins ORCHA_PAIRING_HOST in the stack .env; compose-up must use it
    instead of re-discovering the machine's raw IP (which regressed the pairing QR
    from the domain to the bare IP on every relaunch)."""
    monkeypatch.delenv("ORCHA_PAIRING_HOST", raising=False)
    orcha_dir = tmp_path / ".orcha"
    orcha_dir.mkdir()
    (orcha_dir / ".env").write_text("OTHER=1\nORCHA_PAIRING_HOST=orcha.example.com\n")
    assert cli_project_setup.pairing_host_from_env_file(orcha_dir) == "orcha.example.com"
    # operator shell env still wins over the file
    monkeypatch.setenv("ORCHA_PAIRING_HOST", "operator.example.com")
    cli_project_setup.export_pairing_host(lambda: "10.0.0.5", orcha_dir)
    import os
    assert os.environ["ORCHA_PAIRING_HOST"] == "operator.example.com"
