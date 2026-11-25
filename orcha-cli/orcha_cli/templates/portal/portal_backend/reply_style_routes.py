"""Reply style (mig 102 / sqlite 032): how agents write to people.

One choice per project — ``normal`` (default), ``caveman`` or ``asd_ste100`` — set in Project
settings. A conversation or a task thread can override it from the composer chip; ``null``
clears the override so the thread follows the project again. The notifier reads all three
values from ``GET /api/agents/{aid}/protocol`` (``reply_style``) on every wake and adds the
chosen style's rules to the agent prompt (orcha_cli/notifier_reply_style.py).

  GET /api/containers/{cid}/reply-style           project setting (any member)
  PUT /api/containers/{cid}/reply-style           change it (owner or manage_agents)
  GET /api/conversations/{conv_id}/reply-style    override + project + effective style
  PUT /api/conversations/{conv_id}/reply-style    set / clear the override (any human member)
  GET /api/tasks/{tid}/reply-style                override + project + effective style
  PUT /api/tasks/{tid}/reply-style                set / clear the override (any human member)

Every change is logged as a ``reply_style_changed`` project event.
"""

from __future__ import annotations

from typing import Literal, Optional

from fastapi import HTTPException, Request
from pydantic import BaseModel, Field

from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container, require_kind, valid_uuid
from portal_backend.identity_routes import (
    enforce_grant,
    require_member_read,
    trusted_actor,
)
from portal_backend.reply_style import clean_style, project_style

SETTINGS_GRANT = "manage_agents"

ReplyStyle = Literal["normal", "caveman", "asd_ste100"]

_STYLE_HELP = ("normal: no style rules (default). caveman: terse, filler-free, fragments OK. "
               "asd_ste100: ASD-STE100 Simplified Technical English.")


# ------------------------------------------------------------------ models

class ProjectReplyStyle(BaseModel):
    container_id: str
    reply_style: ReplyStyle = Field(description=_STYLE_HELP)


class ProjectReplyStyleUpdate(BaseModel):
    reply_style: ReplyStyle = Field(description=_STYLE_HELP)
    actor_agent_id: Optional[str] = Field(default=None, description="The human making the change")


class ThreadReplyStyle(BaseModel):
    thread_kind: Literal["conversation", "task"]
    thread_id: str
    container_id: str
    override: Optional[ReplyStyle] = Field(
        default=None, description="This thread's own style; null follows the project setting")
    project_reply_style: ReplyStyle
    effective_reply_style: ReplyStyle = Field(
        description="The style agents use on this thread: the override, else the project setting")


class ThreadReplyStyleUpdate(BaseModel):
    reply_style: Optional[ReplyStyle] = Field(
        description="The thread's style, or null to follow the project setting again")
    actor_agent_id: Optional[str] = Field(default=None, description="The human making the change")


# ------------------------------------------------------------------ helpers

def _valid(kind: str, value: str) -> str:
    if not valid_uuid(value):
        raise HTTPException(400, f"{kind} is not a valid UUID")
    return value


def _human_member(cur, request, cid, claimed) -> str:
    """The acting human: the trusted proxy identity when present, else the body actor, which
    must be a live human of this project. Viewers are refused (trusted_actor)."""
    actor = trusted_actor(cur, request, cid, claimed)
    require_kind(cur, actor, ("human",))
    cur.execute("SELECT 1 FROM agents WHERE id=%s AND container_id=%s AND terminated_at IS NULL",
                (actor, cid))
    if not cur.fetchone():
        raise HTTPException(403, "actor is not a live member of this project")
    return actor


def _thread_row(cur, kind: str, thread_id: str):
    table = "conversations" if kind == "conversation" else "tasks"
    cur.execute(f"SELECT id, container_id, reply_style FROM {table} WHERE id=%s", (thread_id,))
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, f"{kind} {thread_id} not found")
    return row


def _thread_out(cur, kind: str, row) -> dict:
    cid = str(row["container_id"])
    project = project_style(cur, cid)
    override = clean_style(row["reply_style"])
    return {"thread_kind": kind, "thread_id": str(row["id"]), "container_id": cid,
            "override": override, "project_reply_style": project,
            "effective_reply_style": override or project}


def _get_thread(kind: str, thread_id: str, request: Request) -> dict:
    with db_cursor() as (_, cur):
        row = _thread_row(cur, kind, thread_id)
        require_member_read(cur, request, str(row["container_id"]))
        return _thread_out(cur, kind, row)


def _put_thread(kind: str, thread_id: str, body: ThreadReplyStyleUpdate, request: Request) -> dict:
    table = "conversations" if kind == "conversation" else "tasks"
    with db_cursor() as (conn, cur):
        row = _thread_row(cur, kind, thread_id)
        cid = str(row["container_id"])
        actor = _human_member(cur, request, cid, body.actor_agent_id)
        before = clean_style(row["reply_style"])
        after = body.reply_style
        cur.execute(f"UPDATE {table} SET reply_style=%s WHERE id=%s", (after, thread_id))
        if after != before:
            log_event(cur, cid, "human", actor, kind, thread_id, "reply_style_changed",
                      {"scope": kind, "before": before, "after": after})
        conn.commit()
        row = _thread_row(cur, kind, thread_id)
        return _thread_out(cur, kind, row)


# ------------------------------------------------------------------ project setting

@app.get("/api/containers/{cid}/reply-style", response_model=ProjectReplyStyle)
def get_project_reply_style(cid: str, request: Request):
    """The project's reply style: how agents write every message to a person."""
    _valid("container_id", cid)
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        require_member_read(cur, request, cid)
        return {"container_id": cid, "reply_style": project_style(cur, cid)}


@app.put("/api/containers/{cid}/reply-style", response_model=ProjectReplyStyle)
def put_project_reply_style(cid: str, body: ProjectReplyStyleUpdate, request: Request):
    """Set the project's reply style (owner or manage_agents). Agents use it from their next
    wake on every conversation and task thread that has no override of its own."""
    _valid("container_id", cid)
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        enforce_grant(cur, request, cid, SETTINGS_GRANT)
        actor = _human_member(cur, request, cid, body.actor_agent_id)
        before = project_style(cur, cid)
        cur.execute("UPDATE containers SET reply_style=%s WHERE id=%s", (body.reply_style, cid))
        if body.reply_style != before:
            log_event(cur, cid, "human", actor, "container", cid, "reply_style_changed",
                      {"scope": "project", "before": before, "after": body.reply_style})
        conn.commit()
    return {"container_id": cid, "reply_style": body.reply_style}


# ------------------------------------------------------------------ per-thread overrides

@app.get("/api/conversations/{conv_id}/reply-style", response_model=ThreadReplyStyle)
def get_conversation_reply_style(conv_id: str, request: Request):
    """This conversation's style override (null = follows the project) and the style in use."""
    return _get_thread("conversation", _valid("conversation_id", conv_id), request)


@app.put("/api/conversations/{conv_id}/reply-style", response_model=ThreadReplyStyle)
def put_conversation_reply_style(conv_id: str, body: ThreadReplyStyleUpdate, request: Request):
    """Set this conversation's style, or send null to follow the project setting again."""
    return _put_thread("conversation", _valid("conversation_id", conv_id), body, request)


@app.get("/api/tasks/{tid}/reply-style", response_model=ThreadReplyStyle)
def get_task_reply_style(tid: str, request: Request):
    """This task thread's style override (null = follows the project) and the style in use."""
    return _get_thread("task", _valid("task_id", tid), request)


@app.put("/api/tasks/{tid}/reply-style", response_model=ThreadReplyStyle)
def put_task_reply_style(tid: str, body: ThreadReplyStyleUpdate, request: Request):
    """Set this task thread's style, or send null to follow the project setting again."""
    return _put_thread("task", _valid("task_id", tid), body, request)
