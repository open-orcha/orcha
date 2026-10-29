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
    # Goal ancestry: WHY this task exists — project objective -> parent task(s) -> this task.
    why = _render_goal_chain(p.get("goal_chain"))
    if why:
        lines.append(why)
    workflow = _render_workflow(p.get("workflow"))
    if workflow:
        lines.append(workflow)
    # Title alone (no description/DoD) adds nothing over what the worker already knows — skip.
    return "\n".join(lines) if len(lines) > 2 else None


def _clip(text: str, limit: int) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _render_goal_chain(chain) -> Optional[str]:
    """Goal ancestry: render the server's goal_chain (objective -> parent(s) -> this task,
    top-down) as ONE line so the worker knows the WHY behind its task and can judge scope
    against the parent and the project objective. Pure; None when there is nothing beyond
    the task itself (no stated objective and no parent)."""
    if not isinstance(chain, list) or not chain:
        return None
    hops = []
    informative = False
    for node in chain:
        if not isinstance(node, dict):
            continue
        kind = node.get("kind")
        if kind == "objective":
            if node.get("text"):
                informative = True
                hops.append(f'Project objective "{_clip(node["text"], 280)}"'
                            + (f' ({_clip(node["title"], 60)})' if node.get("title") else ""))
            elif node.get("title"):
                hops.append(f'Project "{_clip(node["title"], 60)}" (no objective set)')
        elif kind == "parent":
            informative = True
            status = f' [{node["status"]}]' if node.get("status") else ""
            hops.append(f'Parent task "{_clip(node.get("title") or "", 120)}"{status} '
                        f'(id {node.get("id")})')
        elif kind == "task":
            hops.append(f'This task "{_clip(node.get("title") or "", 120)}"')
    if not informative:
        return None
    return ("- Why this task exists (goal chain, project objective → parent task(s) → this "
            "task — keep your work in service of it): " + " → ".join(hops))


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


def _round_lines(context):
    """Flexible workflows: the step's outcomes and, in a repeat group, this round's feedback."""
    if not context:
        return []
    lines = []
    names = [o["name"] for o in context.get("outcomes") or []]
    if names:
        lines.append("Before you mark this step done, report exactly one outcome: "
                     + ", ".join(f"'{n}'" for n in names)
                     + ". The outcome decides what happens next. To report it, first GET "
                     f"/api/tasks/{context.get('task_id')}/round-context for workflow_revision and "
                     f"work_revision, then POST /api/tasks/{context.get('task_id')}/outcome with "
                     "outcome, findings (a list of {\"text\": ...}), note, "
                     "expected_revision = workflow_revision, expected_work_revision = work_revision "
                     "and idempotency_key = a new unique string. If it is refused with "
                     "revision_conflict, read round-context again and retry with a new key.")
    group = context.get("group")
    if group:
        lines.append(f"This step is in the repeat group '{group['name']}', round {group['round']} "
                     f"of at most {group['max_rounds']}. The loop ends when "
                     f"{repr(group['review_step']) if group.get('review_step') else 'its review step'} "
                     f"reports '{group['exit_outcome']}'.")
        this = group.get("this_round") or {}
        if group["round"] > 1:
            lines.append(f"This round was started because the outcome was "
                         f"'{this.get('outcome') or 'an owner decision'}'. Address this feedback:")
            for f in this.get("findings") or []:
                lines.append(f"   - {f['text']}")
            if this.get("note"):
                lines.append(f"   Reviewer note: {_clip(this['note'], 1500)}")
            if this.get("owner_note"):
                lines.append(f"   Owner note: {_clip(this['owner_note'], 1500)}")
        if group.get("can_review_handoff"):
            lines.append(
                "This step directly feeds the group's review step. If its exact draft needs "
                "agent review before human verification, POST the explicit review-handoff from "
                f"this worker with review_task_id '{group['review_task_id']}', then exit for "
                "runner-confirmed hand-over. That captured handoff satisfies only this direct "
                "prerequisite for the current round; it does not accept either task."
            )
        elif group.get("is_review_step"):
            lines.append(
                "When this turn reviews a captured group handoff, first report the configured "
                "loop outcome and findings using the outcome API above, then POST the matching "
                "review verdict and exit. 'changes_requested' uses a send-back, owner question, "
                f"or stop outcome; 'clean' reports the exit outcome '{group['exit_outcome']}'."
            )
        for r in group.get("earlier_rounds") or []:
            texts = "; ".join(f["text"] for f in r.get("findings") or []) or "no findings"
            lines.append(f"   Round {r['round']} ended ({r['ended'] or 'open'}): {_clip(texts, 600)}")
    return lines


def _render_workflow(workflow) -> Optional[str]:
    """The server scopes this list to the task, not the waking agent."""
    if not workflow:
        return None
    tasks = workflow["tasks"]
    lines = ["## Your workflow (read fresh; this is your task's own workflow):",
             f"- Workflow: {workflow['title']} (id {workflow['id']})",
             f"- Goal: {workflow['goal']}",
             f"- You are on step {workflow['step_number']} of {len(tasks)}.",
             "References to Step N mean the numbered list below. Do not infer steps from "
             "other workflows, recent task lists, or memory. Statuses are context, not "
             "permission to bypass dependencies, approval, or stop rules."]
    for number, task in enumerate(tasks, 1):
        owners = ", ".join(task["assignees"]) or "unassigned"
        lines.append(f"{number}. {task['title']} [{task['status']}] — {owners} (task {task['id']})")
        result = task.get("result")
        if result:
            if isinstance(result, dict):
                result = result.get("result", result)
            if not isinstance(result, str):
                result = json.dumps(result, ensure_ascii=False)
            lines.append(f"   Result: {_clip(result, 1500)}")
    lines.extend(_round_lines(workflow.get("round_context")))
    group = (workflow.get("round_context") or {}).get("group")
    if not group:
        lines.append("If unfinished work needs another workflow task to review it, use the explicit "
                     "review-handoff API from your current worker, then exit for runner-confirmed "
                     "handoff. Read docs/workflow-review-handoffs.md. Never mark unfinished work done "
                     "to release the serial turn; CLEAN still requires human verification.")
    elif group.get("can_review_handoff") or group.get("is_review_step"):
        lines.append("Read docs/workflow-review-handoffs.md for the exact handoff sequence. Never "
                     "mark unfinished work done to release the serial turn; final verification is "
                     "still human.")
    return "\n".join(lines)
