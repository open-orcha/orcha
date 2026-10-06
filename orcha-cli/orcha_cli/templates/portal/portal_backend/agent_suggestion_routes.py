"""Resolve a proposed agent by creating, reassigning, or refusing it."""

from fastapi import HTTPException, Request

from portal_backend import sql
from portal_backend.agent_status import log_event, recompute_agent_status
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.events import publish_event as _publish_event
from portal_backend.guards import (
    require_kind as _require_kind,
    resolve_alias as _resolve_alias,
    valid_uuid as _valid_uuid,
)
from portal_backend.identity_routes import (
    enforce_grant as _enforce_grant,
    trusted_actor as _trusted_actor,
)
from portal_backend.request_lookup import require_request
from portal_backend.schemas.requests import SuggestionDecision


@app.post("/api/agent-suggestions/{rid}/decide", status_code=200)
def decide_suggestion(rid: str, body: SuggestionDecision, request: Request):
    """Human resolves an agent suggestion.

    kind='create': spawns the proposed agent, then accepts the underlying task request for them.
    kind='reassign': re-targets the request at an existing agent; that agent must still /accept-task.
    kind='refuse': closes the request with status='closed' (reason recorded). Requester's outbox shows it.
    """
    if not _valid_uuid(rid):
        raise HTTPException(400, "request_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        r = require_request(
            cur, rid, for_update=True
        )  # lock: serialize all request-state mutations
        # Per-project identity: a trusted proxy login IS the actor (403 non-member).
        body.actor_agent_id = _trusted_actor(
            cur, request, str(r["container_id"]), body.actor_agent_id
        )
        _require_kind(cur, body.actor_agent_id, ("human",))  # Orcha#30
        # Orcha#30: detect a pending suggestion by detail.proposed_alias, not by null target.
        # The request now lives in the targeted human's inbox until resolved.
        detail = r["detail"] or {}
        if "proposed_alias" not in detail:
            raise HTTPException(409, "request has no agent-suggestion to decide on")
        if detail.get("suggestion_decided"):
            raise HTTPException(
                409,
                f"suggestion already decided ({detail['suggestion_decided'].get('kind')})",
            )
        if r["status"] != "open":
            raise HTTPException(
                409, f"suggestion is '{r['status']}', not 'open' — already decided"
            )

        if body.kind == "create":
            # Parity r2 (e2e-permissions-29): creating the proposed agent IS registering an
            # agent, so it carries the same owner-or-manage_agents gate POST
            # /api/containers/{cid}/agents enforces (trusted lane; trust-off unchanged).
            # Reassign / refuse stay member-level — they route or close a request, they
            # don't grow the roster.
            _enforce_grant(cur, request, str(r["container_id"]), "manage_agents")
            # Cap check (UO-11a): containers.max_auto_agents caps the live AI agents that
            # were created FROM suggestions (is_auto_created) — the runaway it guards
            # against. Counting every live row (humans, hand-made agents) made any real
            # team hit the default cap of 3 and refused every approval.
            cur.execute(
                """SELECT COUNT(*) AS n FROM agents
                   WHERE container_id=%s AND terminated_at IS NULL
                     AND kind='ai' AND is_auto_created""",
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
                    f"this project already has {n_existing} suggested agent"
                    f"{'s' if n_existing != 1 else ''} (the limit is {cap}). Reassign the "
                    "work to an existing agent, or retire an agent created from a suggestion.",
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
            except Exception as exc:  # noqa: BLE001 — re-raised unless a unique violation
                if not sql.is_unique_violation(exc):
                    raise
                raise HTTPException(
                    409,
                    f"alias '{detail['proposed_alias']}' already exists in this container",
                )
            new_aid = str(cur.fetchone()["id"])
            # Now target the request at the new agent so they can /accept-task it.
            # UO-11b: stamp the decision so read-models stop offering it as a pending
            # suggestion (the request itself stays open for the new agent to accept).
            decided = sql.json_object(
                "'suggestion_decided'", sql.json_object(
                    "'kind'", "'create'", "'at'", "now()", "'actor'", "CAST(%s AS TEXT)",
                    "'new_agent_id'", "CAST(%s AS TEXT)"))
            cur.execute(
                f"""UPDATE requests SET target_id=%s, status='open',
                          detail = {sql.json_merge("COALESCE(detail, '{}')", sql.json_cast(decided))}
                   WHERE id=%s""",
                (new_aid, body.actor_agent_id, new_aid, rid),
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
            decided = sql.json_object(
                "'suggestion_decided'", sql.json_object(
                    "'kind'", "'reassign'", "'at'", "now()", "'actor'", "CAST(%s AS TEXT)",
                    "'target_alias'", "CAST(%s AS TEXT)"))
            cur.execute(
                f"""UPDATE requests SET target_id=%s, status='open',
                          detail = {sql.json_merge("COALESCE(detail, '{}')", sql.json_cast(decided))}
                   WHERE id=%s""",
                (new_target_id, body.actor_agent_id, body.target_alias, rid),
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
