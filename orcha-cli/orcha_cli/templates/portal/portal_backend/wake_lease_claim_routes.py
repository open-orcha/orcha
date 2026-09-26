"""Claim one of an agent's independent wake leases before starting work."""

from fastapi import HTTPException

from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_agent, valid_uuid
from portal_backend.schemas.wakes import WakeClaim


def resolve_claim_lane(body) -> str:
    """Resolve the backward-compatible lease lane for a claim or renewal."""
    lane = getattr(body, "lane", None)
    if lane:
        return lane
    if (
        getattr(body, "lease_kind", None) == "resident"
        or getattr(body, "kind", None) == "conversation"
    ):
        return "conversation"
    return "work"


@app.post("/api/agents/{aid}/wake-claim", status_code=200)
def wake_claim(aid: str, body: WakeClaim):
    """R2.4: atomic single-flight claim — the daemon MUST win this before spawning a worker.

    The runaway happened because nothing stopped the daemon from spawning a second
    (third, twelfth) headless worker for an agent that already had one live. This
    endpoint hands out an exclusive, TTL-bounded lease per agent: the conditional
    UPDATE only succeeds when no unexpired lease exists, so concurrent/rapid scans
    serialize to exactly one winner. The loser gets {claimed: false} and does NOT
    spawn. The lease auto-expires after lease_ttl (crash-safe: a dead worker never
    wedges the agent), and a clean worker exit releases it early via wake-ack.

    Also the enforcement point for the global kill-switch: if containers.wakes_enabled
    is false the claim is refused outright, so flipping one flag halts all spawning.
    """
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        agent = require_agent(cur, aid)
        cur.execute(
            "SELECT status, wakes_enabled FROM containers WHERE id=%s",
            (agent["container_id"],),
        )
        container = cur.fetchone()
        if container["status"] != "active":
            return {
                "agent_id": aid,
                "claimed": False,
                "reason": f"container {container['status']} — wakes suppressed",
            }
        if not container["wakes_enabled"]:
            return {
                "agent_id": aid,
                "claimed": False,
                "reason": "global wake kill-switch is OFF (wakes_enabled=false)",
            }
        cur.execute(
            "SELECT wake_enabled FROM agent_reachability WHERE agent_id=%s", (aid,)
        )
        reachability = cur.fetchone()
        if reachability is not None and reachability["wake_enabled"] is False:
            return {
                "agent_id": aid,
                "claimed": False,
                "reason": "wake disabled for this agent (opt-out)",
            }
        lane = resolve_claim_lane(body)
        if lane == "conversation":
            cur.execute(
                """INSERT INTO agent_wake_state
                     (agent_id, conv_lease_until, conv_last_woken_at, conv_lease_kind)
                   VALUES (%s, now() + make_interval(secs => %s), now(), %s)
                   ON CONFLICT (agent_id) DO UPDATE SET
                     conv_lease_until = now() + make_interval(secs => %s),
                     conv_last_woken_at = now(),
                     conv_lease_kind = EXCLUDED.conv_lease_kind,
                     conv_preempt_requested_at = NULL,
                     conv_preempt_for = NULL
                   WHERE (agent_wake_state.conv_lease_until IS NULL
                          OR agent_wake_state.conv_lease_until < now())
                     AND NOT EXISTS (
                       SELECT 1 FROM worker_runs wr
                       WHERE wr.agent_id = agent_wake_state.agent_id
                         AND wr.status = 'running' AND wr.lane = 'conversation')
                   RETURNING conv_lease_until AS wake_lease_until,
                             conv_lease_kind AS lease_kind""",
                (aid, body.lease_ttl, body.lease_kind, body.lease_ttl),
            )
        else:
            cur.execute(
                """INSERT INTO agent_wake_state
                     (agent_id, wake_lease_until, last_woken_at, lease_kind)
                   VALUES (%s, now() + make_interval(secs => %s), now(), %s)
                   ON CONFLICT (agent_id) DO UPDATE SET
                     wake_lease_until = now() + make_interval(secs => %s),
                     last_woken_at = now(),
                     lease_kind = EXCLUDED.lease_kind,
                     preempt_requested_at = NULL,
                     preempt_for = NULL
                   WHERE (agent_wake_state.wake_lease_until IS NULL
                          OR agent_wake_state.wake_lease_until < now())
                     AND NOT EXISTS (
                       SELECT 1 FROM worker_runs wr
                       WHERE wr.agent_id = agent_wake_state.agent_id
                         AND wr.status = 'running' AND wr.lane = 'work')
                   RETURNING wake_lease_until, lease_kind""",
                (aid, body.lease_ttl, body.lease_kind, body.lease_ttl),
            )
        row = cur.fetchone()
        if row is None:
            conn.rollback()
            lease_columns = (
                "conv_lease_until AS wake_lease_until, conv_lease_kind AS lease_kind"
                if lane == "conversation"
                else "wake_lease_until, lease_kind"
            )
            cur.execute(
                f"SELECT {lease_columns} FROM agent_wake_state WHERE agent_id=%s",
                (aid,),
            )
            held = cur.fetchone()
            held_kind = held["lease_kind"] if held else None
            if (
                lane == "work"
                and body.preempt
                and body.lease_kind == "live"
                and held_kind == "resident"
            ):
                cur.execute(
                    """UPDATE agent_wake_state
                       SET preempt_requested_at=now(), preempt_for=%s
                       WHERE agent_id=%s AND lease_kind='resident'""",
                    (body.lease_kind, aid),
                )
                log_event(
                    cur,
                    str(agent["container_id"]),
                    "system",
                    None,
                    "agent",
                    aid,
                    "wake_preempt_requested",
                    {"by": body.lease_kind, "holder": held_kind},
                )
                conn.commit()
                return {
                    "agent_id": aid,
                    "claimed": False,
                    "reason": "yield_pending",
                    "lane": lane,
                    "lease_kind": held_kind,
                    "preempt_requested": True,
                    "wake_lease_until": (
                        held["wake_lease_until"].isoformat()
                        if held and held["wake_lease_until"]
                        else None
                    ),
                }
            reason = {
                "resident": "a resident session is live (single-embodiment)",
                "live": "a live terminal session is held (single-embodiment)",
            }.get(held_kind, "a worker is already live (single-flight lease held)")
            return {
                "agent_id": aid,
                "claimed": False,
                "reason": reason,
                "lane": lane,
                "lease_kind": held_kind,
                "wake_lease_until": (
                    held["wake_lease_until"].isoformat()
                    if held and held["wake_lease_until"]
                    else None
                ),
            }
        log_event(
            cur,
            str(agent["container_id"]),
            "system",
            None,
            "agent",
            aid,
            "wake_claimed",
            {
                "kind": body.kind,
                "event": body.event,
                "lease_ttl": body.lease_ttl,
                "lease_kind": body.lease_kind,
                "lane": lane,
            },
        )
        conn.commit()
    response = {
        "agent_id": aid,
        "claimed": True,
        "lane": lane,
        "lease_kind": row["lease_kind"],
        "wake_lease_until": row["wake_lease_until"].isoformat(),
    }
    if body.lease_kind == "live":
        response["cold"] = True
        response["session_id"] = None
    return response
