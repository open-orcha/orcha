"""Fetch and render the session-start continuity brief for a bound agent."""

from __future__ import annotations

import json
import pathlib


def format_brief(brief: dict) -> str:
    """Render an agent rehydration response as compact plain text."""
    identity = brief.get("identity") or {}
    alias = identity.get("alias", "?")
    lines = [
        f"[orcha] ⏪ Rehydrated session — you are {alias} "
        f"({identity.get('role', '?')}).",
        f"        agent_id {identity.get('id', '?')} · status "
        f"{identity.get('status', '?')} · turns "
        f"{identity.get('turns_used', '?')}/{identity.get('turn_budget', '?')}",
    ]
    tasks = brief.get("tasks") or []
    if tasks:
        lines.append(f"  Your live tasks ({len(tasks)}):")
        for task in tasks[:6]:
            lines.append(
                f"    • [{task.get('status')}] {task.get('title')}  "
                f"(id {str(task.get('id'))[:8]})"
            )
            if task.get("last_message"):
                lines.append(
                    f"        last note: {task['last_message'][:140]}"
                )
    inbox = brief.get("inbox") or []
    if inbox:
        lines.append(f"  Inbox — open requests to answer ({len(inbox)}):")
        for item in inbox[:6]:
            lines.append(
                f"    ← {item.get('requester_alias')}: "
                f"{(item.get('payload') or '')[:120]}  "
                f"(id {str(item.get('id'))[:8]})"
            )
    outbox = brief.get("outbox") or []
    if outbox:
        lines.append(f"  Your asks now answered ({len(outbox)}):")
        for item in outbox[:6]:
            lines.append(
                f"    → {item.get('target_alias')}: "
                f"{(item.get('response') or '')[:120]}  "
                f"(id {str(item.get('id'))[:8]})"
            )
    digest = brief.get("digest")
    if digest:
        lines.append(
            "  Memory digest (your prior reasoning; re-check external state "
            "before trusting it):"
        )
        lines.append(
            "    Treat PR/issue/task/request status, review state, and "
            "who-owes-what as pointers"
        )
        lines.append(
            "    to verify live before acting or deciding there is nothing to do."
        )
        if digest.get("current_focus"):
            lines.append(f"    focus: {digest['current_focus']}")
        for label in ("decisions", "learnings", "open_threads"):
            items = digest.get(label) or []
            if items:
                lines.append(f"    {label}:")
                for item in items[:5]:
                    text = item.get("text") if isinstance(item, dict) else str(item)
                    lines.append(f"      - {text}")
    else:
        lines.append(
            "  Memory digest: none yet — run /orcha-snapshot to capture "
            "your reasoning."
        )
    lines.append(
        f"  Resume: handle inbox first if any, else /orcha-next --alias "
        f"{alias} (or /loop /orcha-listen --alias {alias})."
    )
    return "\n".join(lines)


def rehydrate(args, services) -> None:
    """Best-effort fetch and print of the bound agent's continuity brief."""
    if services._skip_managed_embodiment_hook("rehydrate"):
        return
    try:
        cwd = pathlib.Path.cwd()
        config_path = cwd / ".claude" / "orcha.json"
        if not config_path.exists():
            return
        api_base = json.loads(config_path.read_text()).get("api_base_url")
        if not api_base:
            return
        binding = services._resolve_any_binding(cwd, args.alias)
        if not binding or not binding.get("agent_id"):
            return
        brief = services._get_json(
            f"{api_base}/api/agents/{binding['agent_id']}/rehydrate",
            timeout=4.0,
        )
        if brief:
            print(services._fmt_rehydrate_brief(brief))
    except Exception:
        return
