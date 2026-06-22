"""Pure text / front-matter helpers for the `orcha` CLI.

Self-contained string transforms with no I/O and no dependency on the rest of the
CLI — split out of ``__main__`` so the bulky entrypoint stays focused on command
wiring. ``__main__`` re-imports these names, so existing ``orcha_cli.__main__.<fn>``
references (and the tests that patch them) keep resolving unchanged.
"""
from __future__ import annotations

import json
from typing import Optional


def _sanitize_name(s: str) -> str:
    out = "".join(c if (c.isalnum() or c in "-_") else "-" for c in s.lower())
    return out.strip("-") or "orcha"


def _strip_frontmatter(text: str) -> str:
    if not text.startswith("---\n"):
        return text
    end = text.find("\n---", 4)
    if end < 0:
        return text
    rest = text.find("\n", end + 4)
    return text[rest + 1:] if rest >= 0 else ""


def _frontmatter_value(text: str, key: str) -> Optional[str]:
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---", 4)
    if end < 0:
        return None
    prefix = key + ":"
    for raw in text[4:end].splitlines():
        line = raw.strip()
        if line.startswith(prefix):
            return line[len(prefix):].strip().strip("\"'")
    return None


def _codex_skill_body(name: str, command_md: str) -> str:
    desc = _frontmatter_value(command_md, "description") or f"Run the Orcha {name} workflow."
    body = _strip_frontmatter(command_md).strip()
    return (
        "---\n"
        f"name: {name}\n"
        f"description: {json.dumps(desc)}\n"
        "---\n\n"
        f"# {name}\n\n"
        f"This is the Codex skill mirror of the Claude Code `/{name}` command.\n\n"
        "When invoked from Codex, treat any inline text after the skill mention as the "
        "`$ARGUMENTS` referenced below. If the copied command template mentions "
        "`AskUserQuestion`, ask the user a concise clarifying question directly. When it "
        "suggests another `/orcha-*` slash command, use the matching `$orcha-*` Codex skill.\n\n"
        f"{body}\n"
    )
