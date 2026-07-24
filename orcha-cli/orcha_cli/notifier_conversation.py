"""Build one-shot conversation prompts and recover their final reply text."""
from __future__ import annotations

import json
import pathlib
from collections.abc import Callable
from typing import Optional


DISPATCH_DIRECTIVE = (
    "Decide whether the human's ask is QUICK or REAL WORK. QUICK (a question, brainstorm, status, a "
    "small lookup — under ~3-4 min): answer it directly as your chat reply. REAL WORK (more than "
    "~3-4 min, or touching code, tests, PRs, or a long investigation): do NOT do it inline — CREATE "
    "an assigned task (clear plain-English title; a description preserving the human's ask + context; "
    "a definition of done; and a protocol note telling the assigned worker to POST its findings back "
    "to the task thread), then make your chat reply ONE short line plus the task link, e.g. \"I'll "
    "handle this in the background — follow the task thread: <link>\". You may decide up front or "
    "mid-reply. For a self-referential task assigned to yourself/current agent that overlaps your "
    "live context from this conversation, do only the tiny resident-only slice first and include its "
    "result in the initial task description or protocol notes before assignment, so the worker "
    "inherits it and does not redo it; unrelated tasks keep the normal fresh handoff path. Do not "
    "call `/orcha-listen`."
)


def simple_history(turns: list[dict]) -> str:
    """Render a bounded mechanical conversation history."""
    rows = []
    for turn in turns[-20:]:
        content = (turn.get("content") or "").strip()
        attachments = [a for a in (turn.get("attachments") or []) if isinstance(a, dict)]
        if not content and not attachments:
            continue
        who = "Human" if turn.get("role") == "human" else "Agent"
        marker = ""
        if attachments:
            names = ", ".join(
                f"{a.get('name') or a.get('id')} ({a.get('kind') or 'file'})"
                for a in attachments
            )
            marker = f"  [attached {len(attachments)} file(s): {names}]"
        rows.append(f"{who}: {content}{marker}")
    return "## Conversation so far\n\n" + "\n\n".join(rows) if rows else ""


def worker_prompt(
    alias: str,
    pending_turns: list[dict],
    history_turns: list[dict],
    api_base: Optional[str],
    *,
    cold_history: Callable[[list[dict]], str],
    extract_attachment_text: Callable,
    render_attachment_feed: Callable,
) -> str:
    """Build a cold one-shot Codex prompt, including attachments and prior turns."""
    history = cold_history(history_turns) or simple_history(history_turns)
    pending = [
        turn
        for turn in pending_turns
        if (turn.get("content") or "").strip() or (turn.get("attachments") or [])
    ]
    latest = "\n\n".join(
        f"Human turn seq {turn.get('seq')}: "
        f"{(turn.get('content') or '').strip() or '(no text — see attached files)'}"
        for turn in pending
    ) or "(empty human message)"
    attachments = [
        attachment
        for turn in pending
        for attachment in (turn.get("attachments") or [])
        if isinstance(attachment, dict)
    ]
    extracted = extract_attachment_text(attachments, api_base)
    feed = render_attachment_feed(
        attachments, api_base=api_base, runtime="codex", extracted=extracted
    )
    feed_block = f"\n\n{feed}" if feed else ""
    return (
        f"[orcha conversation] {alias or 'agent'}: reply to the human in Orcha's "
        "Conversation tab. This is a ONE-SHOT Codex conversation worker, not a resident "
        "stdin session. Use tools if needed, but make your final answer the chat reply "
        "that should be appended to the conversation.\n"
        f"{DISPATCH_DIRECTIVE}\n\n{history}\n\n"
        f"## Pending Human Message(s)\n\n{latest}\n{feed_block}"
    )


def resume_prompt(alias: str, pending_turns: list[dict]) -> str:
    """Build the small prompt for a resumed Codex conversation session."""
    latest = "\n\n".join(
        f"Human turn seq {turn.get('seq')}: {(turn.get('content') or '').strip()}"
        for turn in pending_turns
        if (turn.get("content") or "").strip()
    ) or "(empty human message)"
    return (
        f"[orcha conversation] {alias or 'agent'}: continue replying to the human in Orcha's "
        "Conversation tab. This RESUMES your existing Codex session — the prior conversation is "
        "already in your context, so do NOT restate it. Make your final answer the chat reply "
        "appended to the conversation.\n"
        f"{DISPATCH_DIRECTIVE}\n\n## New Human Message(s)\n\n{latest}\n"
    )


def text_from_content(content) -> Optional[str]:
    """Extract plain text from supported assistant-message content shapes."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return None
    parts = []
    for block in content:
        if not isinstance(block, dict):
            continue
        if isinstance(block.get("text"), str):
            parts.append(block["text"])
        elif (
            block.get("type") in ("text", "output_text")
            and isinstance(block.get("content"), str)
        ):
            parts.append(block["content"])
    return "\n".join(part for part in parts if part).strip() or None


def reply_text(log_path, last_message_path, *, result_after: Callable) -> Optional[str]:
    """Recover the final assistant reply from the preferred file or JSONL fallback."""
    if last_message_path:
        try:
            text = pathlib.Path(last_message_path).read_text().strip()
            if text:
                return text
        except OSError:
            pass
    result = result_after(log_path, 0)
    if result and result.get("text"):
        return str(result["text"]).strip() or None
    if not log_path:
        return None
    try:
        lines = pathlib.Path(log_path).read_text(errors="replace").splitlines()
    except OSError:
        return None
    last = None
    for line in lines:
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        typ = obj.get("type")
        message = obj.get("message")
        role = obj.get("role")
        if role is None and isinstance(message, dict):
            role = message.get("role")
        candidate = None
        if typ == "result":
            candidate = obj.get("result")
        elif role == "assistant" or typ in {"assistant", "agent_message", "assistant_message"}:
            if isinstance(message, str):
                candidate = message
            elif isinstance(message, dict):
                candidate = text_from_content(message.get("content"))
            candidate = candidate or text_from_content(obj.get("content")) or obj.get("text")
        if isinstance(candidate, str) and candidate.strip():
            last = candidate.strip()
    return last
