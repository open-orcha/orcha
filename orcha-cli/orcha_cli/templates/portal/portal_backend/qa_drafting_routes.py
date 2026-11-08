"""Orcha QA drafting routes (migration 095; contract: docs/orcha-qa-plan.md, "Drafting").

  GET  /api/containers/{cid}/qa/drafting/sources   what a drafting can read (the Run QA source picker)
  GET  /api/qa/sessions/{sid}/drafting             the drafting page's read: the board, the explorers of
                                                   its task, the activity, every draft's evidence
  POST /api/qa/sessions/{sid}/messages             what a drafter says (notes, files, plan, drafts, revisions)
  POST /api/qa/sessions/{sid}/requests             a drafter asks the explorer of its task
  POST /api/qa/sessions/{sid}/requests/next        the explorer claims the oldest waiting request
  POST /api/qa/requests/{mid}/answer               the explorer answers it
  POST /api/qa/scenarios/{scid}/feedback           a person's feedback on a draft (a person only)

Reads are for members. Writes carry actor_agent_id (trusted_actor). Accepting or discarding a draft
is the scenario status route (qa_routes.py), a person only; nothing here changes a status.
"""

from __future__ import annotations

from typing import Literal, Optional

from fastapi import HTTPException, Query, Request
from pydantic import BaseModel, Field

from portal_backend import qa_drafting as qd
from portal_backend import qa_store as qs
from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.identity_routes import require_member_read


class ActorBody(BaseModel):
    actor_agent_id: Optional[str] = None


class MessageIn(BaseModel):
    kind: Literal["note", "read", "search", "draft", "plan", "correction"]
    title: str = Field(..., min_length=1, max_length=2000)
    body: dict = Field(default_factory=dict)
    scenario_id: Optional[str] = None
    frame_id: Optional[str] = None


class MessagesBody(ActorBody):
    messages: list[MessageIn] = Field(..., min_length=1, max_length=200)


class AskBody(ActorBody):
    question: str = Field(..., min_length=1, max_length=1000)
    flow: Optional[str] = Field(default=None, max_length=200)


class AnswerBody(ActorBody):
    session_id: str
    answer: str = Field(..., min_length=1, max_length=2000)
    frame_id: Optional[str] = None
    found: bool = True


class QaDraftFeedbackBody(ActorBody):
    text: str = Field(..., min_length=1, max_length=2000)


def _session_in(cur, request: Request, sid: str, actor_id: Optional[str]) -> tuple[dict, dict]:
    s = qs.load_session(cur, sid)
    return s, qs.actor(cur, request, str(s["container_id"]), actor_id)


def _screen_name(cur, frame_id: str) -> Optional[str]:
    cur.execute("SELECT args FROM qa_steps WHERE frame_id=%s AND kind='screen' ORDER BY seq LIMIT 1", (frame_id,))
    row = cur.fetchone()
    return (qs._json(row["args"], {}).get("title") or None) if row else None


@app.get("/api/containers/{cid}/qa/drafting/sources")
def qa_drafting_sources(cid: str, request: Request):
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
        return qd.sources_summary(cur, cid)


@app.get("/api/qa/sessions/{sid}/drafting")
def qa_drafting_board(sid: str, request: Request, labels: bool = Query(default=False)):
    """Polled. A request past its time is written back, in its own short write: the board itself
    is read with no lock held."""
    with db_cursor(readonly=True) as (_, cur):
        s = qs.load_session(cur, sid)
        require_member_read(cur, request, str(s["container_id"]))
        if s["kind"] != "draft":
            raise HTTPException(409, "this is not a drafting session")
        late = qd.requests_past_time(cur, [sid])
    if late:
        with db_cursor() as (conn, cur):
            qd.sweep_requests(cur, [sid])
            conn.commit()
    with db_cursor(readonly=True) as (_, cur):
        return qd.board(cur, s, labels, sweep=False)


@app.post("/api/qa/sessions/{sid}/messages", status_code=201)
def post_qa_messages(sid: str, body: MessagesBody, request: Request):
    """Recorded in order. A revision may land after its session ended; the rest need it running."""
    with db_cursor() as (conn, cur):
        s, who = _session_in(cur, request, sid, body.actor_agent_id)
        if s["status"] != "running" and any(m.kind != "correction" for m in body.messages):
            raise HTTPException(409, f"this QA session is {s['status']}")
        rows = []
        for m in body.messages:
            if m.frame_id:
                qs.require_frames_in(cur, str(s["container_id"]), [m.frame_id])
            if m.scenario_id and str(qs.load_scenario(cur, m.scenario_id)["container_id"]) != str(s["container_id"]):
                raise HTTPException(403, "that scenario belongs to another project")
            extra = dict(m.body)
            if m.kind == "correction" and m.frame_id:
                extra["screen_name"] = _screen_name(cur, m.frame_id)
            rows.append(qd.add_message(cur, s, who, m.kind, m.title, body=extra, scenario_id=m.scenario_id, frame_id=m.frame_id))
        conn.commit()
    return {"messages": rows}


@app.post("/api/qa/sessions/{sid}/requests", status_code=201)
def ask_qa_explorer(sid: str, body: AskBody, request: Request):
    with db_cursor() as (conn, cur):
        s, who = _session_in(cur, request, sid, body.actor_agent_id)
        if s["status"] != "running":
            raise HTTPException(409, f"this QA session is {s['status']}")
        out = qd.ask(cur, s, who, body.question, body.flow)
        conn.commit()
    return out


@app.post("/api/qa/sessions/{sid}/requests/next")
def next_qa_request(sid: str, body: ActorBody, request: Request):
    with db_cursor() as (conn, cur):
        s, who = _session_in(cur, request, sid, body.actor_agent_id)
        out = qd.next_request(cur, s, who)
        conn.commit()
    return {"request": out}


@app.post("/api/qa/requests/{mid}/answer", status_code=201)
def answer_qa_request(mid: str, body: AnswerBody, request: Request):
    with db_cursor() as (conn, cur):
        req = qd.load_message(cur, mid)
        s, who = _session_in(cur, request, body.session_id, body.actor_agent_id)
        if str(s["container_id"]) != str(req["container_id"]):
            raise HTTPException(403, "that request belongs to another project")
        if body.frame_id:
            qs.require_frames_in(cur, str(s["container_id"]), [body.frame_id])
        out = qd.answer(cur, req, s, who, body.answer, body.frame_id, body.found)
        conn.commit()
    return out


@app.post("/api/qa/scenarios/{scid}/feedback", status_code=201)
def post_qa_feedback(scid: str, body: QaDraftFeedbackBody, request: Request):
    """What a person wants changed in a draft; it is kept with the session that drafted it."""
    with db_cursor() as (conn, cur):
        row = qs.load_scenario(cur, scid)
        cid = str(row["container_id"])
        who = qs.human(cur, request, cid, body.actor_agent_id, "give feedback on a draft")
        if not row.get("session_id"):
            raise HTTPException(409, "this scenario has no drafting session")
        s = qs.load_session(cur, str(row["session_id"]))
        out = qd.add_message(cur, s, who, "feedback", " ".join(body.text.split()), scenario_id=scid)
        log_event(cur, cid, "human", who["id"], "qa_scenario", scid, "qa_scenario_feedback", {"text": body.text[:200]})
        conn.commit()
    return out
