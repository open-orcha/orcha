"""Authentication checks shared by work-lane routes."""

from fastapi import HTTPException


def require_work_lane(cur, aid, token):
    """Require an active work-lane embodiment token for an agent."""
    if not token:
        raise HTTPException(403, "work-lane token required")
    cur.execute(
        "SELECT lane FROM embodiment_tokens "
        "WHERE run_token=%s AND agent_id=%s AND revoked_at IS NULL",
        (token, aid),
    )
    row = cur.fetchone()
    if row is None or row["lane"] != "work":
        raise HTTPException(
            403,
            "conversation lane cannot claim/work a task; create/assign a task and stop",
        )
