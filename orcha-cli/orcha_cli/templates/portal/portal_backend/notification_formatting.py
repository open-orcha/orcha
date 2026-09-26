"""Classify and format durable events for notification consumers."""

from typing import Optional

from portal_backend.notification_taxonomy import (
    _NOTIF_ACTOR_FIELDS,
    _NOTIF_PREVIEW_FIELDS,
    _NOTIF_PRI_HUMAN_CONVO,
    _NOTIF_PRI_REQUEST_IN,
    _NOTIF_PRI_UNKNOWN,
    _NOTIF_PRIORITY_TO_RANK,
    _NOTIF_SUPPRESSED,
    _NOTIF_TAXONOMY,
)


def _classify_notification(event_name, payload, *, requester_is_human=False):
    """Classify one bus row into a typed notification, or None to suppress it.

    PURE (no DB) so it is exhaustively unit-testable. The route resolves the two read-time
    inputs the static taxonomy can't see — `requester_is_human` (the request_created
    human-convo-vs-request-in rung split) and the actor alias — and layers the read flag on top.

    Returns ``{type, zone, priority, deeplink: {kind, id} | None, actor_ref, preview}`` or
    ``None`` when the event must not appear in the feed.
    """
    payload = payload or {}
    if event_name in _NOTIF_SUPPRESSED:
        return None

    if event_name == "request_created":
        # A fresh incoming request addressed to me. A HUMAN requester is a live-human-convo rung
        # (the operator is talking to me); an AGENT requester is the ordinary request-in rung.
        if requester_is_human:
            spec = {
                "type": "escalation",
                "zone": "needs_you",
                "priority": _NOTIF_PRI_HUMAN_CONVO,
                "link_kind": "request",
                "link_field": "request_id",
            }
        else:
            spec = {
                "type": "request_created",
                "zone": "needs_you",
                "priority": _NOTIF_PRI_REQUEST_IN,
                "link_kind": "request",
                "link_field": "request_id",
            }
    else:
        spec = _NOTIF_TAXONOMY.get(event_name)
        if spec is None:
            # graceful degrade (SPEC-3 presenceOf pattern): an unknown event_name still renders,
            # typed by its raw name, parked at the bottom of the EARLIER zone — a new event type
            # never breaks the panel.
            spec = {
                "type": event_name,
                "zone": "earlier",
                "priority": _NOTIF_PRI_UNKNOWN,
                "link_kind": None,
                "link_field": None,
            }

    deeplink = None
    if spec["link_kind"]:
        lid = payload.get(spec["link_field"])
        if lid:
            deeplink = {"kind": spec["link_kind"], "id": str(lid)}

    actor_ref = None
    for f in _NOTIF_ACTOR_FIELDS:
        if payload.get(f):
            actor_ref = str(payload[f])
            break

    preview = ""
    for f in _NOTIF_PREVIEW_FIELDS:
        v = payload.get(f)
        if v:
            preview = str(v)
            break

    # #359: a TASK-request (a teammate asking me to DO work) is the one request kind whose correct
    # drain is "accept → spawn the task → work it", NOT "answer/defer to empty the inbox". The
    # static taxonomy can't see it (request_created is one event_name for both info and task), so
    # derive it from the payload `type` the create-route stamps on the bus event. The wake manifest
    # surfaces this so build_wake_prompt can steer the worker into the work instead of deflecting it.
    is_task_request = event_name == "request_created" and (
        payload.get("type") == "task"
    )

    return {
        "type": spec["type"],
        "zone": spec["zone"],
        "priority": spec["priority"],
        "deeplink": deeplink,
        "actor_ref": actor_ref,
        "preview": preview,
        "is_task_request": is_task_request,
    }


def _notification_rank(priority: int) -> int:
    return _NOTIF_PRIORITY_TO_RANK.get(
        priority, _NOTIF_PRIORITY_TO_RANK[_NOTIF_PRI_UNKNOWN]
    )


def _notification_origin_order(actor_kind: Optional[str]) -> int:
    if actor_kind == "human":
        return 0
    if actor_kind == "ai":
        return 1
    return 2


def _notification_surface(n: dict) -> str:
    deeplink = n.get("deeplink") or {}
    kind = deeplink.get("kind")
    ident = deeplink.get("id")
    if kind and ident:
        return f"{kind}:{ident}"
    return (n.get("type") or n.get("event_name") or "notification").replace("_", "-")
