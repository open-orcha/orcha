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


def find_actionable_human(cur, container_id, exclude_id=None, also_exclude=None, grant=None):
    """The human an agent's "ask the human" request should route to, or None.

    Routing must land on someone who can ACT on the request (answer / reject /
    decide), not merely see it:

    * viewers are excluded outright — the viewer role is read-only (mig 039;
      identity_routes._forbid_viewer_write refuses every write), so a request
      routed to one could never be answered;
    * under proxy trust (ORCHA_TRUST_PROXY_USER=1), humans carrying a
      github_login (members who can sign in and act through the portal) rank
      ahead of login-less rows, which are reachable only via the headerless
      CLI / team-token lane. A login-less human is a last resort, never a
      preference. In a still-unmapped bootstrap container every human is
      login-less, so the ordering degrades to plain recency;
    * PS-33: under proxy trust a member who has NEVER signed in (no heartbeat — a
      pending invite) ranks after everyone who has, so a fresh invite can't outrank
      the people actually using the project just by being newer;
    * within a tier, the most recently active human wins (freshest heartbeat,
      then earliest-created) — the pre-existing behavior.

    `exclude_id` (parity r2) drops one human from the pool — escalate passes the
    requester so a human's own escalation never routes straight back to them.
    `also_exclude` drops a second one (a role demotion re-routing an ask away from
    the demoted member prefers anyone but the ask's own requester).

    `grant` (RT-19): only humans who hold this grant qualify (owners hold every
    grant) — e.g. an agent suggestion must land on someone who can approve it.

    Trust off (self-host) with no viewers is byte-for-byte the old query.
    Returns None when no live non-viewer human exists (callers decide whether
    that is an error — see pick_human)."""
    from portal_backend.identity_routes import _proxy_trusted  # avoid import cycle

    cur.execute(
        """SELECT id FROM agents
           WHERE container_id=%s AND kind='human' AND terminated_at IS NULL
             AND member_role <> 'viewer'
             AND (%s::uuid IS NULL OR id <> %s::uuid)
             AND (%s::uuid IS NULL OR id <> %s::uuid)
             AND (%s::text IS NULL OR member_role = 'owner' OR grants ? %s::text)
           ORDER BY CASE WHEN %s AND github_login IS NULL THEN 1 ELSE 0 END,
                    CASE WHEN %s AND last_heartbeat_at IS NULL THEN 1 ELSE 0 END,
                    COALESCE(last_heartbeat_at, created_at) DESC,
                    created_at ASC
           LIMIT 1""",
        (container_id, exclude_id, exclude_id, also_exclude, also_exclude,
         grant, grant, _proxy_trusted(), _proxy_trusted()),
    )
    row = cur.fetchone()
    return str(row["id"]) if row else None


def pick_human(cur, container_id, exclude_id=None):
    """Select the human who can act on an escalated / untargeted request.

    See find_actionable_human for the ranking. Never returns a viewer: when the
    only live humans are viewers, this is a 409 (the request is refused rather
    than parked on someone who cannot answer it) — an owner must give a
    viewer the member role, or invite a member.

    `exclude_id` (parity r2): never route back to this human. When they are the
    only one who could act, 409 — escalating your own request to yourself is a
    no-op that would only park it in your own inbox."""
    human_id = find_actionable_human(cur, container_id, exclude_id)
    if human_id is not None:
        return human_id
    if exclude_id is not None and find_actionable_human(cur, container_id) is not None:
        raise HTTPException(
            409,
            "no other human in this project can act on this request — you are the "
            "only member who can answer it. Invite a member (or give a viewer the "
            "member role) to hand it off.",
        )
    cur.execute(
        """SELECT 1 FROM agents
           WHERE container_id=%s AND kind='human' AND terminated_at IS NULL
           LIMIT 1""",
        (container_id,),
    )
    if cur.fetchone() is not None:
        raise HTTPException(
            409,
            "no human in this container can act on requests — every live human "
            "is a read-only viewer. Ask an owner to give someone the member role "
            "(or invite a member).",
        )
    raise HTTPException(
        409,
        "no human agent is registered in this container. "
        "Run `orcha init --as <name>` (if this is a fresh container) "
        "or `/orcha-register-human <name>` to add one.",
    )


def reroute_open_requests(cur, container_id, from_id):
    """Move every OPEN request parked on `from_id` to a human who can act on it.

    Parity r3 (e2e-permissions-24): demoting a member to the read-only viewer role
    must not leave their open asks on someone who can never answer them (every
    viewer write 403s). Each ask goes to the find_actionable_human pick — never
    `from_id`, and preferably not the ask's own requester (a human's ask routed
    back to themselves would read "you -> you") — and is stamped
    `detail.rerouted_from_alias` so read-models can say who it was meant for.

    Non-raising: when nobody else can act the ask stays where it is and is
    reported in `unrouted` (a demotion is never refused over it).
    Returns {"rerouted": [{"request_id", "to_agent_id", "to_alias"}], "unrouted": [ids]}."""
    from portal_backend.org_chart import route_via_manager, stamp_routing  # import cycle

    cur.execute("SELECT alias FROM agents WHERE id=%s", (from_id,))
    frm = cur.fetchone()
    from_alias = frm["alias"] if frm else None
    cur.execute(
        """SELECT id, requester_id FROM requests
           WHERE container_id=%s AND target_id=%s AND status IN ('open', 'escalated')
           ORDER BY created_at ASC
           FOR UPDATE""",
        (container_id, from_id),
    )
    rows = cur.fetchall()
    rerouted, unrouted = [], []
    for row in rows:
        rid = str(row["id"])
        requester = str(row["requester_id"]) if row["requester_id"] else None
        # RT-17: the org chart comes first, exactly like a NEW ask at this moment — the
        # nearest actionable manager above the requester (the demoted member is a viewer
        # now, so the walk passes over them). Only then the recency fallback.
        to, routing = route_via_manager(
            cur, container_id, requester, exclude_ids=(requester, from_id)
        )
        if to is None:
            to = find_actionable_human(cur, container_id, from_id, also_exclude=requester)
        if to is None:
            to = find_actionable_human(cur, container_id, from_id)
        if to is None:
            unrouted.append(rid)
            continue
        cur.execute(
            """UPDATE requests
                  SET target_id=%s,
                      detail = COALESCE(detail, '{}'::jsonb)
                               || jsonb_build_object('rerouted_from_alias', %s::text)
                WHERE id=%s""",
            (to, from_alias, rid),
        )
        # RT-13: replace the routing record — a stale routed_to_alias naming the demoted
        # member would contradict the new target (None drops it; a fallback record says
        # why the chain was not used).
        stamp_routing(cur, rid, routing)
        cur.execute("SELECT alias FROM agents WHERE id=%s", (to,))
        to_row = cur.fetchone()
        rerouted.append({"request_id": rid, "to_agent_id": to,
                         "to_alias": to_row["alias"] if to_row else None})
    return {"rerouted": rerouted, "unrouted": unrouted}


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
