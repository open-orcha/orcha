"""Reply style: the project's chosen writing style for every message an agent sends a person.

One choice per project (Project settings): ``normal`` (default), ``caveman`` or ``asd_ste100``.
A conversation or a task thread can override it (the composer chip); the override wins for that
thread only. The server sends the three values with the task protocol on every wake
(``GET /api/agents/{aid}/protocol`` → ``reply_style``), so a change applies on the next wake.

Normal adds nothing to the prompt. The other styles add one section right after the
plain-language guardrail (notifier_persona.HUMAN_COMMS_GUARDRAIL). Each section carries the same
fixed rules: code, commands, errors, paths and quotes stay exact; "elaborate" gets one Normal
reply; GitHub posts and agent-to-agent messages stay Normal; plans never use Caveman (they fall
back to ASD-STE100, because a person approves plans and ambiguity there is costly).
"""

from __future__ import annotations

from typing import Optional

NORMAL = "normal"
CAVEMAN = "caveman"
ASD_STE100 = "asd_ste100"
REPLY_STYLES = (NORMAL, CAVEMAN, ASD_STE100)

_SCOPE = (
    "- Applies to every message you send a person: conversation replies, task-thread posts, "
    "plans, verification and needs-verification requests, and questions to people."
)
_EXACT = (
    "- Always exact, never shortened or reworded: code, commands, error text, file paths, "
    "quotes, names, numbers and links."
)
_ELABORATE = (
    "- One-reply override: when the person asks you to elaborate, explain more or give "
    "details, write that one reply in normal full prose. Return to this style on the next reply."
)
_OUT_OF_SCOPE = (
    "- Not covered (write these normally): GitHub posts (pull request bodies, issue comments, "
    "commit messages), because the public reads them, and messages to other agents."
)

_STE_RULES = (
    "- Active voice. One topic per sentence.\n"
    "- Descriptive sentences: 25 words or fewer.\n"
    "- Procedures: numbered commands, one instruction per step, 20 words or fewer per step.\n"
    "- One meaning per word. Use the same word for the same thing every time. Prefer simple, "
    "common words.\n"
    "- No filler, no idioms, no figures of speech."
)

CAVEMAN_SECTION = (
    "## Reply style: Caveman (project setting)\n"
    "Write terse. Drop articles, filler, pleasantries and hedging. Fragments OK. Keep technical "
    "words exact.\n"
    f"{_SCOPE}\n"
    "- Plans are the exception: never write a plan (a plan card or a plan sent for approval) in "
    "Caveman. Write plans in ASD-STE100 Simplified Technical English instead:\n"
    "  active voice; descriptive sentences of 25 words or fewer; steps as numbered commands, one "
    "instruction per step; one meaning per word; no filler.\n"
    f"{_EXACT}\n"
    f"{_ELABORATE}\n"
    f"{_OUT_OF_SCOPE}"
)

ASD_STE100_SECTION = (
    "## Reply style: ASD-STE100 Simplified Technical English (project setting)\n"
    "Write in ASD-STE100, the aerospace writing standard:\n"
    f"{_STE_RULES}\n"
    f"{_SCOPE}\n"
    f"{_EXACT}\n"
    f"{_ELABORATE}\n"
    f"{_OUT_OF_SCOPE}"
)

_SECTIONS = {CAVEMAN: CAVEMAN_SECTION, ASD_STE100: ASD_STE100_SECTION}


def _valid(value: object) -> Optional[str]:
    return value if isinstance(value, str) and value in REPLY_STYLES else None


def resolve_reply_style(reply_style: Optional[dict], lane: str = "work") -> str:
    """Pick the style for this wake from the protocol's ``reply_style`` block.

    ``reply_style`` is ``{"project": ..., "task": ..., "conversation": ...}`` (any may be
    missing or null). A thread override beats the project setting: the conversation's on the
    conversation lane, the task's on any other lane. Unknown values are ignored, and anything
    missing falls back to ``normal``.
    """
    block = reply_style if isinstance(reply_style, dict) else {}
    thread_key = "conversation" if lane == "conversation" else "task"
    return _valid(block.get(thread_key)) or _valid(block.get("project")) or NORMAL


def reply_style_section(style: Optional[str]) -> Optional[str]:
    """The prompt section for ``style``; ``None`` for Normal (or anything unknown)."""
    return _SECTIONS.get(style or NORMAL)


NORMAL_TURN_NOTE = (
    "[reply style for this conversation] Normal: write normally and ignore any \"Reply style\" "
    "rules given earlier in this session."
)


def turn_style_note(
    style: Optional[str],
    *,
    started_style: Optional[str] = None,
    override: Optional[str] = None,
) -> Optional[str]:
    """What a warm conversation turn carries so a mid-chat style change takes effect.

    A running (or resumed) chat session keeps the system prompt it booted with, so the
    composer chip / project setting has to ride on the fed turn itself. ``style`` is the
    conversation's current style (None from an older server: add nothing). ``started_style``
    is the style the session was cold-booted with (None when unknown, e.g. a resumed session).

    - Same style as the boot prompt: nothing (the rules are already in the system prompt).
    - Another non-Normal style: that style's full rules.
    - Normal: a one-line note to drop earlier style rules, when the session started under a
      style or the chat explicitly chose Normal; otherwise nothing (the common default case).
    """
    style = _valid(style)
    if style is None:
        return None
    if started_style is not None and style == started_style:
        return None
    if style != NORMAL:
        return f"[reply style for this conversation]\n{_SECTIONS[style]}"
    if override == NORMAL or _valid(started_style) not in (None, NORMAL):
        return NORMAL_TURN_NOTE
    return None
