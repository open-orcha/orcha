"""Read and acknowledge an agent's typed notification feed."""

from typing import Optional

from fastapi import HTTPException, Request

from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_agent, valid_uuid
from portal_backend.identity_routes import trusted_actor
from portal_backend.notification_formatting import _classify_notification
from portal_backend.notification_taxonomy import _NOTIF_ACTOR_FIELDS
from portal_backend.schemas.agent_state import NotificationsRead


@app.get("/api/agents/{aid}/notifications")
def agent_notifications(
    aid: str,
    zone: Optional[str] = None,
    limit: int = 50,
    before_ts: Optional[float] = None,
    before_id: Optional[int] = None,
):
    """#247 — the recipient's TYPED notification feed, classified over the durable bus.

    Reads this agent's agent_events rows (keyed on its id), classifies each at read time via
    _classify_notification, drops suppressed rows, annotates a `read` flag against the agent's
    read cursor (agent_notification_state), and returns newest-first with keyset paging.

    No response_model — the row shape is computed, so this adds ZERO OpenAPI drift to existing
    routes (only +1 path in the spec delta). Query params:
      * ``zone=needs_you|earlier`` — filter to one SPEC-3 zone (applied AFTER classify).
      * ``limit`` (1..200, default 50) — page size.
      * ``before_ts`` + ``before_id`` — compound keyset cursor: resume strictly AFTER the
        (ts, id) of the last row of the previous page. before_id is optional/null on the first
        page; pass back BOTH next_before_ts and next_before_id verbatim for each subsequent page.
    Response: ``{notifications: [...], read_through_ts, next_before_ts, next_before_id}`` — the
    (ts, id) cursor pair to pass back for the next page (both null = reached the tail). Each row:
    ``{event_name, type, zone, priority, actor_ref, actor_alias, actor_kind, deeplink, preview,
    ts, read}`` — priority is the blocker-CLASS rank (lower = more urgent) and actor_kind
    ('ai'|'human'|None) is the ORIGIN tiebreak; the feed is ts-DESC, blocker-sort is the caller's.
    """
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    if zone is not None and zone not in ("needs_you", "earlier"):
        raise HTTPException(400, "zone must be 'needs_you' or 'earlier'")
    limit = max(1, min(limit, 200))
    fetch_cap = limit * 4
    with db_cursor() as (_, cur):
        require_agent(cur, aid)
        cur.execute(
            "SELECT read_through_ts FROM agent_notification_state WHERE agent_id=%s",
            (aid,),
        )
        cursor_row = cur.fetchone()
        read_through = cursor_row["read_through_ts"] if cursor_row else 0.0
        before_ts_eff = before_ts if before_ts is not None else 9e18
        if before_id is not None:
            cur.execute(
                """SELECT id, event_name, ts, payload FROM agent_events
                     WHERE event_key = %s AND (ts < %s OR (ts = %s AND id < %s))
                     ORDER BY ts DESC, id DESC
                     LIMIT %s""",
                (aid, before_ts_eff, before_ts_eff, before_id, fetch_cap),
            )
        else:
            cur.execute(
                """SELECT id, event_name, ts, payload FROM agent_events
                     WHERE event_key = %s AND ts < %s
                     ORDER BY ts DESC, id DESC
                     LIMIT %s""",
                (aid, before_ts_eff, fetch_cap),
            )
        raw = cur.fetchall()
        actor_ids: set[str] = set()
        for row in raw:
            payload = row["payload"] or {}
            for field in _NOTIF_ACTOR_FIELDS:
                if payload.get(field):
                    actor_ids.add(str(payload[field]))
        people: dict[str, dict] = {}
        if actor_ids:
            cur.execute(
                "SELECT id, alias, kind FROM agents WHERE id = ANY(%s)",
                (list(actor_ids),),
            )
            people = {str(agent["id"]): agent for agent in cur.fetchall()}

    notifications = []
    truncated = False
    last_emitted = None
    for row in raw:
        payload = row["payload"] or {}
        requester_is_human = False
        if row["event_name"] == "request_created":
            from_id = (
                str(payload["from_agent_id"]) if payload.get("from_agent_id") else None
            )
            requester_is_human = bool(
                from_id and (people.get(from_id) or {}).get("kind") == "human"
            )
        notification = _classify_notification(
            row["event_name"],
            payload,
            requester_is_human=requester_is_human,
        )
        if notification is None:
            continue
        if zone is not None and notification["zone"] != zone:
            continue
        actor = (
            people.get(notification["actor_ref"]) or {}
            if notification["actor_ref"]
            else {}
        )
        notifications.append(
            {
                "event_name": row["event_name"],
                "type": notification["type"],
                "zone": notification["zone"],
                "priority": notification["priority"],
                "actor_ref": notification["actor_ref"],
                "actor_alias": actor.get("alias"),
                "actor_kind": actor.get("kind"),
                "deeplink": notification["deeplink"],
                "preview": notification["preview"],
                "ts": row["ts"],
                "read": row["ts"] <= read_through,
            }
        )
        last_emitted = row
        if len(notifications) >= limit:
            truncated = True
            break

    if truncated:
        next_before_ts = last_emitted["ts"]
        next_before_id = last_emitted["id"]
    elif len(raw) >= fetch_cap:
        next_before_ts = raw[-1]["ts"]
        next_before_id = raw[-1]["id"]
    else:
        next_before_ts = None
        next_before_id = None
    return {
        "notifications": notifications,
        "read_through_ts": read_through,
        "next_before_ts": next_before_ts,
        "next_before_id": next_before_id,
    }


@app.post("/api/agents/{aid}/notifications/read", status_code=200)
def agent_notifications_read(aid: str, body: NotificationsRead, request: Request):
    """#247 — advance this agent's notification read cursor (monotonic).

    UPSERTs agent_notification_state.read_through_ts. With ``through_ts`` omitted it jumps to the
    agent's newest bus ts now ("Mark all read"); with it set, advances to that ts (per-row "mark
    read up to here"). NEVER moves backward — a stale client can't un-read via GREATEST().

    This OPERATOR read cursor is deliberately SEPARATE from agent_wake_state.delivered_ts (the
    notifier daemon's wake-ack cursor); the two must never cross-clear.
    """
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        agent = require_agent(cur, aid)
        # Per-project identity: under proxy trust a HUMAN feed cursor belongs to the
        # verified member — a member may only advance their OWN cursor, and a
        # non-member of this project is refused outright (403 from trusted_actor).
        cur.execute("SELECT kind FROM agents WHERE id=%s", (aid,))
        if cur.fetchone()["kind"] == "human":
            effective = trusted_actor(
                cur, request, str(agent["container_id"]), aid
            )
            if str(effective) != str(aid):
                raise HTTPException(
                    403, "you can only mark your own notifications read"
                )
        target = body.through_ts
        if target is None:
            cur.execute(
                "SELECT COALESCE(MAX(ts), 0) AS mx FROM agent_events WHERE event_key=%s",
                (aid,),
            )
            target = cur.fetchone()["mx"]
        cur.execute(
            """INSERT INTO agent_notification_state (agent_id, read_through_ts, updated_at)
               VALUES (%s, %s, now())
               ON CONFLICT (agent_id) DO UPDATE
                 SET read_through_ts = GREATEST(agent_notification_state.read_through_ts,
                                                EXCLUDED.read_through_ts),
                     updated_at = now()
               RETURNING read_through_ts""",
            (aid, target),
        )
        read_through = cur.fetchone()["read_through_ts"]
        conn.commit()
    return {"agent_id": aid, "read_through_ts": read_through}
