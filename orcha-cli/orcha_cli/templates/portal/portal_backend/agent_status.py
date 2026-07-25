"""Record audit events, heartbeats, and derived agent activity status."""

import json

from portal_backend.database import db_cursor


def log_event(
    cur,
    container_id,
    actor_type,
    actor_id,
    entity_type,
    entity_id,
    event_type,
    detail=None,
):
    """Append a domain event to the audit log."""
    cur.execute(
        """INSERT INTO events
             (container_id, actor_type, actor_id, entity_type, entity_id, event_type, detail)
           VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb)""",
        (
            container_id,
            actor_type,
            actor_id,
            entity_type,
            entity_id,
            event_type,
            json.dumps(detail) if detail is not None else None,
        ),
    )


def bump_agent(cur, agent_id):
    """Record one active agent turn and refresh its heartbeat."""
    cur.execute(
        "UPDATE agents SET last_heartbeat_at = now(), turns_used = turns_used + 1 "
        "WHERE id = %s",
        (agent_id,),
    )


def touch_heartbeat(agent_id):
    """Refresh agent and work-lane heartbeats without counting a turn."""
    with db_cursor() as (conn, cur):
        cur.execute(
            "UPDATE agents SET last_heartbeat_at = now() WHERE id = %s",
            (agent_id,),
        )
        cur.execute(
            """INSERT INTO agent_wake_state (agent_id, work_last_heartbeat_at)
               VALUES (%s, now())
               ON CONFLICT (agent_id) DO UPDATE SET work_last_heartbeat_at = now()""",
            (agent_id,),
        )
        conn.commit()


def set_agent_status(cur, agent_id, status):
    """Set status directly for callers that cannot use derivation."""
    cur.execute("UPDATE agents SET status=%s WHERE id=%s", (status, agent_id))


def recompute_agent_status(cur, agent_id):
    """Derive an agent's status from retirement, requests, and task assignments."""
    cur.execute("SELECT status FROM agents WHERE id=%s", (agent_id,))
    row = cur.fetchone()
    if not row or row["status"] == "terminated":
        return
    cur.execute(
        "SELECT 1 FROM requests WHERE requester_id=%s AND status='open' LIMIT 1",
        (agent_id,),
    )
    if cur.fetchone():
        new_status = "awaiting_request"
    else:
        cur.execute(
            "SELECT 1 FROM agent_tasks "
            "WHERE agent_id=%s AND assignment_status "
            "IN ('assigned','accepted','working') LIMIT 1",
            (agent_id,),
        )
        new_status = "working" if cur.fetchone() else "idle"
    cur.execute(
        "UPDATE agents SET status=%s WHERE id=%s",
        (new_status, agent_id),
    )
