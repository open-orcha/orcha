"""Validate identifiers, actors, and domain records for API handlers."""

import uuid

from fastapi import HTTPException


def valid_uuid(value: str) -> bool:
    """Return whether a value is a UUID string."""
    try:
        uuid.UUID(value)
        return True
    except (ValueError, TypeError):
        return False


def require_container(cur, container_id):
    """Return a container row or raise a public not-found response."""
    cur.execute(
        "SELECT id, status FROM containers WHERE id=%s",
        (container_id,),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, f"container {container_id} not found")
    return row


def require_agent(cur, agent_id):
    """Return the common agent fields needed by mutation handlers."""
    cur.execute(
        "SELECT id, container_id, alias, turn_budget, turns_used "
        "FROM agents WHERE id=%s",
        (agent_id,),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, f"agent {agent_id} not found")
    return row


def reject_if_retired(cur, agent_id):
    """Reject work-creating actions performed by a retired agent."""
    if not agent_id or not valid_uuid(agent_id):
        return
    cur.execute(
        "SELECT terminated_at FROM agents WHERE id=%s",
        (agent_id,),
    )
    row = cur.fetchone()
    if row and row["terminated_at"] is not None:
        raise HTTPException(
            409,
            "agent is retired and cannot perform this action",
        )


def require_task(cur, task_id):
    """Return a task row or raise a public not-found response."""
    cur.execute(
        "SELECT id, container_id, title, status, is_root FROM tasks WHERE id=%s",
        (task_id,),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, f"task {task_id} not found")
    return row


def agent_participates_in_task(cur, container_id, agent_id, task_id) -> bool:
    """Check whether an agent created or is assigned to a task."""
    cur.execute(
        """SELECT 1 FROM tasks t
           WHERE t.id=%s AND t.container_id=%s
             AND (t.created_by_agent_id=%s
                  OR EXISTS (SELECT 1 FROM agent_tasks at
                             WHERE at.task_id=t.id AND at.agent_id=%s))
           LIMIT 1""",
        (task_id, container_id, agent_id, agent_id),
    )
    return cur.fetchone() is not None


def resolve_alias(cur, container_id, alias):
    """Resolve a container-local agent alias."""
    cur.execute(
        "SELECT id FROM agents WHERE container_id=%s AND alias=%s",
        (container_id, alias),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(
            404,
            f"no agent aliased '{alias}' in container {container_id}",
        )
    return str(row["id"])


def pick_human(cur, container_id):
    """Select the most recently active non-retired human agent."""
    cur.execute(
        """SELECT id FROM agents
           WHERE container_id=%s AND kind='human' AND terminated_at IS NULL
           ORDER BY COALESCE(last_heartbeat_at, created_at) DESC,
                    created_at ASC
           LIMIT 1""",
        (container_id,),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(
            409,
            "no human agent is registered in this container. "
            "Run `orcha init --as <name>` (if this is a fresh container) "
            "or `/orcha-register-human <name>` to add one.",
        )
    return str(row["id"])


def require_kind(cur, agent_id, allowed):
    """Require the named agent to have one of the allowed kinds."""
    if not agent_id or not valid_uuid(agent_id):
        raise HTTPException(
            400,
            "actor_agent_id is required and must be a valid UUID",
        )
    cur.execute("SELECT kind FROM agents WHERE id=%s", (agent_id,))
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, f"agent {agent_id} not found")
    if row["kind"] not in allowed:
        raise HTTPException(
            403,
            f"this action requires kind in {allowed}; "
            f"agent {agent_id} is kind='{row['kind']}'",
        )
    return row


def require_container_active(cur, container_id, actor_agent_id=None):
    """Block AI mutations while a container is not active."""
    row = require_container(cur, container_id)
    status = row["status"]
    if status == "active":
        return row
    if actor_agent_id and valid_uuid(actor_agent_id):
        cur.execute(
            "SELECT kind FROM agents WHERE id=%s",
            (actor_agent_id,),
        )
        agent = cur.fetchone()
        if agent and agent["kind"] == "ai":
            raise HTTPException(
                409,
                f"container is '{status}' — agent actions are blocked "
                "until it is resumed",
            )
    return row
