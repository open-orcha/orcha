"""ISS-21 — interactive SessionStart hooks gate off for headless wake workers.

A woken `claude -p` worker must NOT run the interactive SessionStart chain
(watch/rehydrate/notifier --ensure/reachability) — `orcha watch --detach` spawns a
poller that never returns and wedges the worker before it drains its inbox. The
notifier marks every worker with ORCHA_HEADLESS_WORKER=1 and each hook short-circuits
when it's set. Interactive tabs (flag unset) behave exactly as before.
"""
import argparse

from orcha_cli import notifier  # noqa: E402  (conftest puts orcha-cli on sys.path)
from orcha_cli import __main__ as cli  # noqa: E402


def test_skip_helper_respects_marker(monkeypatch):
    monkeypatch.delenv("ORCHA_HEADLESS_WORKER", raising=False)
    monkeypatch.delenv("ORCHA_LIVE", raising=False)
    assert cli._skip_managed_embodiment_hook("watch") is False  # interactive tab → run
    monkeypatch.setenv("ORCHA_HEADLESS_WORKER", "1")
    assert cli._skip_managed_embodiment_hook("watch") is True    # headless worker → no-op


def test_spawn_sets_headless_marker(monkeypatch, tmp_path):
    captured = {}

    class FakePopen:
        def __init__(self, argv, cwd=None, env=None, **kw):
            captured["env"] = env
            self.pid = 1
    monkeypatch.setattr(notifier.shutil, "which", lambda x: "/usr/bin/claude")
    monkeypatch.setattr(notifier.subprocess, "Popen", FakePopen)
    sent, _, _ = notifier.spawn_headless(str(tmp_path), "wake!", None, dry_run=False, alias="B")
    assert sent is True
    assert captured["env"].get("ORCHA_HEADLESS_WORKER") == "1"   # worker is marked


def test_watch_noops_for_headless_worker(monkeypatch, capsys):
    monkeypatch.setenv("ORCHA_HEADLESS_WORKER", "1")
    cli.cmd_watch(argparse.Namespace())          # would otherwise spawn a poller / touch cwd
    out = capsys.readouterr().out
    assert "skipping interactive SessionStart hook 'watch'" in out


def test_reachability_noops_for_headless_worker(monkeypatch, capsys):
    monkeypatch.setenv("ORCHA_HEADLESS_WORKER", "1")
    cli.cmd_reachability(argparse.Namespace())
    assert "skipping interactive SessionStart hook 'reachability'" in capsys.readouterr().out


def test_rehydrate_noops_for_headless_worker(monkeypatch, capsys):
    monkeypatch.setenv("ORCHA_HEADLESS_WORKER", "1")
    cli.cmd_rehydrate(argparse.Namespace())
    assert "skipping interactive SessionStart hook 'rehydrate'" in capsys.readouterr().out


def test_notifier_ensure_noops_for_headless_worker(monkeypatch, capsys):
    """A worker must not manage the daemon: notifier --ensure is a no-op when marked."""
    called = {"ensure": False}
    monkeypatch.setattr(notifier, "ensure_daemon", lambda *a, **k: called.__setitem__("ensure", True))
    monkeypatch.setenv("ORCHA_HEADLESS_WORKER", "1")
    notifier.cmd_notifier(argparse.Namespace(ensure=True, quiet=False))
    assert called["ensure"] is False                            # ensure_daemon NOT called
    assert "skipping notifier --ensure" in capsys.readouterr().out


def test_notifier_ensure_runs_for_interactive(monkeypatch):
    """With the marker unset (interactive tab), notifier --ensure still starts the daemon."""
    called = {"ensure": False}
    monkeypatch.setattr(notifier, "ensure_daemon", lambda *a, **k: called.__setitem__("ensure", True))
    monkeypatch.delenv("ORCHA_HEADLESS_WORKER", raising=False)
    notifier.cmd_notifier(argparse.Namespace(ensure=True, quiet=True))
    assert called["ensure"] is True                             # behavior unchanged for tabs
