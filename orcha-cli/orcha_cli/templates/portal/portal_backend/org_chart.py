"""Org chart (mig 052): reporting lines and manager-chain escalation routing.

Reporting lines are HUMAN-authoritative data (PUT /api/agents/{aid}/reports-to, see
org_chart_routes). Agents never create agents and never rewire the org; the chart only
decides WHO an untargeted / escalated ask lands on.

Routing rule (``route_via_manager``), applied before the existing
``guards.pick_human`` fallback by every path that picks a human for an agent:

  1. Walk the requester's manager chain upward (nearest manager first).
     - retired managers (terminated_at set) are passed through — their own manager is next;
     - a human manager who can ACT (not a viewer; and, when the path needs one, holding
       the grant — e.g. ``manage_agents`` for an agent suggestion) wins;
     - a viewer is skipped (the viewer role is read-only and must never receive an ask);
     - an AI manager is skipped: every path routed here is "ask a HUMAN" by contract
       (an untargeted request is born escalated-to-human, Orcha#30; escalate / the expiry
       sweep / a suggestion re-target a human). Agent-to-agent asks stay explicit
       (``target_alias``) — the chart never turns a human escalation into an AI one.
  2. Nobody actionable in the chain → the caller's existing fallback (pick_human).

The walk is bounded and cycle-safe even though the API refuses cycles (a visited set
plus a depth cap), mirroring Paperclip's getChainOfCommand
(https://github.com/paperclipai/paperclip, MIT — server/src/services/agents.ts).
"""

from typing import Optional

from psycopg.types.json import Jsonb

from portal_backend.identity_routes import has_grant

MAX_CHAIN = 50  # depth cap (a team is never this deep; guards a corrupted row)


def manager_chain(cur, agent_id) -> list:
    """The agent's managers, nearest first: rows {id, alias, kind, member_role, grants,
    terminated_at, container_id}. Cycle-safe and depth-capped."""
    chain: list = []
    seen = {str(agent_id)}
    cur.execute("SELECT reports_to_agent_id FROM agents WHERE id=%s", (agent_id,))
    row = cur.fetchone()
    nxt = row["reports_to_agent_id"] if row else None
    while nxt is not None and str(nxt) not in seen and len(chain) < MAX_CHAIN:
        seen.add(str(nxt))
        cur.execute(
            """SELECT id, alias, kind, member_role, grants, terminated_at, container_id,
                      reports_to_agent_id
                 FROM agents WHERE id=%s""",
            (nxt,),
        )
        mgr = cur.fetchone()
        if not mgr:
            break
        chain.append(mgr)
        nxt = mgr["reports_to_agent_id"]
    return chain


def would_cycle(cur, agent_id, manager_id) -> bool:
    """Would ``agent_id → manager_id`` close a loop? (self, or agent_id is above manager)."""
    if str(agent_id) == str(manager_id):
        return True
    return _reaches(cur, manager_id, agent_id)


def _reaches(cur, start_id, target_id) -> bool:
    cur.execute(
        """WITH RECURSIVE up(id, depth) AS (
               SELECT reports_to_agent_id, 1 FROM agents WHERE id=%s
               UNION ALL
               SELECT a.reports_to_agent_id, up.depth + 1
                 FROM agents a JOIN up ON a.id = up.id
                WHERE up.depth < %s AND a.reports_to_agent_id IS NOT NULL)
           SELECT 1 FROM up WHERE id=%s LIMIT 1""",
        (start_id, MAX_CHAIN, target_id),
    )
    return cur.fetchone() is not None


def route_via_manager(cur, container_id, from_agent_id, *, exclude_ids=(),
                      start_above=None, grant: Optional[str] = None):
    """The nearest actionable HUMAN in ``from_agent_id``'s manager chain, or None.

    Returns ``(human_id, detail)`` where ``detail`` is the routing record to stamp on the
    request (``routed_via='reports_to'``, the manager's alias and depth, and any skipped
    managers), or ``(None, detail|None)`` when the chain has nobody who can act —
    ``detail`` then records ``routed_via='fallback'`` so the read side can say why the
    ask did not go to the manager (None when the agent has no reporting line at all).

    ``exclude_ids``: humans who must not receive it (e.g. the escalating requester).
    ``start_above``: escalation climbs — when this id (the current target) is in the
    chain, only managers ABOVE it are considered.
    ``grant``: the grant the recipient must hold (owner implicitly holds every grant).
    """
    if not from_agent_id:
        return None, None
    chain = manager_chain(cur, from_agent_id)
    if not chain:
        return None, None
    if start_above is not None:
        ids = [str(m["id"]) for m in chain]
        if str(start_above) in ids:
            chain = chain[ids.index(str(start_above)) + 1:]
    excluded = {str(x) for x in exclude_ids if x}
    skipped = []
    for depth, mgr in enumerate(chain, start=1):
        alias = mgr["alias"]
        if str(mgr["container_id"]) != str(container_id):
            skipped.append({"alias": alias, "why": "other_project"})
            continue
        if mgr["terminated_at"] is not None:
            skipped.append({"alias": alias, "why": "retired"})
            continue
        if mgr["kind"] != "human":
            skipped.append({"alias": alias, "why": "ai_manager"})
            continue
        if mgr["member_role"] == "viewer":
            skipped.append({"alias": alias, "why": "viewer"})
            continue
        if str(mgr["id"]) in excluded:
            skipped.append({"alias": alias, "why": "excluded"})
            continue
        if grant is not None and not has_grant(mgr, grant):
            skipped.append({"alias": alias, "why": "missing_grant"})
            continue
        detail = {
            "routed_via": "reports_to",
            "routed_to_alias": alias,
            "manager_depth": depth,
        }
        if skipped:
            detail["reports_to_skipped"] = skipped
        return str(mgr["id"]), detail
    return None, {"routed_via": "fallback", "reports_to_skipped": skipped}


ROUTING_KEYS = ("routed_via", "routed_to_alias", "manager_depth", "reports_to_skipped")


def clear_routing(detail: Optional[dict]) -> dict:
    """``detail`` without a previous routing record (a re-route replaces it)."""
    return {k: v for k, v in (detail or {}).items() if k not in ROUTING_KEYS}


def stamp_routing(cur, request_id, routing: Optional[dict]) -> None:
    """Replace the routing record in ``requests.detail``: merge ``routing`` in, or — when
    None — drop a stale record left by an earlier routing of the same request."""
    keys = list(ROUTING_KEYS)
    if routing:
        cur.execute(
            "UPDATE requests SET detail = (COALESCE(detail, '{}'::jsonb) - %s::text[]) || %s "
            "WHERE id=%s",
            (keys, Jsonb(routing), request_id),
        )
    else:
        cur.execute(
            "UPDATE requests SET detail = detail - %s::text[] "
            "WHERE id=%s AND detail IS NOT NULL AND detail ?| %s::text[]",
            (keys, request_id, keys),
        )
