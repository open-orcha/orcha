"""Authentication checks shared by work-lane routes."""

from fastapi import HTTPException


def require_work_lane(cur, aid, token, request=None):
    """Require an active work-lane embodiment token for an agent.

    PS-39: a work-lane write (/done, /next, accept-task, self-wake) acts AS the AI —
    the audit trail records the agent. When ``request`` carries a trusted human login
    (a browser session holding a leaked/locally minted token), that human must also
    pass the PS-37 machine-lane gate (non-viewer member with manage_agents, or owner).
    Header-less agent/daemon calls are unaffected."""
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
    if request is not None:
        # Lazy import: identity_routes registers routes on the app at import time.
        from portal_backend.identity_routes import proxy_login, require_machine_lane_member

        if proxy_login(request):
            cur.execute("SELECT container_id FROM agents WHERE id=%s", (aid,))
            agent = cur.fetchone()
            if agent is not None:
                require_machine_lane_member(cur, request, str(agent["container_id"]))
