"""Assemble stable persona, human-communication, task, and digest prompt sections."""

from __future__ import annotations

import json
from typing import Optional

from .notifier_handoff_policy import (
    LOCAL_HANDOFF_GUARDRAIL,
    LOCAL_HANDOFF_TURN_REMINDER,
)
from .notifier_protocol import _render_protocol, _render_resume_context, _render_task_body

# #325: the standing plain-language rule for every message an agent sends a HUMAN. Orcha is
# built for non-engineers to run their own agent teams, so communication clarity is a product
# requirement, not polish. This rides the persona on EVERY wake (independent of whether a digest
# exists) because the digest only ever carried WHAT the agent knew — never HOW to talk to a
# person — so each wake the agent reverted to internal jargon a non-engineer can't parse.
HUMAN_COMMS_GUARDRAIL = (
    "## Talking to humans (plain-language guardrail — applies to every message you send a person)\n"
    "Orcha is run by non-engineers. Before any message leaves to a human, make it readable to them:\n"
    "- No bare UUIDs, invented shorthand labels (F1/F2, B3), or git SHAs unless the human used them "
    "first. Name what a thing IS in plain English; put an id in parentheses only if it's actually "
    "useful to them.\n"
    "- Lead with the answer, then the why. Keep it short — a sentence or two, not a structured "
    "report — unless they asked for depth.\n"
    "- Match how they talk to you. If you're unsure what they already understand, default to plain "
    "over precise."
)


# GH #91/#90: create-time rule for the one duplicate-work case left after the lane split. This is
# intentionally advisory/model-facing, not a backend gate: only the conversation embodiment can judge
# whether the new task overlaps state that exists solely in its live chat context.
_SELF_REFERENTIAL_HANDOFF_RULE = (
    "Self-referential handoffs: before creating a task assigned to yourself/current agent, check "
    "whether the task asks you to continue, finish, or act on work that overlaps this live context "
    "from the conversation. If yes, and only if yes, do the tiny resident-only slice that depends on "
    "that live context before task creation, then bake the result into the initial task description "
    "or protocol notes as already completed so the spawned worker inherits it and does not redo it. "
    "If a separate thread note is needed, create the task unassigned, post that note, then assign it; "
    "do not assign first. For unrelated tasks, or for work larger than a tiny context-only slice, do "
    "no work inline and use the normal fresh handoff path."
)


# GH #91/#90: the conversation-lane directive. A conversation embodiment (resident, or an ephemeral
# woken purely to talk) is the RESPONDER on the human's chat — but it must NOT silently swallow real
# work inline. The split is: quick asks (questions, brainstorm, status, a one-line lookup) get
# answered in the chat directly; anything that will take more than ~3-4 minutes or touch code / tests
# / PRs / a long investigation is HANDED OFF as an assigned task — the conversation worker CREATES the
# task, replies with a single short ack + the task link, and STOPS. The decision can be made up front
# (the ask is obviously long) OR mid-flight (a quick reply turns into a long investigation — hand off
# then, don't grind it out inline). This is the human-readable half of #91/#90; the embodiment-token
# gate is the server-side backstop that makes it structurally impossible for the conversation lane to
# own the work anyway. Appended to a conversation-lane persona so it frames every turn of the session.
CONVERSATION_LANE_DIRECTIVE = (
    "## You are the conversation responder (conversation lane)\n"
    "You are answering a human on their chat. Decide, for each ask, whether it is QUICK or REAL WORK:\n"
    "- QUICK (answer inline, right here): a question, brainstorm, status check, a small lookup, "
    "anything you can finish in a message or two in under ~3-4 minutes. Just reply.\n"
    "- REAL WORK (do NOT do it inline — hand it off): anything that will take more than ~3-4 minutes, "
    "or touch code, tests, PRs, or a long investigation. For these you CREATE an assigned task, then "
    "reply with ONE short line plus the task link and STOP. Do not start the work in this turn.\n"
    "When you create the handoff task, make it self-contained for the worker who will pick it up: a "
    "clear plain-English title; a description that preserves the human's ask and the context you have; "
    "a definition of done; and a protocol note telling the worker to POST its findings back to the "
    "task thread when done (that thread is how the human follows along). Then reply to the human with "
    "exactly one line, e.g. \"I'll handle this in the background — follow the task thread: <link>\".\n"
    "You may decide up front (the ask is obviously long) OR mid-flight — if a quick reply is turning "
    "into a long investigation, hand it off at that point rather than grinding it out inline. Only "
    "genuinely long work becomes a task; pure questions, brainstorming, and status stay inline.\n"
    f"{_SELF_REFERENTIAL_HANDOFF_RULE}\n"
    f"{LOCAL_HANDOFF_GUARDRAIL}"
)

# GH #91/#90: a short, STABLE per-turn reminder prepended to each warm conversation turn's content.
# The persona already carries the full CONVERSATION_LANE_DIRECTIVE on the cold boot; but a long-lived
# warm resident answers many turns off that one boot, so we re-assert the lane on every turn as a
# cache-cheap one-liner (identical text every turn → prompt-cache friendly, unlike the full block).
_CONVERSATION_TURN_REMINDER = (
    "[conversation lane] Answer directly if quick. If this needs real work (investigation, code, "
    "tests, PR) or more than ~3-4 min, create an assigned task with a protocol and reply with a "
    "one-line ack + the task link instead of doing it now. For a self-referential task that overlaps "
    "your live context, first do only the tiny context-only slice and put that result in the task's "
    "initial task description/notes before assignment, so the spawned worker does not redo it.\n"
    f"{LOCAL_HANDOFF_TURN_REMINDER}"
)


def _wrap_conversation_turn(content: str) -> str:
    """Prepend the stable conversation-lane reminder to a warm turn's content (GH #91/#90). Kept as
    ONE fixed sentence so it stays prompt-cache friendly across turns; the full directive rode in on
    the cold-boot persona."""
    return f"{_CONVERSATION_TURN_REMINDER}\n\n{content}"


def format_persona(persona: Optional[dict], digest: Optional[dict],
                   protocol: Optional[dict] = None, lane: str = "work",
                   render_resume: bool = False) -> Optional[str]:
    """Pure: assemble the --append-system-prompt text so a headless worker boots AS the
    agent. `persona` is GET /persona ({system_prompt,...}); `digest` is GET /digest
    ({digest: {...}|null}); `protocol` is GET /agents/{aid}/protocol ({protocol:{...}|null});
    any may be None. Returns the text, or None if nothing.

    This is what makes the spawned `claude -p` answer with the agent's judgment +
    reasoning continuity instead of as a generic Claude — persona from Epic A, the
    'where you left off' digest from Epic C.

    #325: when we're booting as a real agent (persona present) we always append the
    plain-language HUMAN_COMMS_GUARDRAIL, and — if the digest carried an `audience` slice
    — surface "Who you're talking to" AHEAD of the facts so the conversational register
    is set before the work state.

    #326 (A1): the task's standing protocol (RULES) rides AHEAD of / independent of the digest —
    it is human-authored and read fresh every wake, so an edit takes effect on the next wake. It
    lands after the guardrail and before the digest (rules frame the work before the recalled facts).

    GH #34 (scoped): sections are assembled STABLE-first so consecutive wakes of the same agent
    share the longest possible byte-identical prefix (a provider-side prompt cache hits on a
    stable prefix, not on the whole string). `persona` / `HUMAN_COMMS_GUARDRAIL` /
    `CONVERSATION_LANE_DIRECTIVE` never vary per-wake; `body_section` / `proto_section` vary only
    when the resolved task or its protocol changes (rare relative to wake frequency); the resume
    context and the digest vary on nearly every wake (a fresh self-wake wait-point, or the agent's
    own freshly-written memory) and so are rendered LAST, after everything more stable.
    """
    parts = []
    if persona and persona.get("system_prompt"):
        parts.append(persona["system_prompt"].strip())
    # #325: standing guardrail rides whenever we're actually booting as an agent.
    if parts:
        parts.append(HUMAN_COMMS_GUARDRAIL)
    # GH #91/#90: a conversation-lane embodiment (resident, or a talk-only ephemeral) also carries the
    # dispatch directive so the boot frames every turn as "answer quick asks inline; hand off real
    # work as an assigned task". Only appended for lane=='conversation' — a work embodiment keeps its
    # existing persona untouched.
    if parts and lane == "conversation":
        parts.append(CONVERSATION_LANE_DIRECTIVE)
    # GH #33: the resolved task's FULL body (title + description + DoD) rides ahead of the RULES so
    # the worker reads the complete spec — not the title alone — on every wake that resolves a task.
    body_section = _render_task_body(protocol)
    if body_section:
        parts.append(body_section)
    # #326 (A1): RULES (protocol) ahead of the digest — read fresh every wake, human-editable.
    proto_section = _render_protocol(protocol)
    if proto_section:
        parts.append(proto_section)
    # GH #34 (scoped): the resume context (a self-wake's saved wait-point, usually distinct every
    # time it fires) is MORE volatile than the protocol/task-body above it, so it renders AFTER
    # them — grouped with the digest at the tail instead of splitting the stable prefix in two.
    if render_resume:
        resume_section = _render_resume_context(protocol)
        if resume_section:
            parts.append(resume_section)
    d = (digest or {}).get("digest")
    if d:
        # #325: lead with WHO the agent is talking to (their register) so tone is framed
        # before the facts that follow.
        aud = d.get("audience")
        if aud:
            if not isinstance(aud, str):
                aud = json.dumps(aud, ensure_ascii=False)
            parts.append("## Who you're talking to (carry this register — it survives across "
                         "wakes, not just the facts):\n" + aud)
        lines = ["## Where you left off (your latest memory digest — you are RESUMING as "
                 "this agent, not starting fresh):",
                 "Memory-digest guard: treat these items as prior reasoning, not live truth. "
                 "Any claim about external state (GitHub PR/issue status, Orcha task/request "
                 "status, who owes what, review state) is a pointer to re-check the source of "
                 "truth before acting or deciding there is nothing to do."]
        for label, key in (("Current focus", "current_focus"), ("Decisions", "decisions"),
                           ("Learnings", "learnings"), ("Open threads", "open_threads")):
            v = d.get(key)
            if v:
                if not isinstance(v, str):
                    v = json.dumps(v, ensure_ascii=False)
                lines.append(f"- {label}: {v}")
        if len(lines) > 1:
            parts.append("\n".join(lines))
    return "\n\n".join(parts) if parts else None
