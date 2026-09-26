"""Surface watcher events and enforce conversation-lane tool restrictions."""

from __future__ import annotations

import json
import os
import pathlib
import re


CONV_BLOCKED_SLASH = (
    "orcha-next",
    "orcha-accept-task",
    "orcha-done",
    "orcha-self-wake",
)
CONV_BLOCKED_TOOLS = ("Edit", "Write", "NotebookEdit")
CONV_INTERNAL_AGENT_TOOLS = ("Agent", "Task")
CONV_MEMORY_DIR_RE = re.compile(r"/\.claude/projects/[^/]+/memory/")


def is_memory_write(tool_input: dict) -> bool:
    """Return whether a write targets the conversation agent's own memory."""
    path = str(
        tool_input.get("file_path") or tool_input.get("notebook_path") or ""
    )
    return bool(CONV_MEMORY_DIR_RE.search(path.replace("\\", "/")))


def poll_inbox(args, services) -> None:
    """Drain watcher-queued inbox and answered-outbox summaries."""
    cwd = pathlib.Path.cwd()
    if not (cwd / ".claude" / "orcha.json").exists():
        return
    binding = services._resolve_any_binding(cwd, args.alias)
    if not binding or binding.get("kind") == "human":
        return
    alias = binding.get("alias")
    if not alias:
        return
    state = services._read_watch_state(cwd, alias)
    queued = state.get("queued") or []
    if not queued:
        return
    state["queued"] = []
    try:
        services._atomic_write_json(
            services._watch_state_path(cwd, alias), state
        )
    except Exception:
        return

    count = len(queued)
    suffix = "s" if count != 1 else ""
    print(
        f"[orcha] 🔔 {count} new item{suffix} for {alias} "
        "(from background watcher):"
    )
    incoming = [q for q in queued if q.get("channel") == "inbox"]
    answered = [
        q for q in queued if q.get("channel") == "outbox-answered"
    ]
    for item in incoming[:5]:
        preview = (item.get("preview") or "").replace("\n", " ").strip()
        if len(preview) > 100:
            preview = preview[:97] + "..."
        depth = item.get("chain_depth") or 0
        chain = f" chain-depth={depth}" if depth else ""
        print(
            f"  ← {item.get('type', 'info')} "
            f"{(item.get('id') or '')[:8]} from {item.get('from') or '?'} "
            f"(p={item.get('priority', '?')}){chain}: \"{preview}\""
        )
    if len(incoming) > 5:
        print(f"  ← ...and {len(incoming) - 5} more incoming")
    for item in answered[:5]:
        preview = (
            (item.get("answer_preview") or "")
            .replace("\n", " ")
            .strip()
        )
        if len(preview) > 100:
            preview = preview[:97] + "..."
        print(
            f"  → answer to your ask {(item.get('id') or '')[:8]} "
            f"({item.get('to') or '?'}): \"{preview}\""
        )
    if len(answered) > 5:
        print(f"  → ...and {len(answered) - 5} more answered outgoing")
    print(
        f"Handle at the next step boundary: `/orcha-inbox --alias {alias}` "
        f"for full thread, or `/orcha-outbox --alias {alias}` for answered asks."
    )


def conversation_guard(services) -> None:
    """Deny work-lane mutations from a conversation embodiment."""
    if os.environ.get("ORCHA_CONVERSATION_WORKER") != "1":
        return
    payload = services._read_hook_stdin()
    tool_name = payload.get("tool_name") or ""
    tool_input = payload.get("tool_input") or {}
    if not isinstance(tool_input, dict):
        tool_input = {}
    reason = None
    if tool_name in services._CONV_INTERNAL_AGENT_TOOLS:
        reason = (
            f"{tool_name} creates an internal sub-agent thread, not a visible Orcha task or "
            "task request. A conversation embodiment must hand off real work through the local "
            "Orcha task skill/API and verify the task there before returning a link."
        )
    elif tool_name in services._CONV_BLOCKED_TOOLS and not services._conv_is_memory_write(
        tool_input
    ):
        reason = (
            f"{tool_name} is blocked for a conversation embodiment. You are "
            "the conversation responder: dispatch code work to an assigned "
            "task (with a clear title/DoD/protocol) instead of editing files "
            "inline. (Writes to your own memory directory are allowed.)"
        )
    elif tool_name == "SlashCommand":
        command = str(tool_input.get("command") or "").lstrip("/").strip()
        first = command.split()[0] if command else ""
        if first in services._CONV_BLOCKED_SLASH:
            reason = (
                f"/{first} is a WORK-lane task action, blocked for a "
                "conversation embodiment. You dispatch work (create/assign a "
                "task, reply inline) — you do not claim or advance tasks "
                "yourself. Create an assigned task and reply with the task link."
            )
    if reason is not None:
        print(
            json.dumps(
                {
                    "hookSpecificOutput": {
                        "hookEventName": "PreToolUse",
                        "permissionDecision": "deny",
                        "permissionDecisionReason": reason,
                    }
                }
            )
        )
