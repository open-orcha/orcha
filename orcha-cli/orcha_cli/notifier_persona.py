"""Assemble stable persona, human-communication, task, and digest prompt sections."""

from __future__ import annotations

import json
import pathlib
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


# Project-runtime provisioning epic: once a stack hosts SEVERAL humans (owner + invited
# members steering the same agents from the portal), agents need one standing rule-set for
# conflicting human direction. Rides EVERY wake that boots as a real agent (right after the
# comms guardrail — both are stable, so the GH#34 cacheable prefix is preserved): precedence
# is structural (owner > member, DoD > chat), overrides are always called out loud, and a
# genuine unresolved contradiction escalates via the existing request primitive instead of
# the agent quietly picking a side.
MULTI_HUMAN_STEERING = (
    "## Multi-human steering (when more than one person directs you)\n"
    "- Precedence: the project owner's instructions outrank a member's; the task's "
    "definition-of-done outranks chat steering. When you follow one instruction over another "
    "given earlier, say so explicitly (\"following X's direction over Y's earlier note\") — "
    "never silently pick a side.\n"
    "- If two humans genuinely contradict each other and no owner has resolved it, do NOT "
    "choose: file an Orcha request addressed to the owner naming both instructions, and pause "
    "that thread of work until it is answered.\n"
    "- Chat guidance is advisory. Anything that changes what \"done\" means must land in the "
    "task's definition-of-done via the human flow before you treat it as the goal."
)


# Agent→PR (docs/agent-prs.md): the branch→PR contract for workspaces that carry a cloned
# repo + bot credentials. Static text; whether it rides at all is gated per-workspace by
# _repo_credentials_present() — the cheapest accurate signal is the workspace itself
# (a git checkout plus the rotating .orcha/github-token the box timers maintain). Rides
# right after MULTI_HUMAN_STEERING so it stays inside the GH#34 stable cacheable prefix
# (stable per-workspace: the gate flips at most once, when a repo is first connected).
REPO_WORKFLOW_GUIDANCE = (
    "## Working with the repository (branch → PR; merge is always human)\n"
    "This workspace is a clone of the project's GitHub repository with bot credentials "
    "already wired into git and the `gh` CLI — you act as the Orcha app bot, never a "
    "human account. Do not change git user.name/user.email.\n"
    "- NEVER commit to the default branch (main/master). Start every piece of work on "
    "its own branch: `git checkout -b orcha/<task-slug>`.\n"
    "- Commit your work there, then publish it: `git push -u origin <branch>`.\n"
    "- Open a pull request: `gh pr create --title \"...\" --body \"...\"`. End the body "
    "with a reference to your Orcha work log (the task/thread the work belongs to) and "
    "a note that a human reviews it.\n"
    "- ATTRIBUTE the triggering human (your \"Your task\" section carries a "
    "\"Requested by\" line with their handle/email; if missing, fetch "
    "`GET /api/agents/<your-agent-id>/protocol` and read `requested_by`):\n"
    "  1. The PR body's FIRST line must be this blockquote, then a blank line: "
    "`> 🧑 Triggered by @<github-login> via Orcha task <task-id>` — use the "
    "real @handle so GitHub links and notifies them. If they have no recorded "
    "github-login, use their display name instead of the @mention: "
    "`> 🧑 Triggered by <name> via Orcha task <task-id>`. Never omit this "
    "line, and always include the task id.\n"
    "  2. Your final commit must end with a `Co-authored-by: <name> <email>` trailer "
    "(blank line before trailers). Use their recorded git email; if absent, use "
    "`<github-login>@users.noreply.github.com`; if they have neither login nor email, "
    "skip the trailer but keep the PR-body line.\n"
    "- PRs are proposals. Merging is ALWAYS a human decision — never merge, never "
    "self-approve, and never push to the default branch to \"finish\" a task."
)


def _repo_credentials_present(workdir: Optional[str] = None) -> bool:
    """Cheapest accurate gate for REPO_WORKFLOW_GUIDANCE: the workspace root carries BOTH
    a git checkout AND the rotating installation-token file the box timers maintain
    (deploy/github-token-refresh.sh). Token-without-repo (an unbound provisioned
    workspace) or repo-without-token (a plain local project) → no repo-workflow block.
    Defaults to cwd — the notifier daemon always runs from the workspace root."""
    ws = pathlib.Path(workdir) if workdir else pathlib.Path.cwd()
    try:
        return (ws / ".git").exists() and (ws / ".orcha" / "github-token").is_file()
    except OSError:
        return False


# Remote-portal awareness (field bug: a "local" workspace whose orcha.json pointed at a
# cloud portal created tasks THERE while its human believed everything was local). The
# notice is GENERIC — any non-loopback api_base host counts as remote and the text echoes
# whatever host is configured (a BYOC IP, a self-hosted domain, or a managed cloud) — no
# deployment's domain is ever special-cased. Stable per-workspace (api_base is fixed at
# daemon boot), so it rides inside the GH#34 cacheable prefix.
_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1", "0.0.0.0", "[::1]"}


def _portal_host(api_base: Optional[str]) -> Optional[str]:
    """Hostname (no port/scheme) of the portal api_base, or None if unparseable."""
    if not api_base:
        return None
    from urllib.parse import urlsplit
    try:
        host = urlsplit(api_base).hostname
    except ValueError:
        return None
    return host or None


def remote_portal_notice(api_base: Optional[str]) -> Optional[str]:
    """A persona section for workspaces whose portal is NOT on this machine.

    Loopback (localhost/127.x/::1) → None: a local portal needs no notice. Anything
    else — LAN IP, BYOC domain, managed cloud — gets named plainly so the agent
    tells its human where created work actually lives."""
    host = _portal_host(api_base)
    if host is None:
        return None
    if host in _LOOPBACK_HOSTS or host.startswith("127."):
        return None
    return (
        "## Remote portal notice\n"
        f"This workspace's Orcha portal is REMOTE: {host}. Every task, message, and "
        "conversation you create lands on THAT deployment — not on a local instance. "
        "When you create or hand off a task, say plainly in your reply that it lives "
        f"on {host}, so a human who expects local work is never surprised."
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
    "reply with ONE short line plus the task reference and STOP. Do not start the work in this turn.\n"
    "When you create the handoff task, make it self-contained for the worker who will pick it up: a "
    "clear plain-English title; a description that preserves the human's ask and the context you have; "
    "a definition of done; and a protocol note telling the worker to POST its findings back to the "
    "task thread when done (that thread is how the human follows along). Then reply to the human with "
    "exactly one line, e.g. \"I'll handle this in the background — follow the task thread: <task-id>\".\n"
    "How to reference a task in chat: write its plain id (the full UUID, or its first 8 characters) — "
    "the portal renders any real task id as a clickable link on whatever host the human is browsing. "
    "NEVER compose an absolute portal URL (no https://<domain>/tasks?...): this deployment may be "
    "localhost, self-hosted, or cloud, and a domain remembered from your context can send the human "
    "to a DIFFERENT deployment entirely (field bug: a local agent linked a cloud host).\n"
    "If you CANNOT create the task — the Orcha task API/skill is unavailable, errors, or is missing "
    "from your toolset — SAY SO PLAINLY and stop. Never substitute: not a background agent thread "
    "described as a task, and never ANOTHER Orcha deployment you can reach some other way (an open "
    "browser tab, a remembered URL) — a portal showing familiar project or user names is NOT proof "
    "it is this workspace's portal (field bug: an agent filed work on a different deployment via "
    "the human's signed-in browser tab).\n"
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
                   render_resume: bool = False,
                   workdir: Optional[str] = None,
                   api_base: Optional[str] = None) -> Optional[str]:
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
    `REPO_WORKFLOW_GUIDANCE` (workspace-gated, stable per-workspace) /
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
        # Multi-human conflict rules ride every agent boot too (owner > member,
        # DoD > chat, explicit overrides, escalate unresolved contradictions).
        parts.append(MULTI_HUMAN_STEERING)
        # Agent→PR: the branch→PR contract rides only when the workspace actually
        # carries a repo + bot credentials (`workdir` override for tests; default
        # cwd — the daemon runs from the workspace root). Stable per-workspace, so
        # it stays inside the GH#34 cacheable prefix.
        if _repo_credentials_present(workdir):
            parts.append(REPO_WORKFLOW_GUIDANCE)
        # Remote-portal awareness: stable per-workspace (api_base fixed at daemon
        # boot) so it stays inside the GH#34 cacheable prefix. Generic — echoes
        # whatever non-loopback host is configured, never a special-cased domain.
        portal_notice = remote_portal_notice(api_base)
        if portal_notice:
            parts.append(portal_notice)
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
