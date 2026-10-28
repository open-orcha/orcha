"""Selective reconciliation of obsolete wake notifications, never a cursor jump.

History stays in agent_events/task_messages. Only exact per-agent event acknowledgements
are added. Prompts (including human nudges), answers and unknown events are never discarded.
"""
from portal_backend import sql
from portal_backend.agent_status import log_event
from portal_backend.guards import valid_uuid


def obsolete_reason(cur, aid, event, *, lock=False):
    payload = event["payload"] or {}
    name = event["event_name"]
    suffix = sql.for_update() if lock else ""
    if name in {"task_message", "task_assigned", "task_ready", "task_created_unassigned"}:
        tid = payload.get("task_id")
        if not tid or not valid_uuid(str(tid)):
            return None  # unknown history is not proof that work is obsolete
        cur.execute("SELECT status FROM tasks WHERE id=%s" + suffix, (tid,))
        task = cur.fetchone()
        if task and task["status"] in {"completed", "cancelled"}:
            return "terminal_task"
    elif name == "request_created":
        rid = payload.get("request_id")
        if not rid or not valid_uuid(str(rid)):
            return None
        cur.execute("SELECT status,target_id FROM requests WHERE id=%s" + suffix, (rid,))
        request = cur.fetchone()
        if request and (request["status"] != "open" or str(request["target_id"]) != str(aid)):
            return "request_no_longer_owed"
    return None


def stale_pending_events(cur, aid, delivered_ts, event_ids=None):
    restriction = ""
    args = [aid, delivered_ts, aid]
    if event_ids is not None:
        if not event_ids:
            return {}
        restriction = " AND " + sql.in_list("e.id")
        args.append(sql.list_param(event_ids))
    cur.execute("""SELECT e.id,e.event_name,e.payload FROM agent_events e
        WHERE e.event_key=%s AND e.ts>%s AND NOT EXISTS
          (SELECT 1 FROM agent_event_acks a WHERE a.agent_id=%s AND a.event_id=e.id)
        """ + restriction + " ORDER BY e.id", tuple(args))
    return {row["id"]: reason for row in cur.fetchall()
            if (reason := obsolete_reason(cur, aid, row))}


def reconcile_events(cur, aid, cid, event_ids, *, dry_run=True):
    """At most 200 explicitly named rows; re-read and lock current subject state on apply.

    SQLite uses the enclosing immediate transaction; PostgreSQL locks the subject before
    inserting its ack. No timestamp/cursor is changed, even across equal timestamps.
    """
    if len(event_ids) > 200:
        raise ValueError("At most 200 events may be reconciled at once")
    if not event_ids:
        return {"dry_run": dry_run, "obsolete": [], "preserved_event_ids": []}
    if not dry_run:
        from portal_backend.workflow_service import lock_container_graph
        lock_container_graph(cur, cid)
    cur.execute("""SELECT e.id,e.event_name,e.payload FROM agent_events e
        WHERE e.event_key=%s AND """ + sql.in_list("e.id") + """
        AND NOT EXISTS (SELECT 1 FROM agent_event_acks a WHERE a.agent_id=%s AND a.event_id=e.id)
        ORDER BY e.id""", (aid, sql.list_param(event_ids), aid))
    obsolete = []
    for row in cur.fetchall():
        reason = obsolete_reason(cur, aid, row, lock=not dry_run)
        if reason:
            obsolete.append({"event_id": row["id"], "reason": reason})
            if not dry_run:
                cur.execute("INSERT INTO agent_event_acks(agent_id,event_id) VALUES (%s,%s) ON CONFLICT DO NOTHING", (aid, row["id"]))
    result = {"dry_run": dry_run, "obsolete": obsolete,
              "preserved_event_ids": sorted(set(event_ids) - {r["event_id"] for r in obsolete})}
    if not dry_run and obsolete:
        log_event(cur, cid, "system", None, "agent", aid, "stale_events_reconciled", result)
    return result
