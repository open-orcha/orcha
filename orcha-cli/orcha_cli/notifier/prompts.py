"""orcha_cli.notifier.prompts — pure prompt & persona text formatting.

String builders with no I/O and no network: the human-comms guardrail block,
attachment-text extraction, protocol rendering, persona formatting, the resident
sidecar-drain prompt, Codex prompt/resume shaping, and small history/content
helpers. Extracted verbatim from ``notifier.py`` (issue #29) and re-exported from
the package ``__init__`` so ``orcha_cli.notifier.<name>`` keeps working unchanged.
"""
from __future__ import annotations

import json
from typing import Optional

def _codex_prompt(prompt: str, system_prompt: Optional[str]) -> str:
    if not system_prompt:
        return prompt
    return f"{system_prompt.strip()}\n\n## Orcha Wake Instruction\n{prompt}"


def _extract_attachment_text(attachments, api_base: Optional[str] = None) -> dict:
    """#338 Codex image->text. Read upload/validation-time cached OCR text from attachment refs and
    return ``{attachment-id: text}`` for the feed renderer. ``api_base`` is kept for compatibility
    with the first-pass call sites/tests, but this helper deliberately performs NO network fetch
    and NO LLM call — cached text is the single source so task-thread and conversation wakes do not
    re-OCR per turn. FAIL-OPEN: malformed refs simply omit that id."""
    out: dict = {}
    for a in attachments or []:
        if not isinstance(a, dict):
            continue
        aid = a.get("id")
        text = (a.get("extracted_text") or "").strip()
        if text:
            out[aid] = text
    return out


def build_resident_sidecar_drain_prompt(alias: Optional[str], inbox: int,
                                        messages: Optional[list] = None) -> str:
    """#247 B3 (§5.2 warm-zone): the LEAN one-shot prompt for a warm-resident DRAIN SIDECAR. Pure.

    Distinct from build_wake_prompt (the ephemeral wake) in TWO deliberate ways:
      1. It is spawned in a SEPARATE session/cwd while the warm conversation lease is STILL HELD —
         so it can drain the queued NON-conversation backlog without the ISS-78 context-bleed (the
         removed in-session drain fed task reasoning into the next human turn) AND without yielding
         the lease (which the A2 idle-yield did, defeating the §5.1 warm-zone hold).
      2. It OMITS task auto-start. A warm conversation embodiment is already live for this agent;
         claiming + working a task here would be a SECOND concurrent embodiment, violating the
         Kedar-locked §3 ONE-EMBODIMENT contract. So: drain notifications/requests only, then EXIT.

    Gate P1b: `prompt`/`task_message`/`task_assigned` events carry content with NO inbox surface —
    surfacing the text is the ONLY delivery path (same as build_wake_prompt / wake_scan). So the
    caller threads the bounded directed-message batch (active-conversations' `inbox_messages`) in
    here and we quote it VERBATIM — otherwise the cursor-ack (P1a) would mark these delivered while
    silently dropping their content. The cursor is acked ONLY after this sidecar has run with them.
    """
    who = alias or "agent"
    n = f"{inbox} queued inbox event(s)" if inbox else "queued inbox events"
    # P1b: directed messages have no other inbox surface — quote each so the sidecar acts on it
    # specifically (mirrors build_wake_prompt's A3 surfacing) before its content is acked away.
    directed = ""
    msgs = [m for m in (messages or []) if m]
    if msgs:
        quoted = " ".join(f'(message {i + 1}) "{m}"' for i, m in enumerate(msgs))
        directed = (f" DIRECTED MESSAGE{'S' if len(msgs) > 1 else ''} FOR YOU — these carry content "
                    f"with no other inbox surface, so handle {'them' if len(msgs) > 1 else 'it'} "
                    f"specifically: {quoted}.")
    return (
        f"[orcha wake · drain sidecar] {who}: {n} piled up while your live conversation session is "
        f"held WARM.{directed} You are a ONE-SHOT DRAIN worker: clear the FULL non-conversation backlog, then "
        f"EXIT — do NOT enter the `/orcha-listen` long-poll watch loop (it never returns and piles "
        f"up stuck workers). Steps: (1) drain the ENTIRE inbox — handle ALL your open requests AND "
        f"ack ALL unacked events, repeating until your inbox is EMPTY (don't stop after the first "
        f"item; that strands the rest). (2) Do NOT claim or start a task via `/orcha-next` and do "
        f"NOT begin code work — a warm conversation session is already live for you, so starting "
        f"task work here would be a second concurrent embodiment. If answering a request would "
        f"require real task work, leave it for that task's own worker; answer what you can without "
        f"code and move on. (3) Once the inbox is empty, STOP and exit. Never self-certify — stop "
        f"at needs_verification and let a human verify."
    )


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


def _render_protocol(protocol: Optional[dict]) -> Optional[str]:
    """#326 (A1): render the per-task protocol (GET /agents/{aid}/protocol → {protocol:{...}})
    as the standing-RULES section. `protocol` is the response dict; its `protocol` key is the
    SPEC-4 JSONB {review_chain, handoff_to, autonomy, notes} (any subset). Returns None when no
    rules are set so an idle/cold wake carries no protocol section."""
    p = (protocol or {}).get("protocol")
    if not p:
        return None
    lines = ["## Standing protocol (your task's working agreement — the RULES, read FRESH every "
             "wake ahead of your notes; a human edits these and they apply on your very next wake):"]
    for label, key in (("Review chain", "review_chain"), ("Hand off to", "handoff_to"),
                       ("Autonomy", "autonomy"), ("Notes", "notes")):
        v = p.get(key)
        if v:
            if not isinstance(v, str):
                v = json.dumps(v, ensure_ascii=False)
            lines.append(f"- {label}: {v}")
    return "\n".join(lines) if len(lines) > 1 else None


def format_persona(persona: Optional[dict], digest: Optional[dict],
                   protocol: Optional[dict] = None) -> Optional[str]:
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
    """
    parts = []
    if persona and persona.get("system_prompt"):
        parts.append(persona["system_prompt"].strip())
    # #325: standing guardrail rides whenever we're actually booting as an agent.
    if parts:
        parts.append(HUMAN_COMMS_GUARDRAIL)
    # #326 (A1): RULES (protocol) ahead of the digest — read fresh every wake, human-editable.
    proto_section = _render_protocol(protocol)
    if proto_section:
        parts.append(proto_section)
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


def _simple_history(turns: list[dict]) -> str:
    rows = []
    for t in turns[-20:]:
        content = (t.get("content") or "").strip()
        atts = [a for a in (t.get("attachments") or []) if isinstance(a, dict)]
        if not content and not atts:
            continue
        who = "Human" if t.get("role") == "human" else "Agent"
        # #338: name any files shared on this turn (context marker; the open-instructions live with
        # the pending turn via _render_attachment_feed).
        marker = ""
        if atts:
            names = ", ".join(f"{a.get('name') or a.get('id')} ({a.get('kind') or 'file'})" for a in atts)
            marker = f"  [attached {len(atts)} file(s): {names}]"
        rows.append(f"{who}: {content}{marker}")
    return "## Conversation so far\n\n" + "\n\n".join(rows) if rows else ""


def _codex_resume_prompt(alias: str, pending_turns: list[dict]) -> str:
    """#286: the continuation prompt for a `codex exec resume <session_id>` worker.

    Unlike _conversation_worker_prompt, this injects NO thread history and NO persona/digest — the
    resumed on-disk rollout already holds all prior context, so re-injecting it would re-pay exactly
    the history tokens this feature exists to save. Carries ONLY the framing reminder + the new
    pending human turn(s). The cost win lives here: a multi-turn Codex review now pays history once
    (the cold turn-1 rollout) instead of every turn."""
    latest = "\n\n".join(
        f"Human turn seq {t.get('seq')}: {(t.get('content') or '').strip()}"
        for t in pending_turns
        if (t.get("content") or "").strip()
    )
    if not latest:
        latest = "(empty human message)"
    return (
        f"[orcha conversation] {alias or 'agent'}: continue replying to the human in Orcha's "
        "Conversation tab. This RESUMES your existing Codex session — the prior conversation is "
        "already in your context, so do NOT restate it. Make your final answer the chat reply "
        "appended to the conversation. Do not call `/orcha-listen` and do not post this reply "
        "through task/request endpoints unless the human explicitly asked for that side effect.\n\n"
        "## New Human Message(s)\n\n"
        f"{latest}\n"
    )


def _text_from_content(content) -> Optional[str]:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for blk in content:
            if not isinstance(blk, dict):
                continue
            if isinstance(blk.get("text"), str):
                parts.append(blk["text"])
            elif blk.get("type") in ("text", "output_text") and isinstance(blk.get("content"), str):
                parts.append(blk["content"])
        return "\n".join(p for p in parts if p).strip() or None
    return None
