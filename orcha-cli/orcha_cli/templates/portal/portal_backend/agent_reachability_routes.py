"""Store and expose the transports available to wake an agent."""

from fastapi import HTTPException

from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_agent, valid_uuid
from portal_backend.schemas.agent_state import ReachabilityUpsert


@app.post("/api/agents/{aid}/reachability", status_code=200)
def set_reachability(aid: str, body: ReachabilityUpsert):
    """Record/refresh how the notifier daemon can wake this agent's Claude session.

    Partial upsert: a NULL field in the body leaves the stored value unchanged, so
    SessionStart can refresh the volatile tmux pane without disturbing a human's
    earlier wake_enabled=false opt-out. The row is created on first call with
    wake_enabled defaulting to true (wake is ON by default).
    """
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        require_agent(cur, aid)
        cur.execute(
            """INSERT INTO agent_reachability
                 (agent_id, wake_enabled, tmux_target, headless_cwd, headless_flags, updated_at)
               VALUES (%(aid)s, COALESCE(%(we)s, true), %(tt)s, %(hc)s, %(hf)s, now())
               ON CONFLICT (agent_id) DO UPDATE SET
                 wake_enabled   = COALESCE(%(we)s, agent_reachability.wake_enabled),
                 tmux_target    = COALESCE(%(tt)s, agent_reachability.tmux_target),
                 headless_cwd   = COALESCE(%(hc)s, agent_reachability.headless_cwd),
                 headless_flags = COALESCE(%(hf)s, agent_reachability.headless_flags),
                 updated_at     = now()
               RETURNING wake_enabled, tmux_target, headless_cwd, headless_flags, updated_at""",
            {
                "aid": aid,
                "we": body.wake_enabled,
                "tt": body.tmux_target,
                "hc": body.headless_cwd,
                "hf": body.headless_flags,
            },
        )
        row = cur.fetchone()
        conn.commit()
    return {"agent_id": aid, **row}


@app.get("/api/agents/{aid}/reachability")
def get_reachability(aid: str):
    """Read an agent's reachability. Returns wake-on defaults when no row exists yet."""
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (_, cur):
        require_agent(cur, aid)
        cur.execute(
            """SELECT wake_enabled, tmux_target, headless_cwd, headless_flags, updated_at
               FROM agent_reachability WHERE agent_id=%s""",
            (aid,),
        )
        row = cur.fetchone()
    if not row:
        return {
            "agent_id": aid,
            "wake_enabled": True,
            "tmux_target": None,
            "headless_cwd": None,
            "headless_flags": None,
            "updated_at": None,
            "recorded": False,
        }
    return {"agent_id": aid, "recorded": True, **row}
