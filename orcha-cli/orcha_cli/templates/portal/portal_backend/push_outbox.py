"""After-commit, best-effort push-outbox writes for needs-you birth events.

The three transitions that CREATE a needs-you item (the same gate set the iOS
app's local BGAppRefresh sweep computes client-side, NotificationManager.swift):

  * a task parks at needs_verification            → push_task_verify
  * the OPENING agent-authored plan message posts → push_plan_approval
  * a request opens targeting a human             → push_request

Contract — cheap and failure-silent, by construction:

  * Called AFTER the route handler's own commit, outside its transaction. A
    push row is advisory delivery state, never domain state — the main write
    must land identically whether or not push is configured, reachable, or
    even migrated. Every public function opens its own connection and swallows
    EVERY exception (including a missing table on a half-migrated stack).
  * Cheapest gate first: if no live push_devices row belongs to a member of
    the container, return without writing anything — a stack where nobody
    registered a phone (the dormant default) pays one indexed SELECT per
    needs-you birth and nothing more.
  * Re-verifies the transition in its OWN transaction (post-commit rows are
    visible) rather than trusting the caller — the eligibility queries mirror
    the iOS sweep's definitions (task_list_query.py's plan_message /
    plan_decision semantics for plans; target kind='human' for requests).
  * Device tokens are NOT snapshotted into the row — the outbox carries only
    (container_id, kind, ref_id, title, body); the claim endpoint
    (push_routes.py) resolves members' live devices at send time.

Delivery from here on: deploy/push-forwarder.py claims batches via the portal,
hands them to the central relay (deploy/push-relay/ — the ONLY holder of the
APNs signing key), and marks rows delivered/failed. Rows older than 48 hours
are pruned on every enqueue and every claim, so a dormant box ages out.
"""

from portal_backend.database import db_cursor

# Notification titles mirror the iOS local-notification sweep verbatim, so a
# remote push and a local BGAppRefresh alert for the same item read identically.
TITLE_BY_KIND = {
    "task_verify": "Verify task",
    "plan_approval": "Plan approval",
    "request": "Request for you",
}

BODY_MAX_CHARS = 140  # matches the iOS sweep's request-payload preview
PRUNE_HOURS = 48


def _prune(cur) -> None:
    """Age out stale rows unconditionally — delivered, failed, or never claimed."""
    cur.execute(
        "DELETE FROM push_outbox WHERE created_at < now() - %s * interval '1 hour'",
        (PRUNE_HOURS,),
    )


def _seeded(cur, container_id) -> bool:
    """Does ANY live device belong to a member of this container?

    The dormant-mode gate: no phones registered → no outbox rows, ever."""
    cur.execute(
        """SELECT 1 FROM push_devices pd
           WHERE pd.revoked_at IS NULL
             AND EXISTS (SELECT 1 FROM agents a
                          WHERE a.container_id=%s AND a.kind='human'
                            AND a.terminated_at IS NULL
                            AND lower(a.github_login)=pd.github_login)
           LIMIT 1""",
        (container_id,),
    )
    return cur.fetchone() is not None


def _container_name(cur, container_id) -> str:
    cur.execute("SELECT name FROM containers WHERE id=%s", (container_id,))
    row = cur.fetchone()
    return row["name"] if row else "Orcha"


def _enqueue(cur, container_id, kind, ref_id, body) -> None:
    """Insert one pending row, deduped against an identical still-pending item."""
    title = f"{TITLE_BY_KIND[kind]} — {_container_name(cur, container_id)}"
    cur.execute(
        """INSERT INTO push_outbox (container_id, kind, ref_id, title, body)
           SELECT %(cid)s, %(kind)s, %(ref)s, %(title)s, %(body)s
           WHERE NOT EXISTS (SELECT 1 FROM push_outbox
                              WHERE container_id=%(cid)s AND kind=%(kind)s
                                AND ref_id=%(ref)s AND delivered_at IS NULL
                                AND failed IS NULL)""",
        {
            "cid": container_id,
            "kind": kind,
            "ref": ref_id,
            "title": title,
            "body": (body or "")[:BODY_MAX_CHARS],
        },
    )


def push_task_verify(container_id, task_id) -> None:
    """A task parked at needs_verification — a human must verify it."""
    try:
        with db_cursor() as (conn, cur):
            if not _seeded(cur, container_id):
                return
            cur.execute(
                "SELECT title FROM tasks WHERE id=%s AND container_id=%s "
                "AND status='needs_verification'",
                (task_id, container_id),
            )
            row = cur.fetchone()
            if not row:
                return
            _prune(cur)
            _enqueue(cur, container_id, "task_verify", task_id, row["title"])
            conn.commit()
    except Exception:
        pass  # best-effort by contract — push must never surface in the main flow


def push_plan_approval(container_id, task_id, message_id) -> None:
    """The OPENING plan message posted — the approval gate just became visible.

    Eligible only when the just-posted message IS the task's plan_message (the
    EARLIEST agent-authored post — task_list_query.py semantics), the task is
    still in_progress, and no plan_approval decision exists yet. A later
    progress note on the same thread never re-fires."""
    try:
        with db_cursor() as (conn, cur):
            if not _seeded(cur, container_id):
                return
            cur.execute(
                """SELECT t.title FROM tasks t
                   WHERE t.id=%(tid)s AND t.container_id=%(cid)s
                     AND t.status='in_progress'
                     AND %(mid)s = (SELECT m.id FROM task_messages m
                                     JOIN agents ma ON ma.id = m.author_id
                                    WHERE m.task_id=t.id AND ma.kind <> 'human'
                                    ORDER BY m.created_at ASC, m.id ASC LIMIT 1)
                     AND NOT EXISTS (SELECT 1 FROM decisions d
                                      WHERE d.subject_type='plan_approval'
                                        AND d.subject_id=t.id::text)""",
                {"tid": task_id, "cid": container_id, "mid": message_id},
            )
            row = cur.fetchone()
            if not row:
                return
            _prune(cur)
            _enqueue(cur, container_id, "plan_approval", task_id, row["title"])
            conn.commit()
    except Exception:
        pass


def push_request(container_id, request_id) -> None:
    """A request opened targeting a human (unspecified targets resolve to the
    human at birth — Orcha#30 — so 'or nil' is covered by the same check)."""
    try:
        with db_cursor() as (conn, cur):
            if not _seeded(cur, container_id):
                return
            cur.execute(
                """SELECT r.payload FROM requests r
                   JOIN agents tg ON tg.id = r.target_id
                   WHERE r.id=%s AND r.container_id=%s
                     AND r.status='open' AND tg.kind='human'""",
                (request_id, container_id),
            )
            row = cur.fetchone()
            if not row:
                return
            _prune(cur)
            _enqueue(cur, container_id, "request", request_id, row["payload"])
            conn.commit()
    except Exception:
        pass
