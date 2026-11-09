"""One run's timeline, and the device a person sends a waiting run to (`qa_run_log`).

  GET  /api/qa/run-log?task_id=&session_id=&after=   member read, polled by the run pages
  POST /api/qa/sessions/{sid}/use-device             a person only: a run in line takes this device
"""

from __future__ import annotations

from typing import Literal, Optional

from fastapi import HTTPException, Query, Request
from pydantic import BaseModel, Field

from portal_backend import qa_explorations, qa_run_log, qa_store as qs
from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.qa_routes import ActorBody


class QaRunLogEntry(BaseModel):
    id: str = Field(..., description="Stable: a later poll may bring the same line changed")
    at: str
    level: Literal["info", "wait", "warn", "error", "done"]
    kind: str
    text: str = Field(..., description="Plain words")
    detail: Optional[str] = None


class QaRunLogNow(BaseModel):
    state: Literal["waiting", "blocked", "working", "building", "done", "ended"]
    level: Literal["info", "wait", "warn", "error", "done"]
    text: str = Field(..., description="What is true right now, for the headline")
    since: Optional[str] = Field(default=None, description="The elapsed time ticks from here")
    device: Optional[str] = Field(default=None, description="The device it waits for")
    held_by: Optional[str] = None
    session_id: Optional[str] = Field(default=None, description="The session in line for the device")
    free_device: Optional[str] = Field(default=None, description="Another booted device nobody holds")
    moving_to: Optional[str] = Field(default=None, description="A person sent the run to this device")
    request_id: Optional[str] = Field(default=None, description="The question it waits on")


class QaRunLogOut(BaseModel):
    entries: list[QaRunLogEntry]
    cursor: str = Field(..., description="Pass it as `after` on the next poll")
    now: QaRunLogNow
    live: bool = Field(..., description="False once nothing will add to the timeline")
    truncated: bool = Field(..., description="Older lines exist that this answer leaves out")
    task_id: Optional[str] = None
    session_id: Optional[str] = Field(default=None, description="The session to watch, once there is one")
    platform: Optional[str] = None


class QaRunUseDeviceBody(ActorBody):
    device: str = Field(..., min_length=1, max_length=200)


@app.get("/api/qa/run-log", response_model=QaRunLogOut, response_model_exclude_none=True)
def get_qa_run_log(request: Request, task_id: Optional[str] = Query(default=None), session_id: Optional[str] = Query(default=None),
                   after: Optional[str] = Query(default=None, max_length=64)):
    """What a run has done and is doing, oldest line first. Give a task, a session or both (a
    session then decides). Read-only: nothing here takes a write lock."""
    if not task_id and not session_id:
        raise HTTPException(400, "give a task_id or a session_id")
    for value, what in ((task_id, "task_id"), (session_id, "session_id")):
        if value:
            qs.require_uuid(value, what)
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, qa_run_log.container_of(cur, task_id, session_id))
        rows = qa_run_log.read_rows(cur, task_id, session_id, bool(after))
    return qa_run_log.compose(rows, after)


@app.post("/api/qa/sessions/{sid}/use-device")
def use_qa_device(sid: str, body: QaRunUseDeviceBody, request: Request):
    """A run in line for a device takes another one. The session's tool server looks at this when it
    next tries for a device (`QUEUE_RETRY_S`)."""
    with db_cursor() as (conn, cur):
        s = qs.load_session(cur, sid)
        cid = str(s["container_id"])
        who = qs.human(cur, request, cid, body.actor_agent_id, "move a run to another device")
        if not qa_explorations.waits_for(s):
            raise HTTPException(409, "this run is not waiting for a device")
        device = body.device.strip()
        cur.execute("UPDATE qa_sessions SET device_name=%s WHERE id=%s", (device, sid))
        log_event(cur, cid, "human", who["id"], "qa_session", sid, "qa_session_device_picked", {"device": device})
        out = qs.public(qs.load_session(cur, sid))
        conn.commit()
    return out
