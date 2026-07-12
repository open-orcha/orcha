import argparse
import json

from orcha_cli import __main__ as cli


def test_conversation_guard_allows_memory_write(monkeypatch, capsys):
    """Conversation embodiments may write their own Claude Code memory; it is bookkeeping."""
    monkeypatch.setenv("ORCHA_CONVERSATION_WORKER", "1")
    monkeypatch.setattr(cli, "_read_hook_stdin", lambda: {
        "tool_name": "Write",
        "tool_input": {"file_path": "/Users/me/.claude/projects/demo/memory/state.md"},
    })

    cli.cmd_conv_guard(argparse.Namespace())

    assert capsys.readouterr().out == ""


def test_conversation_guard_blocks_nonmemory_write(monkeypatch, capsys):
    monkeypatch.setenv("ORCHA_CONVERSATION_WORKER", "1")
    monkeypatch.setattr(cli, "_read_hook_stdin", lambda: {
        "tool_name": "Write",
        "tool_input": {"file_path": "/repo/orcha-cli/orcha_cli/notifier.py"},
    })

    cli.cmd_conv_guard(argparse.Namespace())

    out = json.loads(capsys.readouterr().out)
    hook = out["hookSpecificOutput"]
    assert hook["permissionDecision"] == "deny"
    assert "conversation embodiment" in hook["permissionDecisionReason"]
