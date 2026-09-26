"""Render task specifications, protocols, and self-wake resume context."""

from __future__ import annotations

import json
from typing import Optional

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
    # GH #56 (Point 2): review_chain / handoff_to / notes are BINDING — render them as imperatives
    # the agent must ACT on (route the review per the chain; hand the finished work to the named
    # agent), not as passive labels it merely reads. `autonomy` stays ADVISORY: the real completion
    # gate is your EFFECTIVE autonomy level (container setting, or your per-agent override), so we
    # mark it as such to kill the ambiguity (an unvalidated free-text string must never read as a
    # binding gate). Genuine server-side enforcement (e.g. blocking /orcha-done until the chain is
    # satisfied) is out of scope for this pass and deliberately not implied.
    for label, key in (
            ("Review chain (BINDING — route reviews/sign-off through exactly this chain, in order)",
             "review_chain"),
            ("Hand off to (BINDING — when your part is materially done, hand the work to this agent "
             "via an Orcha request)", "handoff_to"),
            ("Autonomy (ADVISORY ONLY — the real gate is your effective autonomy level (container "
             "setting, or your per-agent override); never self-certify, stop at needs_verification "
             "for a human)", "autonomy"),
            ("Notes (BINDING instructions)", "notes")):
        v = p.get(key)
        if v:
            if not isinstance(v, str):
                v = json.dumps(v, ensure_ascii=False)
            lines.append(f"- {label}: {v}")
    return "\n".join(lines) if len(lines) > 1 else None


def _render_task_body(protocol: Optional[dict]) -> Optional[str]:
    """GH #33: render the resolved task's FULL body — title + description + definition_of_done —
    as a wake section so a woken worker acts on the complete spec, not the title alone. `protocol`
    is the GET /agents/{aid}/protocol response, which now carries the body fields alongside the
    rules (the endpoint resolves the wake's task via the originating-link or in-progress guess).

    Covers EVERY wake that resolves a task: the request-answer (originating-task) path and the
    in-progress direct-assignment path both flow through that endpoint. Returns None when no task
    resolved (cold/idle wake) or the task carries no description/DoD beyond a title."""
    p = protocol or {}
    if not p.get("task_id"):
        return None
    lines = ["## Your task (read this FULL body FRESH every wake — act on the complete spec, NOT "
             "the title alone; acceptance criteria live in the description and definition of done, "
             "and a loop / multi-step DoD must be honored, not given a shallow one-pass):"]
    for label, key in (("Title", "title"), ("Description", "description"),
                       ("Definition of done", "definition_of_done")):
        v = p.get(key)
        if v:
            if not isinstance(v, str):
                v = json.dumps(v, ensure_ascii=False)
            lines.append(f"- {label}: {v}")
    # PR attribution (docs/agent-prs.md): surface WHO triggered this task so a PR the
    # worker opens can @mention them and carry a Co-authored-by trailer (the exact
    # formats live in the repository-workflow rules section of the system prompt).
    req = p.get("requested_by") or {}
    if req.get("alias") or req.get("github_login"):
        who = req.get("alias") or req.get("github_login")
        if req.get("github_login"):
            who += f" (@{req['github_login']})"
        if req.get("git_email"):
            who += f" <{req['git_email']}>"
        lines.append(f"- Requested by: {who} — attribute any PR/commit for this task "
                     "to them per the repository workflow rules.")
    # Title alone (no description/DoD) adds nothing over what the worker already knows — skip.
    return "\n".join(lines) if len(lines) > 2 else None


def _render_resume_context(protocol: Optional[dict]) -> Optional[str]:
    """GH #122: render the worker's saved wait-point for a self-scheduled wake."""
    p = protocol or {}
    context = p.get("resume_context")
    if not context:
        return None
    if not isinstance(context, str):
        context = json.dumps(context, ensure_ascii=False)
    context = context.strip()
    if not context:
        return None
    return ("## Resuming — you scheduled this wake:\n"
            f"You were waiting on: {context}\n"
            "Check that first. If it is still not ready, schedule another self-wake and exit.")
