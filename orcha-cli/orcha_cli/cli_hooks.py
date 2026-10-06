"""Install workspace hooks and publish the current session's wake reachability."""

from __future__ import annotations

import json
import os
import pathlib
import shutil
import subprocess
import sys
from typing import Optional


# (event, command, matcher, timeout_secs). EVERY Orcha hook carries an explicit
# timeout so a hung API / wedged daemon can never stall a Claude session at start,
# on a tool call, or at exit. `orcha upgrade` rewrites these on already-registered
# Orcha hooks (see _ensure_hooks), so existing projects pick them up too.
#   * SessionStart daemons / --ensure / reachability / rehydrate: 10s — each is a
#     quick spawn-and-return or a single bounded HTTP call.
#   * poll-inbox / conv-guard: 5s — a local file read / env check on every tool call.
#   * The file-guard PreToolUse entry may BLOCK while another agent holds a file
#     lock, so its cap sits above the guard's own wait budget
#     (cli_file_lock.DEFAULT_WAIT_SECS = 600s); its release events are just unlinks.
#   * SessionEnd snapshot / task-claim-guard make a few HTTP calls: 30s.
HOOKS = (
    ("PostToolUse", "orcha poll-inbox", "*", 5),
    ("PreToolUse", "orcha conv-guard", "*", 5),
    ("PreToolUse", "orcha file-guard", "*", 660),
    ("PostToolUse", "orcha file-guard", "Edit|Write|MultiEdit|NotebookEdit", 10),
    ("SessionEnd", "orcha file-guard", None, 10),
    ("SessionStart", "orcha watch --detach", None, 10),
    ("SessionStart", "orcha rehydrate", None, 10),
    ("SessionEnd", "orcha unwatch", None, 10),
    ("SessionEnd", "orcha snapshot", None, 30),
    ("SessionEnd", "orcha task-claim-guard", None, 30),
    ("SessionStart", "orcha notifier --ensure", None, 10),
    ("SessionStart", "orcha terminal-bridge --ensure", None, 10),
    ("SessionStart", "orcha reachability --quiet", None, 10),
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


# Codex CLI (>= 0.153) reads the same hook schema from <repo>/.codex/hooks.json.
# Only the file-lock guard is registered there: Codex edits arrive as one
# ``apply_patch`` call (matcher aliases Edit/Write), and the other Orcha hooks are
# Claude-session bookkeeping.
CODEX_HOOKS = (
    ("PreToolUse", "orcha file-guard", "*", 660),
    ("PostToolUse", "orcha file-guard", "apply_patch|Edit|Write", 10),
    ("SessionEnd", "orcha file-guard", None, 10),
)


def _ensure_hooks(settings: dict, specs) -> Optional[bool]:
    """Merge ``specs`` into ``settings['hooks']``; None means the file is unusable.

    Additive for missing Orcha hooks, and idempotently brings the ``timeout`` of an
    already-registered Orcha hook (same event + exact command) to the template value.
    Hooks whose command is not an Orcha template command are never touched.
    Returns whether anything changed."""
    hooks = settings.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        return None
    changed = False
    for event, command, matcher, timeout in specs:
        entries = hooks.setdefault(event, [])
        if not isinstance(entries, list):
            return None
        found = False
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            for hook in entry.get("hooks", []) or []:
                if isinstance(hook, dict) and hook.get("command") == command:
                    found = True
                    if hook.get("timeout") != timeout:
                        hook["timeout"] = timeout
                        changed = True
        if found:
            continue
        new_entry: dict = {
            "hooks": [{"type": "command", "command": command, "timeout": timeout}]
        }
        if matcher is not None:
            new_entry["matcher"] = matcher
        entries.append(new_entry)
        changed = True
    return changed


def write_codex_hook_config(project_dir: pathlib.Path) -> bool:
    """Register the file-lock guard for Codex workers in <project>/.codex/hooks.json."""
    hooks_path = pathlib.Path(project_dir) / ".codex" / "hooks.json"
    settings: dict = {}
    if hooks_path.exists():
        try:
            settings = json.loads(hooks_path.read_text())
            if not isinstance(settings, dict):
                settings = {}
        except Exception:
            return False
    added = _ensure_hooks(settings, CODEX_HOOKS)
    if not added:
        return False
    try:
        hooks_path.parent.mkdir(parents=True, exist_ok=True)
        hooks_path.write_text(json.dumps(settings, indent=2) + "\n")
    except OSError:
        return False
    return True


def write_hook_config(claude_dir: pathlib.Path) -> bool:
    """Add every managed hook (and refresh Orcha hooks' timeouts) without touching
    user-defined hook entries."""
    settings_path = claude_dir / "settings.json"
    settings: dict = {}
    if settings_path.exists():
        try:
            settings = json.loads(settings_path.read_text())
            if not isinstance(settings, dict):
                settings = {}
        except Exception:
            return False
    added = _ensure_hooks(settings, HOOKS)
    if added is None:
        return False
    if added:
        claude_dir.mkdir(parents=True, exist_ok=True)
        settings_path.write_text(json.dumps(settings, indent=2) + "\n")
    codex_added = write_codex_hook_config(pathlib.Path(claude_dir).parent)
    return added or codex_added


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
