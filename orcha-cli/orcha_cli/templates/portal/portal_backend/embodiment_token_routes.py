"""Mint, revoke, and attribute work-lane embodiment capabilities."""

import secrets

from fastapi import HTTPException

from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_agent, valid_uuid
from portal_backend.schemas.wakes import EmbodimentTokenMint


@app.post("/api/agents/{aid}/embodiment-tokens", status_code=201)
def mint_embodiment_token(aid: str, body: EmbodimentTokenMint):
    """GH #91/#90: mint a run_token for a spawn about to happen. run_id/pid stay NULL until the run
    is created and binds the token (start_worker_run). The token_id returned IS the run_token — there
    is no separate id column; the daemon carries it as the handle for the bind + revoke calls.
    """
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (connection, cur):
        require_agent(cur, aid)
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
    cur.execute(
        """UPDATE worker_runs wr SET task_id=%s
             FROM embodiment_tokens et
            WHERE et.run_token=%s AND et.agent_id=%s AND et.lane='work'
              AND et.revoked_at IS NULL AND et.run_id IS NOT NULL
              AND wr.run_id=et.run_id AND wr.agent_id=et.agent_id
              AND wr.status='running' AND wr.task_id IS NULL
              AND EXISTS (SELECT 1 FROM tasks t
                           WHERE t.id=%s AND t.status='in_progress')
        RETURNING wr.run_id""",
        (task_id, token, aid, task_id),
    )
    pinned = cur.fetchone() is not None
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
