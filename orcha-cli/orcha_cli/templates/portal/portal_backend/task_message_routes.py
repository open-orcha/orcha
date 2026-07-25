"""Append and page task collaboration messages."""

import json
from typing import Any, Optional

from fastapi import HTTPException

from portal_backend.agent_status import bump_agent, log_event
from portal_backend.application import app
from portal_backend.attachment_references import (
    validate_attachment_refs as _validate_attachment_refs,
)
from portal_backend.database import db_cursor
from portal_backend.events import publish_event as _publish_event
from portal_backend.guards import (
    reject_if_retired as _reject_if_retired,
    require_container_active as _require_container_active,
    require_task as _require_task,
    valid_uuid as _valid_uuid,
)
from portal_backend.provider_keys import container_llm_key as _container_llm_key
from portal_backend.schemas.task_operations import TaskMessage


@app.post("/api/tasks/{tid}/messages", status_code=201)
def post_message(tid: str, body: TaskMessage):
    if not _valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    if body.author_agent_id is not None and not _valid_uuid(body.author_agent_id):
        raise HTTPException(400, "author_agent_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        t = _require_task(cur, tid)
        _reject_if_retired(cur, body.author_agent_id)  # ISS-51 [P1]
        _require_container_active(
            cur, str(t["container_id"]), body.author_agent_id
        )  # GH #24 (human None-author posts still allowed)
        # ISS-43: an attributed author must be a (non-retired) member of the task's CONTAINER,
        # but need NOT be an assignee. The original guard (assignee-only) was too strict for the
        # fleet's collaboration model — reviewers and coordinators routinely post on a dev's task
        # thread. Hitting a 403, those legitimate cross-task posts dropped their author_agent_id
        # and went in as a NULL author to get through. We still reject a non-member /
        # cross-container id so authorship can't be forged. We resolve the author's agents.kind
        # here so the audit actor_type (and the read-path is_human) are derived from WHO the
        # author IS, not from whether an id was supplied — see #271 below.
        author_kind = None
        if body.author_agent_id:
            cur.execute(
                "SELECT kind FROM agents WHERE id=%s AND container_id=%s LIMIT 1",
                (body.author_agent_id, t["container_id"]),
            )
            arow = cur.fetchone()
            if not arow:
                raise HTTPException(
                    403,
                    "author agent isn't a member of this task's container — cannot post",
                )
            author_kind = arow["kind"]
        # #301: re-validate any staged attachment refs against disk (re-deriving size/type) so
        # the JSONB only ever holds real, this-task files — never client-fabricated paths.
        llm_key = _container_llm_key(cur, str(t["container_id"]))
        attachments = _validate_attachment_refs(tid, body.attachments, api_key=llm_key)
        cur.execute(
            "INSERT INTO task_messages (task_id, author_id, body, attachments) "
            "VALUES (%s, %s, %s, %s) RETURNING id",
            (tid, body.author_agent_id, body.body, json.dumps(attachments)),
        )
        mid = str(cur.fetchone()["id"])
        if body.author_agent_id:
            bump_agent(cur, body.author_agent_id)
        # #271 (harden AI-actor enforcement): the audit actor_type is DERIVED from the resolved
        # agents.kind, NEVER from the mere presence/absence of an author id. The old
        # `"ai" if author else "human"` logged a NULL-author post as "human" — so an AI could
        # fabricate a human-attributed thread post just by OMITTING its author_agent_id (spoof
        # vector V1). A NULL author now logs as a neutral 'system' actor (never 'human'); a real
        # human post is attributed (kind='human') by the portal comment box. NOTE the residual
        # vector V2 documented on _require_kind: with no server-side caller auth, an AI that
        # supplies a known human's UUID still clears human gates — that needs capability tokens,
        # out of scope for this cooperative-hardening pass.
        actor_type = author_kind if author_kind else "system"
        log_event(
            cur,
            t["container_id"],
            actor_type,
            body.author_agent_id,
            "task",
            tid,
            "message",
            {"message_id": mid, "preview": body.body[:120]},
        )
        # R2.2: a task-thread message is a wake trigger for the task's OTHER assignees.
        # Previously this emitted no agent_events, so a teammate's note silently stranded
        # until they happened to look. Publish a targeted `task_message` event to every
        # assignee except the author so the daemon/listen loop wakes them out-of-band.
        cur.execute("SELECT agent_id FROM agent_tasks WHERE task_id=%s", (tid,))
        for row in cur.fetchall():
            target = str(row["agent_id"])
            if target == body.author_agent_id:
                continue  # don't wake yourself for your own message
            _publish_event(
                cur,
                str(t["container_id"]),
                target,
                "task_message",
                {
                    "task_id": tid,
                    "message_id": mid,
                    "from_agent_id": body.author_agent_id,
                    "preview": body.body[:120],
                },
            )
        conn.commit()
    return {"message_id": mid, "task_id": tid}


@app.get("/api/tasks/{tid}/messages")
def get_task_messages(
    tid: str,
    limit: int = 0,
    before: Optional[str] = None,
    before_id: Optional[str] = None,
):
    """Orcha#32: read the task collaboration thread. Symmetric with the POST above.

    The thread was write-only — task_messages had no read path, so agents posted
    progress notes that nobody could read back and the portal reported 0 messages.
    Returns the thread ordered by created_at ASC with the author alias resolved
    (LEFT JOIN agents). Same element shape that GET /api/containers/{cid} now embeds as each
    task's `messages[]`. Implemented by A on Thread's behalf.

    is_human derivation (#271, was ISS-43): `author_id IS NOT NULL AND agents.kind = 'human'`.
    Humans are themselves agents (kind='human', the 1:1:1 model), so a real human post is
    ATTRIBUTED and resolves kind='human'. A NULL author is NO LONGER treated as human — the old
    `author_id IS NULL OR ...` let an AI fabricate a human-looking post by omitting its id (spoof
    vector V1). A NULL author now renders is_human=false (the frontend shows it through the neutral
    'system' label). The portal comment box attributes human posts with the acting human's id.

    ISS-68 (#167): optional CURSOR pagination for lazy thread loading. With no params the
    full thread is returned ASC (unchanged). With `limit`>0 the NEWEST `limit` messages are
    returned, still ASC within the page, plus `has_more` + a `(next_before, next_before_id)`
    keyset cursor the panel echoes back as `(before, before_id)` to "load earlier".

    The cursor is a (created_at, id) KEYSET, not a bare timestamp — task_messages can share an
    identical `created_at` (bulk insert / coarse clock), and a `created_at < before` cursor would
    silently drop the same-timestamp rows straddling a page boundary (P2, kedar review #180). The
    composite tuple compare makes paging exact regardless of timestamp ties.

    GH #33: the response also carries a `task` header — {title, description, definition_of_done} —
    so a worker woken by a task-thread message that follows "read the thread" sees the FULL task
    body alongside the conversation, not just the message preview. Acceptance criteria living in the
    description / DoD are read before acting, not skipped for the title.
    """
    if not _valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    if before_id is not None and not _valid_uuid(before_id):
        raise HTTPException(400, "before_id is not a valid UUID")
    cols = (
        "m.id AS message_id, m.author_id, ma.alias AS author_alias, "
        "(m.author_id IS NOT NULL AND ma.kind = 'human') AS is_human, m.body, "
        # #301: COALESCE so pre-migration rows surface [] (their column existed only
        # after mig 025; the DEFAULT covers new rows but be explicit for the read path).
        "COALESCE(m.attachments, '[]'::jsonb) AS attachments, m.created_at"
    )
    with db_cursor() as (_, cur):
        _require_task(cur, tid)
        # GH #33: surface the FULL task body in a `task` header so a worker woken by a task-thread
        # message — told to "read the thread" — reads description + definition_of_done before acting,
        # not just the message preview and the title.
        cur.execute(
            "SELECT title, description, definition_of_done FROM tasks WHERE id=%s",
            (tid,),
        )
        _t = cur.fetchone()
        task_hdr = {
            "title": _t["title"],
            "description": _t["description"],
            "definition_of_done": _t["definition_of_done"],
        }
        if limit and limit > 0:
            lim = min(limit, 200)
            params: list[Any] = [tid]
            cursor_clause = ""
            if before and before_id:
                # keyset: strictly older than the (created_at, id) of the oldest loaded row.
                cursor_clause = "AND (m.created_at, m.id) < (%s, %s)"
                params += [before, before_id]
            elif before:
                # back-compat: a bare timestamp cursor (first page never needs one)
                cursor_clause = "AND m.created_at < %s"
                params.append(before)
            cur.execute(
                f"""SELECT {cols}
                   FROM task_messages m LEFT JOIN agents ma ON ma.id = m.author_id
                   WHERE m.task_id = %s {cursor_clause}
                   ORDER BY m.created_at DESC, m.id DESC LIMIT %s""",
                (*params, lim + 1),
            )
            rows = cur.fetchall()  # DESC (newest→oldest)
            has_more = len(rows) > lim
            rows = rows[:lim]
            oldest = (
                rows[-1] if rows else None
            )  # last in DESC = oldest in this page → next cursor
            next_before = (
                oldest["created_at"].isoformat() if (oldest and has_more) else None
            )
            next_before_id = (
                str(oldest["message_id"]) if (oldest and has_more) else None
            )
            rows.reverse()  # ASC within the page (oldest→newest)
            return {
                "task_id": tid,
                "task": task_hdr,
                "messages": rows,
                "has_more": has_more,
                "next_before": next_before,
                "next_before_id": next_before_id,
            }
        cur.execute(
            f"""SELECT {cols}
               FROM task_messages m LEFT JOIN agents ma ON ma.id = m.author_id
               WHERE m.task_id = %s
               ORDER BY m.created_at""",
            (tid,),
        )
        messages = cur.fetchall()
    return {"task_id": tid, "task": task_hdr, "messages": messages}
