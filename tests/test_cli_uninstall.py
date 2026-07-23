"""`orcha uninstall` (GH #26) — clean removal of the host CLI.

Trashing the Mac app left the Homebrew-installed `orcha` CLI behind. `orcha uninstall`
gives a single clean teardown: stop this workspace's notifier daemon + live-terminal
bridge, then uninstall the CLI (brew uninstall for a keg; print uv/pip otherwise). It
must NOT wipe project data or tear down Docker.

Every real side effect (daemon/bridge stop, brew subprocess) is monkeypatched; we assert
purely on the orchestration. Each assertion is mutation-checked (flip an input, the
recorded calls change).
"""
import argparse
import types

import pytest

from orcha_cli import __main__ as cli  # noqa: E402 (conftest puts orcha-cli on sys.path)


def _ns(**over) -> argparse.Namespace:
    base = {"untap": False, "force": False}
    base.update(over)
    return argparse.Namespace(**base)


@pytest.fixture
def harness(monkeypatch):
    """Capture daemon/bridge stops + every subprocess command; stub brew detection."""
    calls = {"daemon": 0, "bridge": 0, "runs": []}
    monkeypatch.setattr(cli, "stop_daemon", lambda cwd, *a, **k: calls.__setitem__("daemon", calls["daemon"] + 1) or True)
    import orcha_cli.terminal_bridge as tb
    monkeypatch.setattr(tb, "stop_bridge", lambda cwd, *a, **k: calls.__setitem__("bridge", calls["bridge"] + 1) or True)

    def _fake_run(cmd, *a, **k):
        calls["runs"].append(list(cmd))
        return types.SimpleNamespace(returncode=0)
    monkeypatch.setattr(cli.subprocess, "run", _fake_run)
    # brew + orcha both resolve on PATH by default
    monkeypatch.setattr(cli.shutil, "which",
                        lambda name: f"/opt/homebrew/bin/{name}" if name in ("brew", "orcha") else None)
    return calls


def _brew_cmds(calls):
    return [c for c in calls["runs"] if c[:1] == ["/opt/homebrew/bin/brew"]]


def test_uninstall_stops_daemons_and_brew_uninstalls(monkeypatch, harness):
    monkeypatch.setattr(cli, "_brew_keg", lambda: "orcha")
    cli.cmd_uninstall(_ns())
    assert harness["daemon"] == 1 and harness["bridge"] == 1     # both background procs stopped
    brews = _brew_cmds(harness)
    assert ["/opt/homebrew/bin/brew", "uninstall", "open-orcha/orcha/orcha"] in brews
    # no untap unless asked; no `down` / data wipe ever
    assert all(c[1] != "untap" for c in brews)


def test_uninstall_untap_flag_also_untaps(monkeypatch, harness):
    monkeypatch.setattr(cli, "_brew_keg", lambda: "orcha")
    cli.cmd_uninstall(_ns(untap=True))
    brews = _brew_cmds(harness)
    assert ["/opt/homebrew/bin/brew", "untap", "open-orcha/orcha"] in brews


def test_versioned_keg_is_not_uninstalled_without_force(monkeypatch, harness):
    monkeypatch.setattr(cli, "_brew_keg", lambda: "orcha@1.2.3")
    cli.cmd_uninstall(_ns())
    assert harness["daemon"] == 1 and harness["bridge"] == 1     # still stops the procs
    assert _brew_cmds(harness) == []                             # but refuses to remove a pinned keg


def test_versioned_keg_uninstalled_with_force(monkeypatch, harness):
    monkeypatch.setattr(cli, "_brew_keg", lambda: "orcha@1.2.3")
    cli.cmd_uninstall(_ns(force=True))
    assert ["/opt/homebrew/bin/brew", "uninstall", "open-orcha/orcha/orcha@1.2.3"] in _brew_cmds(harness)


def test_non_brew_install_prints_instructions_no_subprocess(monkeypatch, harness):
    monkeypatch.setattr(cli, "_brew_keg", lambda: None)          # not a Homebrew keg
    cli.cmd_uninstall(_ns())
    assert harness["daemon"] == 1 and harness["bridge"] == 1     # still stops the procs
    assert harness["runs"] == []                                 # never shells out to remove a dev/uv/pip install
