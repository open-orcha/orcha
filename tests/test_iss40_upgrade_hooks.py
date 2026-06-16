"""ISS-40 / ISS-20 — `orcha upgrade` must re-register notification hooks.

Root cause: `_write_hook_config` is idempotent + additive, but `cmd_upgrade`
never called it (only init/connect/enable-hook did). So when a NEW template hook
ships (e.g. C1's SessionEnd `orcha snapshot`), an EXISTING workspace never got it
on `orcha upgrade` — the hook stayed absent until a manual `orcha enable-hook`.

These tests exercise the CLI path only (no live stack / no docker): `_compose`
and `_copy_tree` are monkeypatched to no-ops so we assert purely that upgrade
lands the missing hooks in `.claude/settings.json` and is idempotent on re-run.
"""
import argparse
import json
import pathlib

from orcha_cli import __main__ as cli  # noqa: E402  (conftest puts orcha-cli on sys.path)


def _make_project(tmp_path: pathlib.Path, *, settings: dict | None = None) -> pathlib.Path:
    """Lay down a minimal EXISTING Orcha project under tmp_path.

    `.orcha/docker-compose.yml` + `.claude/orcha.json` are the two existence
    gates cmd_upgrade checks. If `settings` is given, seed `.claude/settings.json`
    with it (modelling a workspace whose hooks predate the newly-shipped ones).
    """
    orcha = tmp_path / ".orcha"
    orcha.mkdir()
    (orcha / "docker-compose.yml").write_text("services: {}\n")
    claude = tmp_path / ".claude"
    claude.mkdir()
    (claude / "orcha.json").write_text(json.dumps(
        {"project_name": "demo", "db_port": 5432, "api_port": 8000}))
    if settings is not None:
        (claude / "settings.json").write_text(json.dumps(settings, indent=2) + "\n")
    return claude


def _no_op_externals(monkeypatch):
    """Stub the docker/file-tree side effects cmd_upgrade performs."""
    monkeypatch.setattr(cli, "_compose", lambda *a, **k: None)
    monkeypatch.setattr(cli, "_copy_tree", lambda *a, **k: None)
    monkeypatch.setattr(cli, "ensure_daemon", lambda *a, **k: None)


def _sessionend_cmds(claude: pathlib.Path) -> list[str]:
    settings = json.loads((claude / "settings.json").read_text())
    return [h.get("command")
            for entry in settings["hooks"].get("SessionEnd", [])
            for h in entry.get("hooks", [])]


def test_upgrade_adds_missing_hooks_to_existing_workspace(tmp_path, monkeypatch):
    """A workspace whose settings.json lacks the new hooks gets them on upgrade."""
    # Seed a settings.json that has the OLD SessionEnd unwatch hook but is missing
    # the newer `orcha snapshot` (C1) — exactly the ISS-40 deploy gap.
    claude = _make_project(tmp_path, settings={
        "hooks": {"SessionEnd": [
            {"hooks": [{"type": "command", "command": "orcha unwatch"}]}
        ]}
    })
    _no_op_externals(monkeypatch)
    monkeypatch.chdir(tmp_path)

    cli.cmd_upgrade(argparse.Namespace())

    cmds = _sessionend_cmds(claude)
    assert "orcha snapshot" in cmds          # newly-shipped C1 hook now present
    assert "orcha unwatch" in cmds           # pre-existing entry preserved
    assert (tmp_path / ".agents" / "skills" / "orcha-status" / "SKILL.md").exists()


def test_upgrade_is_idempotent_on_second_run(tmp_path, monkeypatch):
    """Re-running upgrade with hooks already wired makes no further change."""
    claude = _make_project(tmp_path, settings={
        "hooks": {"SessionEnd": [
            {"hooks": [{"type": "command", "command": "orcha unwatch"}]}
        ]}
    })
    _no_op_externals(monkeypatch)
    monkeypatch.chdir(tmp_path)

    cli.cmd_upgrade(argparse.Namespace())
    first = (claude / "settings.json").read_text()
    # Second upgrade: hooks already present → settings.json byte-identical.
    cli.cmd_upgrade(argparse.Namespace())
    second = (claude / "settings.json").read_text()
    assert first == second


def test_upgrade_creates_hooks_when_settings_absent(tmp_path, monkeypatch):
    """A workspace with no settings.json at all gets a fresh, fully-wired one."""
    claude = _make_project(tmp_path, settings=None)
    assert not (claude / "settings.json").exists()
    _no_op_externals(monkeypatch)
    monkeypatch.chdir(tmp_path)

    cli.cmd_upgrade(argparse.Namespace())

    assert (claude / "settings.json").exists()
    assert "orcha snapshot" in _sessionend_cmds(claude)
