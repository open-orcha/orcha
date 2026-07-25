"""Install workspace hooks and publish the current session's wake reachability."""

from __future__ import annotations

import json
import os
import pathlib
import shutil
import subprocess
import sys
from typing import Optional


HOOKS = (
    ("PostToolUse", "orcha poll-inbox", "*"),
    ("PreToolUse", "orcha conv-guard", "*"),
    ("SessionStart", "orcha watch --detach", None),
    ("SessionStart", "orcha rehydrate", None),
    ("SessionEnd", "orcha unwatch", None),
    ("SessionEnd", "orcha snapshot", None),
    ("SessionEnd", "orcha task-claim-guard", None),
    ("SessionStart", "orcha notifier --ensure", None),
    ("SessionStart", "orcha terminal-bridge --ensure", None),
    ("SessionStart", "orcha reachability --quiet", None),
)


def detect_tmux_target() -> Optional[str]:
    """Return this session's tmux pane address when tmux is available."""
    if not shutil.which("tmux") or not os.environ.get("TMUX"):
        return None
    try:
        result = subprocess.run(
            [
                "tmux",
                "display-message",
                "-p",
                "#{session_name}:#{window_index}.#{pane_index}",
            ],
            capture_output=True,
            text=True,
            timeout=3,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return (result.stdout.strip() or None) if result.returncode == 0 else None


def record_reachability(args, services) -> None:
    """Best-effort record of the bound agent's working directory and tmux pane."""
    if services._skip_managed_embodiment_hook("reachability"):
        return
    cwd = pathlib.Path.cwd()
    config_path = cwd / ".claude" / "orcha.json"
    if not config_path.exists():
        return
    try:
        api_base = json.loads(config_path.read_text()).get("api_base_url")
    except Exception:
        return
    if not api_base:
        return
    binding = services._resolve_any_binding(cwd, args.alias)
    if not binding or binding.get("kind") == "human":
        return
    agent_id = binding.get("agent_id")
    if not agent_id:
        return
    body = {"headless_cwd": str(cwd)}
    tmux_target = services._detect_tmux_target()
    if tmux_target:
        body["tmux_target"] = tmux_target
    try:
        services._post_json(
            f"{api_base}/api/agents/{agent_id}/reachability", body
        )
    except Exception:
        return
    if not args.quiet:
        extra = f", tmux={tmux_target}" if tmux_target else ""
        print(
            f"[orcha] reachability recorded for {binding.get('alias')} "
            f"(headless_cwd={cwd}{extra}) — daemon can now wake it"
        )


def write_hook_config(claude_dir: pathlib.Path) -> bool:
    """Add every managed hook without replacing user-defined hook entries."""
    settings_path = claude_dir / "settings.json"
    settings: dict = {}
    if settings_path.exists():
        try:
            settings = json.loads(settings_path.read_text())
            if not isinstance(settings, dict):
                settings = {}
        except Exception:
            return False
    hooks = settings.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        return False

    def ensure(event: str, command: str, matcher: Optional[str]) -> bool:
        entries = hooks.setdefault(event, [])
        if not isinstance(entries, list):
            return False
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            if any(
                isinstance(hook, dict) and hook.get("command") == command
                for hook in entry.get("hooks", []) or []
            ):
                return False
        new_entry: dict = {
            "hooks": [{"type": "command", "command": command}]
        }
        if matcher is not None:
            new_entry["matcher"] = matcher
        entries.append(new_entry)
        return True

    added = False
    for event, command, matcher in HOOKS:
        added |= ensure(event, command, matcher)
    if added:
        claude_dir.mkdir(parents=True, exist_ok=True)
        settings_path.write_text(json.dumps(settings, indent=2) + "\n")
    return added


def enable_hooks(services) -> None:
    """Enable hooks for an existing connected workspace."""
    cwd = pathlib.Path.cwd()
    claude_dir = cwd / ".claude"
    if not (claude_dir / "orcha.json").exists():
        sys.exit(
            "error: no .claude/orcha.json in CWD. Run `orcha init` "
            "(or `orcha connect`) first so the hook has somewhere to poll."
        )
    if services._write_hook_config(claude_dir):
        print(
            f"[orcha] ✓ PostToolUse hook registered in "
            f"{claude_dir / 'settings.json'}"
        )
        print(
            "        Working agents in this folder will now check inbox "
            "between tool calls."
        )
    else:
        print(
            f"[orcha] hook already present in "
            f"{claude_dir / 'settings.json'} (no change)"
        )
