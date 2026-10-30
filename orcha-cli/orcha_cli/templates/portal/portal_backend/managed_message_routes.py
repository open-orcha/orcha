"""Durable thread recovery independent of notification delivery/acknowledgements.

No heartbeats or run output are written here. Polls enrol the run for exact-run
scheduling and persist receipt IDs. Only explicit handling consumes mapped events.
"""

from typing import Annotated
from uuid import UUID

from fastapi import Header, Request

from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.event_acknowledgement import acknowledge_event_ids
from portal_backend.managed_run_auth import conflict, require_managed_run
from portal_backend.managed_message_window import ensure_message_window
from portal_backend.schemas.managed_messages import (
    ManagedMessageHandle, ManagedMessagePage, ManagedMessagePoll, ManagedMessageReceipt,
)


def _event_ids(cur, aid, tid, mid):
    cur.execute("SELECT id FROM agent_events WHERE event_key=%s AND event_name='task_message' "
                "AND payload->>'task_id'=%s AND payload->>'message_id'=%s ORDER BY id",
                (aid, tid, mid))
    return [row["id"] for row in cur.fetchall()]


def _position(cur, tid, aid, floor, *, handled):
    # A sparse set of explicit receipts is the source of truth. In particular
    # received position cannot skip an unhandled gap when computing handled.
    condition = "AND r.handled_at IS NOT NULL" if handled else ""
    gap = """AND NOT EXISTS (
        SELECT 1 FROM task_messages older
        WHERE older.task_id=m.task_id
          AND older.created_at>=%s AND (older.author_id IS NULL OR older.author_id<>%s)
          AND (older.created_at<m.created_at OR (older.created_at=m.created_at AND older.id<m.id))
          AND NOT EXISTS (SELECT 1 FROM managed_message_receipts h
                          WHERE h.task_id=older.task_id AND h.message_id=older.id
                            AND h.agent_id=%s AND h.handled_at IS NOT NULL))""" if handled else ""
    cur.execute("SELECT m.created_at,m.id AS message_id FROM task_messages m "
                "JOIN managed_message_receipts r ON r.task_id=m.task_id AND r.message_id=m.id "
                "WHERE m.task_id=%s AND r.agent_id=%s AND m.created_at>=%s "
                f"AND (m.author_id IS NULL OR m.author_id<>%s) {condition} {gap} "
                "ORDER BY m.created_at DESC,m.id DESC LIMIT 1",
                (tid, aid, floor, aid, floor, aid, aid) if handled else (tid, aid, floor, aid))
    return cur.fetchone()


@app.post("/api/tasks/{tid}/managed-messages/poll", response_model=ManagedMessagePage)
def poll_managed_messages(tid: UUID, body: ManagedMessagePoll, request: Request,
                          x_orcha_run_token: Annotated[str | None, Header()] = None):
    """Receive at most 200 unhandled messages, replaying until explicitly handled.

    This route does not renew a lease or grant authority to supervise a process.
    Callers must re-read task scope and apply instruction precedence on return.
    """
    tid = str(tid)
    with db_cursor() as (conn, cur):
        run, task = require_managed_run(cur, tid, x_orcha_run_token, request)
        aid, rid = str(run["agent_id"]), str(run["run_id"])
        floor = ensure_message_window(cur, tid, aid, rid, run['started_at'])
        cur.execute("""SELECT m.id AS message_id,m.created_at,m.author_id,m.body,
                              COALESCE(m.attachments, '[]') AS attachments,
                              a.alias AS author_alias,a.kind AS author_kind,a.member_role AS author_role
                       FROM task_messages m LEFT JOIN agents a ON a.id=m.author_id
                       WHERE m.task_id=%s AND m.created_at>=%s
                         AND (m.author_id IS NULL OR m.author_id<>%s) AND NOT EXISTS (
                           SELECT 1 FROM managed_message_receipts r
                           WHERE r.task_id=m.task_id AND r.message_id=m.id AND r.agent_id=%s
                             AND r.handled_at IS NOT NULL)
                       ORDER BY m.created_at,m.id LIMIT %s""", (tid, floor, aid, aid, body.limit + 1))
        rows = cur.fetchall()
        messages = []
        for row in rows[:body.limit]:
            mid = str(row["message_id"])
            cur.execute("""INSERT INTO managed_message_receipts
                           (task_id,agent_id,message_id,received_run_id) VALUES (%s,%s,%s,%s)
                           ON CONFLICT DO NOTHING""", (tid, aid, mid, rid))
            messages.append(dict(row, event_ids=_event_ids(cur, aid, tid, mid),
                                 operation_key=f"task-message:{tid}:{mid}"))
        result = dict(task_id=tid, run_id=rid, task=task, messages=messages,
                      has_more=len(rows) > body.limit,
                      received_position=_position(cur, tid, aid, floor, handled=False),
                      handled_position=_position(cur, tid, aid, floor, handled=True))
        conn.commit()
    return result


@app.post("/api/tasks/{tid}/managed-messages/{mid}/handled", response_model=ManagedMessageReceipt)
def handle_managed_message(tid: UUID, mid: UUID, body: ManagedMessageHandle, request: Request,
                           x_orcha_run_token: Annotated[str | None, Header()] = None):
    """Record explicit handling and acknowledge only validated message events atomically.

    External effects need their own idempotency/reconciliation. A receipt alone
    cannot promise exactly-once execution of arbitrary shell or network actions.
    """
    tid, mid = str(tid), str(mid)
    with db_cursor() as (conn, cur):
        run, _ = require_managed_run(cur, tid, x_orcha_run_token, request)
        aid, rid = str(run["agent_id"]), str(run["run_id"])
        floor = ensure_message_window(cur, tid, aid, rid, run['started_at'])
        cur.execute("SELECT * FROM managed_message_receipts "
                    "WHERE task_id=%s AND agent_id=%s AND message_id=%s", (tid, aid, mid))
        receipt = cur.fetchone()
        if not receipt:
            conflict("message_not_received")
        if receipt["handled_at"] and (receipt["outcome"] != body.outcome
                                      or receipt["handling_note"] != body.handling_note):
            conflict("message_outcome_conflict")
        already_handled = receipt["handled_at"] is not None
        if not already_handled:
            cur.execute("UPDATE managed_message_receipts SET handled_at=now(),handled_run_id=%s,outcome=%s,handling_note=%s "
                        "WHERE task_id=%s AND agent_id=%s AND message_id=%s",
                        (rid, body.outcome, body.handling_note, tid, aid, mid))
        acknowledge_event_ids(cur, aid, _event_ids(cur, aid, tid, mid))
        position = _position(cur, tid, aid, floor, handled=True)
        conn.commit()
    return dict(message_id=mid, outcome=body.outcome, already_handled=already_handled,
                handled_position=position)
