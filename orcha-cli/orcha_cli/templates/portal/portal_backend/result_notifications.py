"""Coalesce exact thread/request result mirrors without hiding independent messages."""

import json

from portal_backend import sql


# Only a closely paired, identical FULL result with the same author, recipient and
# originating task is a mirror. No preview matching, fuzzy matching or global debounce.
RESULT_MIRROR_SECONDS = 60
MIRRORED_RESULT_EVENT = "task_result_mirrored"


def lock_result_requests(cur, task_id, author_id):
    """Serialize concurrent thread/answer posts on Postgres, as SQLite already does.

    Take request locks before bumping the author, matching respond_request's order.
    The subsequent lookup sees an answer that committed while this call waited.
    """
    cur.execute(
        """SELECT id FROM requests WHERE originating_task_id=%s AND target_id=%s
           AND (status IN ('open', 'accepted') OR responded_at >= %s)
           ORDER BY id """ + sql.for_update(),
        (task_id, author_id, sql.ago(RESULT_MIRROR_SECONDS)),
    )
    cur.fetchall()


def answered_result_for_message(cur, task_id, author_id, recipient_id, body):
    """Find a just-answered request whose thread copy needs no second delivery."""
    cur.execute(
        """SELECT id FROM requests
           WHERE originating_task_id=%s AND target_id=%s AND requester_id=%s
             AND status IN ('answered', 'closed') AND response=%s
             AND responded_at >= %s
           ORDER BY responded_at DESC LIMIT 1""",
        (task_id, author_id, recipient_id, body, sql.ago(RESULT_MIRROR_SECONDS)),
    )
    row = cur.fetchone()
    return str(row["id"]) if row else None


def coalesce_result_messages(cur, request, response):
    """The answer is authoritative; retain its earlier thread-copy event as audit.

    Both calls commit independently. If a worker already saw the thread post it
    cannot be un-woken; the answer still has to reach its outbox for the close loop.
    The recipient-specific copy is reclassified, never deleted; other assignees
    and the container's live thread update are untouched.
    """
    if not request["originating_task_id"]:
        return
    cur.execute(
        """SELECT e.id, e.payload, m.attachments FROM agent_events e
           JOIN task_messages m ON CAST(m.id AS TEXT)=e.payload->>'message_id'
           JOIN agents a ON a.id=m.author_id AND a.kind='ai'
           WHERE e.event_key=%s AND e.event_name='task_message'
             AND m.task_id=%s AND m.author_id=%s AND m.body=%s
             AND m.created_at >= %s
             AND m.created_at >= (SELECT created_at FROM requests WHERE id=%s)""",
        (str(request["requester_id"]), request["originating_task_id"],
         request["target_id"], response, sql.ago(RESULT_MIRROR_SECONDS), request["id"]),
    )
    for row in cur.fetchall():
        if row["attachments"]:
            continue  # an attachment is additional information, even with identical text
        payload = {**row["payload"], "request_id": str(request["id"]),
                   "original_event_name": "task_message"}
        cur.execute(
            "UPDATE agent_events SET event_name=%s, payload=%s WHERE id=%s",
            (MIRRORED_RESULT_EVENT, json.dumps(payload), row["id"]),
        )
