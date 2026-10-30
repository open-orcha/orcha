"""Mint, revoke, and attribute work-lane embodiment capabilities."""

import secrets

from fastapi import HTTPException, Request

from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_agent, valid_uuid
from portal_backend.identity_routes import require_machine_lane_member
from portal_backend.schemas.wakes import EmbodimentTokenMint


@app.post("/api/agents/{aid}/embodiment-tokens", status_code=201)
def mint_embodiment_token(aid: str, body: EmbodimentTokenMint, request: Request):
    """GH #91/#90: mint a run_token for a spawn about to happen. run_id/pid stay NULL until the run
    is created and binds the token (start_worker_run). The token_id returned IS the run_token — there
    is no separate id column; the daemon carries it as the handle for the bind + revoke calls.
    """
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (connection, cur):
        agent = require_agent(cur, aid)
        require_machine_lane_member(cur, request, str(agent["container_id"]))  # PS-07
        token = secrets.token_urlsafe(32)
        cur.execute(
            """INSERT INTO embodiment_tokens (run_token, agent_id, lane, kind)
               VALUES (%s, %s, %s, %s)""",
            (token, aid, body.lane, body.kind),
        )
        connection.commit()
    return {"run_token": token, "token_id": token}


@app.post("/api/embodiment-tokens/{token}/revoke", status_code=200)
def revoke_embodiment_token(token: str):
    """GH #91/#90: revoke a token (idempotent). A daemon revokes its own token when it retires the
    embodiment; the server also revokes on terminal transitions. Re-revoking a revoked/unknown token
    is a no-op 200 with revoked=false.
    """
    with db_cursor() as (connection, cur):
        cur.execute("SELECT run_id FROM embodiment_tokens WHERE run_token=%s", (token,))
        binding = cur.fetchone()
        if binding and binding["run_id"]:
            from portal_backend.workflow_evidence_service import _lock_context
            _lock_context(cur, binding["run_id"])
        cur.execute(
            """UPDATE embodiment_tokens SET revoked_at=now()
               WHERE run_token=%s AND revoked_at IS NULL""",
            (token,),
        )
        revoked = cur.rowcount > 0
        connection.commit()
    return {"revoked": bool(revoked)}


def attribute_token_run_to_task(cur, aid, token, task_id) -> bool:
    """Pin a live run when empty and record its many-to-many task membership."""
    if not token or not task_id:
        return False
    # Acceptance can commit before the notifier registers the worker. Save the
    # task's dispatch boundary now: registration (or another accept) may never
    # happen, and the next successful wake claim replaces the lane's clock.
    cur.execute(
        """INSERT INTO managed_task_dispatches (task_id,agent_id,started_at)
           SELECT t.id, et.agent_id, COALESCE(s.work_dispatch_started_at, now())
             FROM embodiment_tokens et
             JOIN tasks t ON t.id=%s AND t.status='in_progress'
             LEFT JOIN agent_wake_state s ON s.agent_id=et.agent_id
            WHERE et.run_token=%s AND et.agent_id=%s AND et.lane='work'
              AND et.revoked_at IS NULL AND et.run_id IS NULL
              AND et.kind='headless'
           ON CONFLICT DO NOTHING""",
        (task_id, token, aid),
    )
    cur.execute(
        # No UPDATE ... FROM: SQLite's RETURNING can't name the alias, and Postgres would find
        # a bare run_id ambiguous with the joined token row.
        """UPDATE worker_runs AS wr SET task_id=%s
            WHERE EXISTS (SELECT 1 FROM embodiment_tokens et
                           WHERE et.run_token=%s AND et.agent_id=%s AND et.lane='work'
                             AND et.revoked_at IS NULL AND et.run_id IS NOT NULL
                             AND et.run_id=wr.run_id AND et.agent_id=wr.agent_id)
              AND wr.status='running' AND wr.task_id IS NULL
              AND EXISTS (SELECT 1 FROM tasks t
                           WHERE t.id=%s AND t.status='in_progress')
        RETURNING run_id, started_at, dispatch_started_at, lane, wake_kind""",
        (task_id, token, aid, task_id),
    )
    pinned_run = cur.fetchone()
    pinned = pinned_run is not None
    if pinned_run and pinned_run['lane'] == 'work' and pinned_run['wake_kind'] in {'ephemeral', 'sandbox'}:
        from portal_backend.managed_message_window import ensure_message_window
        # Seed on attribution, not first poll: a crash immediately after binding
        # must leave the original startup boundary for the replacement.
        ensure_message_window(cur, task_id, aid, pinned_run['run_id'],
                              pinned_run['dispatch_started_at'] or pinned_run['started_at'])
    cur.execute(
        """INSERT INTO worker_run_tasks (run_id, task_id)
           SELECT wr.run_id, %s
             FROM worker_runs wr
             JOIN embodiment_tokens et ON wr.run_id = et.run_id
            WHERE et.run_token=%s AND et.agent_id=%s AND et.lane='work'
              AND et.revoked_at IS NULL AND et.run_id IS NOT NULL
              AND wr.agent_id=et.agent_id AND wr.status='running'
              AND EXISTS (SELECT 1 FROM tasks t
                           WHERE t.id=%s AND t.status='in_progress')
           ON CONFLICT DO NOTHING""",
        (task_id, token, aid, task_id),
    )
    return pinned
