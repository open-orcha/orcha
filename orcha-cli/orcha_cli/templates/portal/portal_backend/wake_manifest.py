"""Build a ranked notification manifest for worker wake prompts."""

from portal_backend.drain_classification import _drain_class
from portal_backend.event_policy import _NON_WAKING_EVENTS
from portal_backend.guards import valid_uuid as _valid_uuid
from portal_backend.notification_formatting import (
    _classify_notification,
    _notification_origin_order,
    _notification_rank,
    _notification_surface,
)
from portal_backend.notification_taxonomy import (
    _NOTIF_ACTOR_FIELDS,
    _NOTIF_PRIORITY_TO_LABEL,
    _WAKE_NOTIFICATION_MANIFEST_LIMIT,
)


def _wake_notification_manifest(
    cur,
    aid: str,
    delivered_ts: float,
    *,
    limit: int = _WAKE_NOTIFICATION_MANIFEST_LIMIT,
) -> tuple[list[dict], bool]:
    """Rank pending agent_events with the #247 notification registry for wake routing.

    This is the wake/boot consumer of the KEYSTONE registry: it reads the same bus rows that
    drive pending_events, classifies them through _classify_notification, resolves origin +
    object priority, and returns a compact rank-ordered manifest for the notifier prompt.
    The prompt limit is applied AFTER ranking the full pending set; otherwise an older low-rank
    backlog can hide a newer interrupt/human request from the wake prompt.
    """
    cur.execute(
        """SELECT e.id, e.event_name, e.ts, e.payload, e.target_id
           FROM agent_events e
           WHERE e.event_key = %s AND e.ts > %s AND e.event_name <> ALL(%s)
             AND NOT EXISTS (SELECT 1 FROM agent_event_acks a
                              WHERE a.agent_id = %s AND a.event_id = e.id)
           ORDER BY e.ts ASC, e.id ASC""",
        (aid, delivered_ts, list(_NON_WAKING_EVENTS), aid),
    )
    raw = cur.fetchall()

    ids: set[str] = set()
    for r in raw:
        p = r["payload"] or {}
        for f in _NOTIF_ACTOR_FIELDS:
            if p.get(f):
                ids.add(str(p[f]))
    people: dict[str, dict] = {}
    if ids:
        cur.execute(
            "SELECT id, alias, kind FROM agents WHERE id = ANY(%s)", (list(ids),)
        )
        people = {str(a["id"]): a for a in cur.fetchall()}

    items = []
    task_ids: set[str] = set()
    request_ids: set[str] = set()
    for r in raw:
        p = r["payload"] or {}
        requester_is_human = False
        if r["event_name"] == "request_created":
            fa = str(p["from_agent_id"]) if p.get("from_agent_id") else None
            requester_is_human = bool(
                fa and (people.get(fa) or {}).get("kind") == "human"
            )
        n = _classify_notification(
            r["event_name"], p, requester_is_human=requester_is_human
        )
        if n is None:
            continue

        actor = people.get(n["actor_ref"]) or {} if n["actor_ref"] else {}
        deeplink = n["deeplink"] or {}
        if deeplink.get("kind") == "task" and _valid_uuid(deeplink.get("id")):
            task_ids.add(deeplink["id"])
        if deeplink.get("kind") == "request" and _valid_uuid(deeplink.get("id")):
            request_ids.add(deeplink["id"])

        # GH #58 (R3): carry the SAME drain classification used for prompt_messages / handled_event_ids
        # so wake_scan can drop a cross-task task-scoped row from the rendered manifest once the run
        # context is known — the manifest is rendered verbatim as "drain in this order", so an unfiltered
        # cross-task row would tell a task-B worker to drain task A's row (the R3 gap).
        dc = _drain_class(cur, r["event_name"], p, target_id=r["target_id"])
        priority = n["priority"]
        item = {
            "event_name": r["event_name"],
            "type": n["type"],
            "zone": n["zone"],
            "priority": priority,
            "rank": _notification_rank(priority),
            "rank_label": _NOTIF_PRIORITY_TO_LABEL.get(priority, "unknown"),
            "actor_ref": n["actor_ref"],
            "actor_alias": actor.get("alias"),
            "actor_kind": actor.get("kind"),
            "deeplink": n["deeplink"],
            "preview": n["preview"],
            "ts": r["ts"],
            "object_priority": None,
            "is_task_request": n.get(
                "is_task_request", False
            ),  # #359: steer the wake prompt into the work
            "drain_bucket": dc["bucket"],
            "drain_task_id": dc["task_id"],
        }
        item["surface"] = _notification_surface(item)
        items.append(item)

    object_priorities: dict[tuple[str, str], int] = {}
    if task_ids:
        cur.execute(
            "SELECT id, priority FROM tasks WHERE id = ANY(%s)", (list(task_ids),)
        )
        object_priorities.update(
            {("task", str(r["id"])): r["priority"] for r in cur.fetchall()}
        )
    if request_ids:
        cur.execute(
            "SELECT id, priority FROM requests WHERE id = ANY(%s)", (list(request_ids),)
        )
        object_priorities.update(
            {("request", str(r["id"])): r["priority"] for r in cur.fetchall()}
        )

    for item in items:
        deeplink = item.get("deeplink") or {}
        key = (deeplink.get("kind"), deeplink.get("id"))
        item["object_priority"] = object_priorities.get(key)

    def _sort_key(item):
        object_priority = (
            item["object_priority"]
            if item["object_priority"] is not None
            else 1_000_000
        )
        return (
            item["rank"],
            object_priority,
            _notification_origin_order(item.get("actor_kind")),
            item["ts"],
        )

    items.sort(key=_sort_key)
    return items[:limit], len(items) > limit
