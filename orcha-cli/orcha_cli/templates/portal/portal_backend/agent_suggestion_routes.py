"""Resolve a proposed agent by creating, reassigning, or refusing it."""

import psycopg
from fastapi import HTTPException

from portal_backend.agent_status import log_event, recompute_agent_status
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.events import publish_event as _publish_event
from portal_backend.guards import (
    require_kind as _require_kind,
    resolve_alias as _resolve_alias,
    valid_uuid as _valid_uuid,
)
from portal_backend.request_lookup import require_request
from portal_backend.schemas.requests import SuggestionDecision


@app.post("/api/agent-suggestions/{rid}/decide", status_code=200)
def decide_suggestion(rid: str, body: SuggestionDecision):
    """Human resolves an agent suggestion.

    kind='create': spawns the proposed agent, then accepts the underlying task request for them.
    kind='reassign': re-targets the request at an existing agent; that agent must still /accept-task.
    kind='refuse': closes the request with status='closed' (reason recorded). Requester's outbox shows it.
    """
    if not _valid_uuid(rid):
        raise HTTPException(400, "request_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        _require_kind(cur, body.actor_agent_id, ("human",))  # Orcha#30
        r = require_request(
            cur, rid, for_update=True
        )  # lock: serialize all request-state mutations
        # Orcha#30: detect a pending suggestion by detail.proposed_alias, not by null target.
        # The request now lives in the targeted human's inbox until resolved.
        detail = r["detail"] or {}
        if "proposed_alias" not in detail:
            raise HTTPException(409, "request has no agent-suggestion to decide on")
        if r["status"] != "open":
            raise HTTPException(
                409, f"suggestion is '{r['status']}', not 'open' — already decided"
            )

        if body.kind == "create":
            # Cap check: containers.max_auto_agents = max TOTAL agents (post-PR#6 reinterpretation).
            cur.execute(
                "SELECT COUNT(*) AS n FROM agents WHERE container_id=%s AND terminated_at IS NULL",
                (str(r["container_id"]),),
            )
            n_existing = cur.fetchone()["n"]
            cur.execute(
                "SELECT max_auto_agents FROM containers WHERE id=%s",
                (str(r["container_id"]),),
            )
            cap = cur.fetchone()["max_auto_agents"]
            if n_existing >= cap:
                raise HTTPException(
                    409,
                    f"container is at the {cap}-agent cap. Reassign to an existing agent or "
                    f"raise containers.max_auto_agents.",
                )
            try:
                cur.execute(
                    """INSERT INTO agents
                         (container_id, alias, role, system_prompt, is_auto_created, parent_agent_id, turn_budget)
                       VALUES (%s, %s, %s, %s, true, %s, COALESCE(%s, 50))
                       RETURNING id""",
                    (
                        str(r["container_id"]),
                        detail["proposed_alias"],
                        detail["proposed_role"],
                        detail["proposed_prompt"],
                        str(r["requester_id"]),
                        body.turn_budget,
                    ),
                )
            except psycopg.errors.UniqueViolation:
                raise HTTPException(
                    409,
                    f"alias '{detail['proposed_alias']}' already exists in this container",
                )
            new_aid = str(cur.fetchone()["id"])
            # Now target the request at the new agent so they can /accept-task it.
            cur.execute(
                "UPDATE requests SET target_id=%s, status='open' WHERE id=%s",
                (new_aid, rid),
            )
            log_event(
                cur,
                r["container_id"],
                "human",
                None,
                "agent",
                new_aid,
                "created",
                {
                    "alias": detail["proposed_alias"],
                    "via": "suggestion accepted",
                    "from_request_id": rid,
                    "verifier_human_id": body.actor_agent_id,
                },
            )
            log_event(
                cur,
                r["container_id"],
                "human",
                None,
                "request",
                rid,
                "suggestion_decided",
                {
                    "kind": "create",
                    "new_agent_id": new_aid,
                    "verifier_human_id": body.actor_agent_id,
                },
            )
            _publish_event(
                cur,
                str(r["container_id"]),
                new_aid,
                "request_created",
                {
                    "request_id": rid,
                    "type": r["type"],
                    "from_agent_id": str(r["requester_id"]),
                    "preview": r["payload"][:120],
                    "via": "human created new agent",
                },
            )
            _publish_event(
                cur,
                str(r["container_id"]),
                str(r["requester_id"]),
                "agent_suggestion_decided",
                {
                    "request_id": rid,
                    "kind": "create",
                    "new_alias": detail["proposed_alias"],
                },
            )
            conn.commit()
            return {
                "request_id": rid,
                "kind": "create",
                "new_agent_id": new_aid,
                "new_alias": detail["proposed_alias"],
                "status": "open",
            }

        elif body.kind == "reassign":
            if not body.target_alias:
                raise HTTPException(400, "reassign requires target_alias")
            new_target_id = _resolve_alias(
                cur, str(r["container_id"]), body.target_alias
            )
            cur.execute(
                "UPDATE requests SET target_id=%s, status='open' WHERE id=%s",
                (new_target_id, rid),
            )
            log_event(
                cur,
                r["container_id"],
                "human",
                None,
                "request",
                rid,
                "suggestion_decided",
                {
                    "kind": "reassign",
                    "to_alias": body.target_alias,
                    "verifier_human_id": body.actor_agent_id,
                },
            )
            _publish_event(
                cur,
                str(r["container_id"]),
                new_target_id,
                "request_created",
                {
                    "request_id": rid,
                    "type": r["type"],
                    "from_agent_id": str(r["requester_id"]),
                    "preview": r["payload"][:120],
                    "via": "human reassigned",
                },
            )
            _publish_event(
                cur,
                str(r["container_id"]),
                str(r["requester_id"]),
                "agent_suggestion_decided",
                {
                    "request_id": rid,
                    "kind": "reassign",
                    "target_alias": body.target_alias,
                },
            )
            conn.commit()
            return {
                "request_id": rid,
                "kind": "reassign",
                "target_alias": body.target_alias,
                "status": "open",
            }

        else:  # refuse
            cur.execute(
                "UPDATE requests SET status='closed', closed_at=now(), rejection_reason=%s WHERE id=%s",
                (body.reason or "refused by human", rid),
            )
            recompute_agent_status(cur, str(r["requester_id"]))
            log_event(
                cur,
                r["container_id"],
                "human",
                None,
                "request",
                rid,
                "suggestion_decided",
                {
                    "kind": "refuse",
                    "reason": body.reason,
                    "verifier_human_id": body.actor_agent_id,
                },
            )
            _publish_event(
                cur,
                str(r["container_id"]),
                str(r["requester_id"]),
                "agent_suggestion_decided",
                {"request_id": rid, "kind": "refuse", "reason": body.reason},
            )
            conn.commit()
            return {
                "request_id": rid,
                "kind": "refuse",
                "status": "closed",
                "reason": body.reason,
            }
