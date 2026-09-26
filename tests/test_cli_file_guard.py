"""`orcha file-guard` — per-file edit locks for agents sharing one checkout."""

import argparse
import json
import pathlib
import threading
import time

import pytest

from orcha_cli import __main__ as cli
from orcha_cli import cli_file_lock


def _payload(event, tool_name="Edit", path="src/app.py", session="s1", cwd=None, **extra):
    body = {
        "hook_event_name": event,
        "session_id": session,
        "cwd": str(cwd) if cwd else None,
        "tool_name": tool_name,
        "tool_input": {"file_path": path},
    }
    body.update(extra)
    return body


def _guard(monkeypatch, capsys, payload):
    monkeypatch.setattr(cli, "_read_hook_stdin", lambda: payload)
    cli.cmd_file_guard(argparse.Namespace())
    return capsys.readouterr().out


def _locks(root):
    return sorted(p.name for p in pathlib.Path(root).glob("*.json"))


def test_lock_root_uses_git_common_dir_and_falls_back_outside_git(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    import subprocess

    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    root = cli_file_lock.lock_root(repo)
    assert root == (repo / ".git" / "orcha" / "file-locks").resolve() or root == (
        repo / ".git" / "orcha" / "file-locks"
    )

    plain = tmp_path / "plain"
    plain.mkdir()
    assert cli_file_lock.lock_root(plain) == plain / ".claude" / ".orcha-file-locks"


def test_edit_tools_only_and_notebook_path_supported():
    assert cli_file_lock.edited_paths("Edit", {"file_path": "a.py"}) == ["a.py"]
    assert cli_file_lock.edited_paths("NotebookEdit", {"notebook_path": "n.ipynb"}) == [
        "n.ipynb"
    ]
    assert cli_file_lock.edited_paths("Read", {"file_path": "a.py"}) == []
    assert cli_file_lock.edited_paths("Bash", {"command": "rm a.py"}) == []
    assert cli_file_lock.edited_paths("Write", "not-a-dict") == []


def test_pre_acquires_and_post_releases_same_session(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(cli_file_lock, "lock_root", lambda cwd: tmp_path / "locks")

    assert _guard(monkeypatch, capsys, _payload("PreToolUse", cwd=tmp_path)) == ""
    assert len(_locks(tmp_path / "locks")) == 1
    record = json.loads(next((tmp_path / "locks").glob("*.json")).read_text())
    assert record["owner"] == "s1"
    assert record["path"].endswith("src/app.py")

    assert _guard(monkeypatch, capsys, _payload("PostToolUse", cwd=tmp_path)) == ""
    assert _locks(tmp_path / "locks") == []


def test_other_session_waits_until_holder_releases(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(cli_file_lock, "lock_root", lambda cwd: tmp_path / "locks")
    monkeypatch.setenv("ORCHA_FILE_LOCK_WAIT_SECS", "5")
    assert _guard(monkeypatch, capsys, _payload("PreToolUse", session="holder", cwd=tmp_path)) == ""

    def release_later():
        time.sleep(0.6)
        lock = cli_file_lock.FileLock(tmp_path / "locks", "holder")
        lock.release("src/app.py", tmp_path)

    threading.Thread(target=release_later, daemon=True).start()
    started = time.monotonic()
    out = _guard(monkeypatch, capsys, _payload("PreToolUse", session="waiter", cwd=tmp_path))
    waited = time.monotonic() - started

    assert out == "", "waiter must be allowed once the holder releases"
    assert 0.4 <= waited < 5
    record = json.loads(next((tmp_path / "locks").glob("*.json")).read_text())
    assert record["owner"] == "waiter"


def test_other_session_is_denied_after_wait_budget(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(cli_file_lock, "lock_root", lambda cwd: tmp_path / "locks")
    monkeypatch.setenv("ORCHA_ALIAS", "builder")
    assert _guard(monkeypatch, capsys, _payload("PreToolUse", session="holder", cwd=tmp_path)) == ""
    monkeypatch.setenv("ORCHA_FILE_LOCK_WAIT_SECS", "0.3")
    monkeypatch.setenv("ORCHA_FILE_LOCK_STALE_SECS", "600")
    monkeypatch.setattr(cli_file_lock, "POLL_SECS", 0.05)

    out = json.loads(
        _guard(monkeypatch, capsys, _payload("PreToolUse", session="waiter", cwd=tmp_path))
    )
    hook = out["hookSpecificOutput"]
    assert hook["permissionDecision"] == "deny"
    assert "held by builder" in hook["permissionDecisionReason"]
    assert "retry" in hook["permissionDecisionReason"]
    # The holder's lock is untouched.
    record = json.loads(next((tmp_path / "locks").glob("*.json")).read_text())
    assert record["owner"] == "holder"


def test_different_files_never_wait_on_each_other(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(cli_file_lock, "lock_root", lambda cwd: tmp_path / "locks")
    monkeypatch.setenv("ORCHA_FILE_LOCK_WAIT_SECS", "0.2")
    assert _guard(monkeypatch, capsys, _payload("PreToolUse", session="a", path="x.py", cwd=tmp_path)) == ""
    assert _guard(monkeypatch, capsys, _payload("PreToolUse", session="b", path="y.py", cwd=tmp_path)) == ""
    assert len(_locks(tmp_path / "locks")) == 2


def test_stale_lock_from_crashed_session_is_broken(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(cli_file_lock, "lock_root", lambda cwd: tmp_path / "locks")
    monkeypatch.setenv("ORCHA_FILE_LOCK_WAIT_SECS", "1")
    monkeypatch.setenv("ORCHA_FILE_LOCK_STALE_SECS", "0.2")
    assert _guard(monkeypatch, capsys, _payload("PreToolUse", session="crashed", cwd=tmp_path)) == ""
    time.sleep(0.3)

    assert _guard(monkeypatch, capsys, _payload("PreToolUse", session="next", cwd=tmp_path)) == ""
    record = json.loads(next((tmp_path / "locks").glob("*.json")).read_text())
    assert record["owner"] == "next"


def test_new_tool_call_releases_leftover_locks_of_same_session(tmp_path, monkeypatch, capsys):
    """A failed edit never fires PostToolUse; the session's next tool call cleans up."""
    monkeypatch.setattr(cli_file_lock, "lock_root", lambda cwd: tmp_path / "locks")
    assert _guard(monkeypatch, capsys, _payload("PreToolUse", session="s1", cwd=tmp_path)) == ""
    assert len(_locks(tmp_path / "locks")) == 1

    assert _guard(monkeypatch, capsys, _payload("PreToolUse", tool_name="Bash", session="s1", cwd=tmp_path)) == ""
    assert _locks(tmp_path / "locks") == []


def test_session_end_releases_everything_held_by_that_session(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(cli_file_lock, "lock_root", lambda cwd: tmp_path / "locks")
    assert _guard(monkeypatch, capsys, _payload("PreToolUse", session="s1", path="x.py", cwd=tmp_path)) == ""
    assert _guard(monkeypatch, capsys, _payload("PreToolUse", session="s2", path="y.py", cwd=tmp_path)) == ""

    assert _guard(monkeypatch, capsys, {"hook_event_name": "SessionEnd", "session_id": "s1", "cwd": str(tmp_path)}) == ""
    remaining = [json.loads(p.read_text())["owner"] for p in (tmp_path / "locks").glob("*.json")]
    assert remaining == ["s2"]


def test_reentrant_acquire_keeps_lock(tmp_path):
    lock = cli_file_lock.FileLock(tmp_path / "locks", "s1")
    assert lock.acquire("a.py", tmp_path, wait=0, stale=60)[0]
    assert lock.acquire("a.py", tmp_path, wait=0, stale=60)[0]
    assert len(_locks(tmp_path / "locks")) == 1
    assert lock.release("a.py", tmp_path)
    assert not lock.release("a.py", tmp_path)


def test_release_never_drops_another_sessions_lock(tmp_path):
    holder = cli_file_lock.FileLock(tmp_path / "locks", "holder")
    other = cli_file_lock.FileLock(tmp_path / "locks", "other")
    assert holder.acquire("a.py", tmp_path, wait=0, stale=60)[0]
    assert not other.release("a.py", tmp_path)
    assert other.release_all() == 0
    assert len(_locks(tmp_path / "locks")) == 1


@pytest.mark.parametrize("value", ["0", "false", "off"])
def test_env_switch_disables_guard(tmp_path, monkeypatch, capsys, value):
    monkeypatch.setattr(cli_file_lock, "lock_root", lambda cwd: tmp_path / "locks")
    monkeypatch.setenv("ORCHA_FILE_LOCK", value)
    assert _guard(monkeypatch, capsys, _payload("PreToolUse", cwd=tmp_path)) == ""
    assert not (tmp_path / "locks").exists()


def test_guard_fails_open_on_internal_error(monkeypatch, capsys):
    monkeypatch.setattr(cli_file_lock, "lock_root", lambda cwd: (_ for _ in ()).throw(RuntimeError("boom")))
    assert _guard(monkeypatch, capsys, _payload("PreToolUse", cwd="/nowhere")) == ""


def test_managed_hooks_register_file_guard_with_timeout(tmp_path):
    from orcha_cli import cli_hooks

    claude_dir = tmp_path / ".claude"
    assert cli_hooks.write_hook_config(claude_dir)
    settings = json.loads((claude_dir / "settings.json").read_text())
    pre = [
        hook
        for entry in settings["hooks"]["PreToolUse"]
        for hook in entry["hooks"]
        if hook["command"] == "orcha file-guard"
    ]
    assert pre and pre[0]["timeout"] > cli_file_lock.DEFAULT_WAIT_SECS
    post = [
        entry
        for entry in settings["hooks"]["PostToolUse"]
        if any(h["command"] == "orcha file-guard" for h in entry["hooks"])
    ]
    assert post and post[0]["matcher"] == "Edit|Write|MultiEdit|NotebookEdit"
    assert any(
        h["command"] == "orcha file-guard"
        for entry in settings["hooks"]["SessionEnd"]
        for h in entry["hooks"]
    )
    # Idempotent.
    assert not cli_hooks.write_hook_config(claude_dir)
