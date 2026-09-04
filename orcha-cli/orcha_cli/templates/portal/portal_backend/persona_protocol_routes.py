"""Serve the persona and task protocol injected into agent wake contexts."""

from fastapi import HTTPException

from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import (
    agent_participates_in_task,
    require_agent,
    valid_uuid,
)


def _fallback_model(model: str | None) -> str:
    return model or ""


def _fallback_runtime(_model: str | None) -> str:
    return "claude"


_resolve_model = _fallback_model
_resolve_model_runtime = _fallback_runtime


def configure_model_resolution(resolve_model, resolve_model_runtime) -> None:
    """Supply facade-owned model resolvers for compatibility monkeypatches."""
    global _resolve_model, _resolve_model_runtime
    _resolve_model = resolve_model
    _resolve_model_runtime = resolve_model_runtime


@app.get("/api/agents/{aid}/persona")
def get_persona(aid: str):
    """Epic A: an agent's defining system prompt + role, for the notifier to inject
    into a headless `claude -p` wake (`--append-system-prompt`) so the spawned worker
    boots AS that agent — its persona/judgment, not a generic Claude. Pairs with
    GET /digest (Epic C) which carries the reasoning continuity. Not in the snapshot
    on purpose (the prompt can be large; only the daemon needs it)."""
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (_, cur):
        cur.execute(
            "SELECT alias, role, kind, model, system_prompt FROM agents WHERE id=%s",
            (aid,),
        )
        row = cur.fetchone()
    if not row:
        raise HTTPException(404, f"agent {aid} not found")
    model = _resolve_model(row["model"]) if row["kind"] != "human" else None
    model_runtime = _resolve_model_runtime(model) if model else None
    return {
        "agent_id": aid,
        "alias": row["alias"],
        "role": row["role"],
        "kind": row["kind"],
        "model": model,
        "model_runtime": model_runtime,
        "system_prompt": row["system_prompt"],
    }


@app.get("/api/agents/{aid}/protocol")
def get_agent_protocol(aid: str, task_id: str | None = None):
    """#326 (A1): the RULES the waking agent must read FRESH every wake — the protocol of its
    currently in_progress task (SPEC-4 per-task working agreement: review_chain / handoff_to /
    autonomy / notes), human-authored and human-edit-only (PATCH /api/tasks/{tid}/protocol).

    The continuity fix: the protocol is the durable, human-editable rule surface (the queue is the
    ready task rows — see #326). Unlike the digest (compressed, agent-authored, carries WHAT it
    knew), this is read ahead of / independent of the digest so a human edit takes effect on the
    very next wake. The notifier (format_persona) injects it above the digest on every wake.

    GH #56 (Point 3, FLAG 2a part d): an explicit `task_id` hint — the originating_task_id the
    wake is consuming an answer ON BEHALF OF (notifier reads it off the request_answered event and
    threads it through) — keys the protocol load off the STORED LINK instead of the fragile "one
    in_progress task" guess. That guess serves the WRONG protocol to an agent juggling several
    in-progress tasks; the link removes that risk. The hint is honored only when the agent actually
    participates in that task (looser participant check), so a stale/foreign id can never leak a
    protocol; otherwise we fall back to the in_progress guess.

    GH #33: the resolved task's FULL body rides here too — title AND description AND
    definition_of_done — so EVERY wake that resolves a task (the request-answer originating-link
    path and the in-progress direct-assignment path both flow through this endpoint) surfaces the
    complete spec, not just the title. The body is returned whenever a task resolves, independent
    of whether a protocol is set; `protocol` is null when no working agreement exists.

    PR attribution (docs/agent-prs.md): the resolved task also carries `requested_by` — the
    triggering HUMAN's {alias, github_login, git_email} — so an agent opening a PR for this task
    can @mention them in the body and add a Co-authored-by trailer. Resolution: the task's
    created_by_agent_id when that row is a human (the trusted browser lane stamps it); otherwise
    (agent-created subtask, or a headerless-CLI NULL) fall back to the container's earliest live
    owner human, so attribution is never silently dropped. `requested_by` is null only when the
    container has no live human at all.

    Returns {task_id, title, description, definition_of_done, protocol, requested_by} for the
    resolved task, or {task_id: null, protocol: null} when none resolves — so a cold/idle wake
    carries neither a body nor a protocol section."""
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (_, cur):
        agent = require_agent(cur, aid)
        row = None
        if (
            task_id
            and valid_uuid(task_id)
            and agent_participates_in_task(
                cur, str(agent["container_id"]), aid, task_id
            )
        ):
            cur.execute(
                "SELECT id, title, description, definition_of_done, protocol, "
                "created_by_agent_id "
                "FROM tasks WHERE id=%s AND is_root=false",
                (task_id,),
            )
            row = cur.fetchone()
        if row is None:
            cur.execute(
                """SELECT t.id, t.title, t.description, t.definition_of_done, t.protocol,
                          t.created_by_agent_id
                   FROM tasks t
                   JOIN agent_tasks at ON at.task_id = t.id
                   WHERE at.agent_id=%s AND at.assignment_status IN ('assigned','accepted','working')
                     AND t.status='in_progress' AND t.is_root = false
                   ORDER BY t.started_at DESC NULLS LAST, t.created_at DESC
                   LIMIT 1""",
                (aid,),
            )
            row = cur.fetchone()
        requested_by = None
        if row is not None:
            # Triggering human: the stamped creator when human, else the earliest
            # live owner — attribution must degrade gracefully, never vanish.
            cur.execute(
                """SELECT alias, github_login, git_email FROM agents
                    WHERE id=%s AND kind='human' AND terminated_at IS NULL""",
                (row["created_by_agent_id"],),
            )
            requested_by = cur.fetchone()
            if requested_by is None:
                cur.execute(
                    """SELECT alias, github_login, git_email FROM agents
                        WHERE container_id=%s AND kind='human'
                          AND member_role='owner' AND terminated_at IS NULL
                        ORDER BY created_at ASC LIMIT 1""",
                    (str(agent["container_id"]),),
                )
                requested_by = cur.fetchone()
        resume_context = None
        if row is not None:
            cur.execute(
                """SELECT sw.context
                   FROM agent_self_wake sw
                   JOIN tasks t ON t.id = sw.task_id
                   JOIN agent_tasks at ON at.task_id = sw.task_id AND at.agent_id = sw.agent_id
                   WHERE sw.agent_id=%s AND sw.task_id=%s
                     AND sw.resume_at <= now()
                     AND t.status = 'in_progress'
                     AND at.assignment_status IN ('assigned','accepted','working')
                   LIMIT 1""",
                (aid, row["id"]),
            )
            self_wake = cur.fetchone()
            if self_wake:
                resume_context = self_wake["context"]
    if not row:
        return {"task_id": None, "protocol": None}
    result = {
        "task_id": str(row["id"]),
        "title": row["title"],
        "description": row["description"],
        "definition_of_done": row["definition_of_done"],
        "protocol": row["protocol"] or None,
        "requested_by": dict(requested_by) if requested_by else None,
    }
    if resume_context:
        result["resume_context"] = resume_context
    return result
