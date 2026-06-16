"""`orcha update` — one idempotent command to apply a code change to a running project.

It folds the multi-step host dance (CLI reinstall + portal upgrade + DB migrate-on-
startup + notifier daemon restart + terminal-bridge restart + hook re-register) into a
single command so operators never hand-kill/respawn host processes.

These tests exercise the CLI orchestration only — every real side effect (docker build,
file-tree copy, CLI reinstall, daemon/bridge spawn) is monkeypatched, so we assert purely
that `cmd_update`:
  * restarts BOTH the daemon and the bridge with restart=True (the kill-and-respawn that
    picks up new host code) — and honours --no-bridge,
  * runs the project upgrade (templates/compose/hooks/portal rebuild),
  * self-reinstalls + re-execs ONLY for an editable/source install, skips for a packaged
    one, and is suppressed by --no-self,
  * refuses to run outside an existing project.
Each assertion is mutation-checked: flip the flag and the recorded call changes.
"""
import argparse
import json
import pathlib

import pytest

from orcha_cli import __main__ as cli  # noqa: E402  (conftest puts orcha-cli on sys.path)


def _make_project(tmp_path: pathlib.Path) -> pathlib.Path:
    """Lay down the two existence gates cmd_update checks: .orcha/docker-compose.yml
    and .claude/orcha.json."""
    orcha = tmp_path / ".orcha"
    orcha.mkdir()
    (orcha / "docker-compose.yml").write_text("services: {}\n")
    claude = tmp_path / ".claude"
    claude.mkdir()
    (claude / "orcha.json").write_text(json.dumps(
        {"project_name": "demo", "db_port": 5432, "api_port": 8000}))
    return claude


def _ns(**over) -> argparse.Namespace:
    base = {"no_self": True, "no_bridge": False}   # default tests skip phase-0 unless asked
    base.update(over)
    return argparse.Namespace(**base)


@pytest.fixture
def restarts(monkeypatch):
    """Capture daemon/bridge restart calls; stub the project upgrade to a no-op."""
    calls = {"daemon": [], "bridge": [], "upgrade": 0}
    monkeypatch.setattr(cli, "cmd_upgrade",
                        lambda *a, **k: calls.__setitem__("upgrade", calls["upgrade"] + 1))
    monkeypatch.setattr(cli, "ensure_daemon",
                        lambda cwd, restart=False, **k: calls["daemon"].append(restart))
    # ensure_bridge is imported lazily inside cmd_update from terminal_bridge — patch there.
    import orcha_cli.terminal_bridge as tb
    monkeypatch.setattr(tb, "ensure_bridge",
                        lambda cwd, restart=False, **k: calls["bridge"].append(restart))
    return calls


def test_update_upgrades_and_restarts_both_with_restart_flag(tmp_path, monkeypatch, restarts):
    monkeypatch.chdir(tmp_path)
    _make_project(tmp_path)

    cli.cmd_update(_ns())

    assert restarts["upgrade"] == 1            # project upgrade ran
    assert restarts["daemon"] == [True]        # daemon RESTARTED (not mere ensure)
    assert restarts["bridge"] == [True]        # bridge RESTARTED


def test_no_bridge_skips_bridge_only(tmp_path, monkeypatch, restarts):
    monkeypatch.chdir(tmp_path)
    _make_project(tmp_path)

    cli.cmd_update(_ns(no_bridge=True))

    assert restarts["daemon"] == [True]        # daemon still restarted ...
    assert restarts["bridge"] == []            # ... but the bridge was left alone (mutation teeth)


def test_self_update_reinstalls_and_reexecs_for_editable_install(tmp_path, monkeypatch, restarts):
    """With --no-self OFF and an editable source root present, phase 0 reinstalls the CLI
    then re-execs `orcha update --no-self` and exits with that child's return code —
    so phases 1-3 do NOT run in THIS process."""
    monkeypatch.chdir(tmp_path)
    _make_project(tmp_path)

    src = tmp_path / "orcha-cli"
    src.mkdir()
    (src / "pyproject.toml").write_text("[project]\nname='orcha'\n")
    monkeypatch.setattr(cli, "_cli_source_root", lambda: src)

    reinstalled = {}
    monkeypatch.setattr(cli, "_reinstall_cli",
                        lambda root: reinstalled.setdefault("root", root) or True)
    forwarded = {}

    class _Done(Exception):
        pass

    def _fake_run(cmd, *a, **k):
        forwarded["cmd"] = cmd
        raise _Done

    monkeypatch.setattr(cli.subprocess, "run", _fake_run)

    with pytest.raises(_Done):              # subprocess.run is the re-exec; we stop there
        cli.cmd_update(_ns(no_self=False))

    assert reinstalled["root"] == src
    assert forwarded["cmd"][1:] == ["update", "--no-self"]   # re-exec forwards --no-self
    assert restarts["upgrade"] == 0         # phases 1-3 deferred to the re-exec'd child


def test_self_update_skipped_for_packaged_install(tmp_path, monkeypatch, restarts):
    """No source root (packaged wheel) → phase 0 is skipped and phases 1-3 run in-process."""
    monkeypatch.chdir(tmp_path)
    _make_project(tmp_path)
    monkeypatch.setattr(cli, "_cli_source_root", lambda: None)
    monkeypatch.setattr(cli, "_brew_keg", lambda: None)
    monkeypatch.setattr(cli, "_reinstall_cli",
                        lambda root: pytest.fail("must not reinstall a packaged install"))

    cli.cmd_update(_ns(no_self=False))

    assert restarts["upgrade"] == 1 and restarts["daemon"] == [True]


def test_update_refuses_outside_a_project(tmp_path, monkeypatch, restarts):
    monkeypatch.chdir(tmp_path)        # no .orcha / .claude laid down
    with pytest.raises(SystemExit):
        cli.cmd_update(_ns())
    assert restarts["upgrade"] == 0    # bailed before doing anything


# ---- Homebrew-managed install detection (spec: private brew distribution) ----

def test_brew_keg_detects_cellar_install_through_symlink(tmp_path, monkeypatch):
    """brew links bin/orcha -> ../Cellar/orcha/<ver>/...; detection must resolve
    the symlink and read the formula name from the Cellar path."""
    real = tmp_path / "Cellar" / "orcha" / "0.2.0" / "libexec" / "bin" / "orcha"
    real.parent.mkdir(parents=True)
    real.write_text("#!/bin/sh\n")
    link = tmp_path / "bin" / "orcha"
    link.parent.mkdir()
    link.symlink_to(real)
    monkeypatch.setattr(cli.shutil, "which",
                        lambda name: str(link) if name == "orcha" else None)
    assert cli._brew_keg() == "orcha"


def test_brew_keg_returns_versioned_formula_name(tmp_path, monkeypatch):
    p = tmp_path / "Cellar" / "orcha@0.2.1" / "0.2.1" / "bin" / "orcha"
    p.parent.mkdir(parents=True)
    p.write_text("")
    monkeypatch.setattr(cli.shutil, "which",
                        lambda name: str(p) if name == "orcha" else None)
    assert cli._brew_keg() == "orcha@0.2.1"


def test_brew_keg_none_for_non_brew_install(tmp_path, monkeypatch):
    p = tmp_path / "venv" / "bin" / "orcha"
    p.parent.mkdir(parents=True)
    p.write_text("")
    monkeypatch.setattr(cli.shutil, "which", lambda name: str(p))
    assert cli._brew_keg() is None


def test_brew_keg_none_when_orcha_not_on_path(monkeypatch):
    monkeypatch.setattr(cli.shutil, "which", lambda name: None)
    assert cli._brew_keg() is None


# ---- phase-0 brew arm: upgrade via brew, then re-exec (mirrors editable path) ----

def test_self_update_brew_managed_upgrades_via_brew_and_reexecs(tmp_path, monkeypatch, restarts):
    monkeypatch.chdir(tmp_path)
    _make_project(tmp_path)
    monkeypatch.setattr(cli, "_cli_source_root", lambda: None)
    monkeypatch.setattr(cli, "_brew_keg", lambda: "orcha")
    upgraded = {}
    monkeypatch.setattr(cli, "_brew_upgrade", lambda keg: upgraded.setdefault("keg", keg) or True)
    forwarded = {}

    class _Done(Exception):
        pass

    def _fake_run(cmd, *a, **k):
        forwarded["cmd"] = cmd
        raise _Done

    monkeypatch.setattr(cli.subprocess, "run", _fake_run)

    with pytest.raises(_Done):
        cli.cmd_update(_ns(no_self=False))

    assert upgraded["keg"] == "orcha"
    assert forwarded["cmd"][1:] == ["update", "--no-self"]
    assert restarts["upgrade"] == 0     # phases 1-3 deferred to the re-exec'd child


def test_self_update_brew_failure_continues_in_process(tmp_path, monkeypatch, restarts):
    monkeypatch.chdir(tmp_path)
    _make_project(tmp_path)
    monkeypatch.setattr(cli, "_cli_source_root", lambda: None)
    monkeypatch.setattr(cli, "_brew_keg", lambda: "orcha")
    monkeypatch.setattr(cli, "_brew_upgrade", lambda keg: False)

    cli.cmd_update(_ns(no_self=False))   # must not raise; runs phases 1-3 with current code

    assert restarts["upgrade"] == 1 and restarts["daemon"] == [True]


def test_brew_upgrade_never_moves_a_versioned_pin(monkeypatch, capsys):
    """orcha@X.Y.Z is an explicit downgrade pin; _brew_upgrade must refuse without
    ever invoking brew."""
    monkeypatch.setattr(cli.subprocess, "run",
                        lambda *a, **k: pytest.fail("must not invoke brew for a pinned keg"))
    assert cli._brew_upgrade("orcha@0.2.1") is False
    assert "pinned" in capsys.readouterr().out


def test_brew_upgrade_warns_when_brew_missing(monkeypatch, capsys):
    monkeypatch.setattr(cli.shutil, "which", lambda name: None)
    assert cli._brew_upgrade("orcha") is False
    err = capsys.readouterr().err
    assert "not on PATH" in err


def test_brew_upgrade_happy_path_runs_tap_qualified_upgrade(monkeypatch):
    monkeypatch.setattr(cli.shutil, "which",
                        lambda name: "/opt/homebrew/bin/brew" if name == "brew" else None)
    ran = {}

    class _Ret:
        returncode = 0

    def _fake_run(cmd, *a, **k):
        ran["cmd"] = cmd
        return _Ret()

    monkeypatch.setattr(cli.subprocess, "run", _fake_run)
    assert cli._brew_upgrade("orcha") is True
    assert ran["cmd"] == ["/opt/homebrew/bin/brew", "upgrade", "quantal-labs-ai/orcha/orcha"]


# ----------------------------------------------------------- --no-bridge vs REAL cmd_upgrade
# ISS-84/#235 Gate 2nd-pass regression: the fixture above STUBS cmd_upgrade out, so it never
# exercised cmd_upgrade's own bridge restart — which `orcha update` runs in Phase 1, BEFORE
# the Phase-3 --no-bridge guard. With real cmd_upgrade, --no-bridge was silently defeated.
# These run the REAL cmd_upgrade (only its docker/file side effects patched) and count every
# bridge restart across the whole update.

def _update_with_real_upgrade(tmp_path, monkeypatch, ns):
    """Run cmd_update with the REAL cmd_upgrade (its internals patched), recording every
    terminal-bridge restart across Phase 1 (cmd_upgrade) + Phase 3 (cmd_update)."""
    orcha = tmp_path / ".orcha"
    orcha.mkdir()
    (orcha / "docker-compose.yml").write_text("services: {}\n")
    claude = tmp_path / ".claude"
    claude.mkdir()
    (claude / "orcha.json").write_text(json.dumps(
        {"project_name": "demo", "db_port": 5432, "api_port": 8000, "bridge_port": 8770}))
    monkeypatch.chdir(tmp_path)
    # cmd_upgrade internals → no-ops (no docker, no file copies).
    monkeypatch.setattr(cli, "_compose", lambda *a, **k: None)
    monkeypatch.setattr(cli, "_copy_tree", lambda *a, **k: None)
    monkeypatch.setattr(cli, "ensure_daemon", lambda *a, **k: None)
    monkeypatch.setattr(cli, "_install_orcha_skill_templates", lambda cwd: ([], []))
    monkeypatch.setattr(cli, "_write_hook_config", lambda *a, **k: False)
    import orcha_cli.terminal_bridge as tb
    bridge_restarts = []
    monkeypatch.setattr(tb, "ensure_bridge",
                        lambda cwd, restart=False, **k: bridge_restarts.append(restart))
    cli.cmd_update(ns)
    return bridge_restarts


def test_update_no_bridge_suppresses_real_upgrade_restart(tmp_path, monkeypatch):
    """--no-bridge → ZERO bridge restarts even though Phase-1 cmd_upgrade runs for real.
    This is the exact gap the fixture-stubbed test could not catch."""
    assert _update_with_real_upgrade(tmp_path, monkeypatch, _ns(no_bridge=True)) == []


def test_update_default_restarts_bridge_via_real_upgrade(tmp_path, monkeypatch):
    """Without --no-bridge the bridge IS restarted (mutation teeth for the guard)."""
    restarts = _update_with_real_upgrade(tmp_path, monkeypatch, _ns(no_bridge=False))
    assert restarts and all(r is True for r in restarts)
