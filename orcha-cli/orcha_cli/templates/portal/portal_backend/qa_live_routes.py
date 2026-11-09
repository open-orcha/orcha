"""The live device view of a running QA session: its newest frame, and a person driving it.

How it runs: `orcha qa mcp` is a stdio child of the agent on the developer's machine; the portal
is a separate process (native, in a Docker container, or remote) that the tool server reaches at
`api_base_url`. Nothing guarantees the opposite direction, so the tool server pushes and the page
polls: one route answers the page's poll, one takes the latest frame, one is the tool server's
beat. A Docker or remote portal could not open a stream back to the tool server.

Frames are held here in memory, latest only, one per running session, and dropped when the
session ends or goes quiet: no row and no file, so a session cannot grow the disk. The portal
serves one process (no `--workers`, native or Docker), which is what makes memory enough; on a
restart the next frame fills it again.

  GET    /api/qa/sessions/{sid}/live                 member read: what the page polls
  GET    /api/qa/sessions/{sid}/live/frame           member read: the newest JPEG
  PUT    /api/qa/sessions/{sid}/live/frame           the tool server: raw image/jpeg, <= 2 MB
  POST   /api/qa/sessions/{sid}/live/beat            the tool server: alive, results; answers the inputs
  DELETE /api/qa/sessions/{sid}/live                 the tool server: the session ended
  POST   /api/qa/sessions/{sid}/live/takeover        a person only: {on, still?}
  POST   /api/qa/sessions/{sid}/live/input           a person only, the one who took over

A person takes the device over: the tool server holds the agent's next action and plays their
inputs between its steps, until they hand it back (or leave: `TAKEOVER_GONE_S`, `TAKEOVER_IDLE_S`).
Inputs live in memory too. The steps they become are recorded by the tool server, typed text left
out; what is read back here never carries it either.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Literal, Optional

from fastapi import HTTPException, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from portal_backend import qa_store as qs
from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.qa_routes import ActorBody, _running, _session_in, _session_read

MAX_LIVE_FRAME_BYTES = 2 * 1024 * 1024
#: At most this many sessions are held; the one quiet the longest goes first.
MAX_LIVE_SESSIONS = 64
#: A session that has not been heard from in this long is forgotten.
LIVE_FORGET_S = 15 * 60
#: Without a beat for this long the tool server is gone: nothing can play an input.
BEAT_GONE_S = 20.0
#: The page of the person driving says it is there every `HEARTBEAT_MS` (15 s).
TAKEOVER_GONE_S = 60.0
#: A takeover with no input for this long ends on its own, as an idle recording does.
TAKEOVER_IDLE_S = 10 * 60
MAX_QUEUED_INPUTS = 200
#: How many played inputs the page can read back.
KEPT_INPUTS = 50
MAX_TYPED_CHARS = 2000
MAX_COORD = 20000
INPUT_KEYS = ("home", "back", "enter", "escape", "tab", "backspace", "recent", "lock", "siri", "side")


@dataclass
class _Live:
    cid: str
    frame: Optional[bytes] = None
    n: int = 0
    cmd_seq: int = 0
    at_ms: int = 0
    screen_w: Optional[int] = None
    screen_h: Optional[int] = None
    stream: bool = False
    steps: int = 0
    heard: float = 0.0  # any call from the tool server
    beat: float = float("-inf")  # the last beat
    active: float = 0.0  # the screen or the step count last moved
    takeover: Optional[dict[str, Any]] = None
    watched: float = 0.0
    last_input: float = 0.0
    made: int = 0  # inputs during this takeover
    notice: Optional[str] = None  # why the last takeover ended on its own
    next_seq: int = 1
    queued: deque = field(default_factory=deque)
    inputs: deque = field(default_factory=lambda: deque(maxlen=KEPT_INPUTS))


_LIVE: dict[str, _Live] = {}
_LOCK = threading.Lock()
_clock = time.monotonic


def _forget(sid: str) -> None:
    with _LOCK:
        _LIVE.pop(sid, None)


def _state(sid: str, cid: str) -> _Live:
    """The session's state, made on first use; old ones go. Call with `_LOCK` held."""
    now = _clock()
    for k in [k for k, v in _LIVE.items() if now - v.heard > LIVE_FORGET_S]:
        del _LIVE[k]
    st = _LIVE.get(sid)
    if st is None:
        if len(_LIVE) >= MAX_LIVE_SESSIONS:
            del _LIVE[min(_LIVE, key=lambda k: _LIVE[k].heard)]
        st = _LIVE[sid] = _Live(cid=cid, heard=now, active=now)
    return st


def _age_ms(then: float) -> int:
    return max(0, int((_clock() - then) * 1000))


def _idle_line(minutes: int, inputs: int) -> str:
    return (f"Ended after {minutes} minute{'' if minutes == 1 else 's'} idle. "
            f"Your {inputs} input{' was' if inputs == 1 else 's were'} kept.")


def _lapse(st: _Live) -> None:
    """A takeover whose person left or stopped: the agent gets the device back."""
    if st.takeover is None:
        return
    now = _clock()
    if now - st.watched > TAKEOVER_GONE_S:
        st.notice = "The device went back to the agent: the page driving it closed."
    elif now - st.last_input > TAKEOVER_IDLE_S:
        st.notice = _idle_line(TAKEOVER_IDLE_S // 60, st.made)
    else:
        return
    st.takeover = None
    st.queued.clear()


def _public_input(row: dict[str, Any]) -> dict[str, Any]:
    args = dict(row["args"])
    if "text" in args:  # what a person typed is never read back
        args = {"chars": len(str(args["text"]))}
    return {"seq": row["seq"], "kind": row["kind"], "args": args, "status": row["status"], "result": row["result"]}


# ---------------------------------------------------------------- the page

@app.get("/api/qa/sessions/{sid}/live")
def get_qa_live(sid: str, request: Request):
    """Polled by the page. `n` changes with the frame; `activity_age_ms` is how long nothing has
    moved. A session that ended has its frame dropped and answers its status with `n: 0`."""
    with db_cursor(readonly=True) as (_, cur):
        s = _session_read(cur, request, sid)
    out: dict[str, Any] = {"status": s["status"], "n": 0, "cmd_seq": 0, "at": None, "activity_age_ms": None, "beat_age_ms": None,
                           "stream": False, "screen_w": None, "screen_h": None, "takeover": None, "inputs": [], "notice": None}
    if s["status"] != "running":
        _forget(sid)
        return out
    with _LOCK:
        st = _LIVE.get(sid)
        if st is None:
            return out
        _lapse(st)
        out.update({"n": st.n, "cmd_seq": st.cmd_seq, "at": st.at_ms or None, "activity_age_ms": _age_ms(st.active),
                    "beat_age_ms": None if st.beat == float("-inf") else _age_ms(st.beat), "stream": st.stream,
                    "screen_w": st.screen_w, "screen_h": st.screen_h, "takeover": st.takeover, "notice": st.notice,
                    "inputs": [_public_input(r) for r in st.inputs]})
    return out


@app.get("/api/qa/sessions/{sid}/live/frame")
def get_qa_live_frame(sid: str, request: Request):
    with db_cursor(readonly=True) as (_, cur):
        _session_read(cur, request, sid)
    with _LOCK:
        st = _LIVE.get(sid)
        frame = st.frame if st else None
    if frame is None:
        raise HTTPException(404, "this session has no live frame")
    return Response(content=frame, media_type=qs.FRAME_TYPE,
                    headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline"})


# ---------------------------------------------------------------- the tool server

@app.put("/api/qa/sessions/{sid}/live/frame", status_code=200)
async def put_qa_live_frame(sid: str, request: Request,
                            actor_agent_id: Optional[str] = Query(default=None),
                            cmd_seq: int = Query(default=0, ge=0),
                            screen_w: Optional[int] = Query(default=None, ge=1, le=MAX_COORD),
                            screen_h: Optional[int] = Query(default=None, ge=1, le=MAX_COORD)):
    """Raw `image/jpeg` body, at most 2 MB. Replaces the session's frame → {n}. 409 once the
    session ended: the tool server stops sending."""
    ctype = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if ctype != qs.FRAME_TYPE:
        raise HTTPException(415, "a frame is sent as a raw image/jpeg body")
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_LIVE_FRAME_BYTES:
        raise HTTPException(413, "a live frame is at most 2 MB")
    data = bytearray()
    async for chunk in request.stream():
        data += chunk
        if len(data) > MAX_LIVE_FRAME_BYTES:
            raise HTTPException(413, "a live frame is at most 2 MB")
    if bytes(data[:3]) != b"\xff\xd8\xff":
        raise HTTPException(400, "the body is not a JPEG image")
    return await run_in_threadpool(_keep_frame, sid, request, actor_agent_id, bytes(data), cmd_seq, screen_w, screen_h)


def _keep_frame(sid: str, request: Request, actor_agent_id: Optional[str], data: bytes, cmd_seq: int,
                screen_w: Optional[int], screen_h: Optional[int]) -> dict:
    with db_cursor(readonly=True) as (_, cur):
        s, _who = _session_in(cur, request, sid, actor_agent_id)
    _running(s)
    with _LOCK:
        st = _state(sid, str(s["container_id"]))
        now = _clock()
        st.frame, st.n, st.at_ms = data, st.n + 1, int(time.time() * 1000)
        st.cmd_seq = max(st.cmd_seq, cmd_seq)
        st.heard = st.active = now
        if screen_w and screen_h:
            st.screen_w, st.screen_h = screen_w, screen_h
        return {"n": st.n}


class InputResult(BaseModel):
    seq: int = Field(..., ge=1)
    ok: bool = True
    result: Optional[str] = Field(default=None, max_length=500)


class BeatBody(ActorBody):
    cmd_seq: Optional[int] = Field(default=None, ge=0)
    steps: Optional[int] = Field(default=None, ge=0, description="The session's step count: agent activity with no new frame")
    stream: Optional[bool] = Field(default=None, description="Whether the device is streaming its screen, or only each step's frame comes")
    screen_w: Optional[int] = Field(default=None, ge=1, le=MAX_COORD, description="Screen width in the units inputs use")
    screen_h: Optional[int] = Field(default=None, ge=1, le=MAX_COORD)
    results: list[InputResult] = Field(default_factory=list, max_length=MAX_QUEUED_INPUTS, description="Inputs played since the last beat")


@app.post("/api/qa/sessions/{sid}/live/beat")
def qa_live_beat(sid: str, body: BeatBody, request: Request):
    """→ {takeover, inputs}: who is driving (null: the agent) and the inputs to play now, each
    handed out once. 409 once the session ended."""
    with db_cursor(readonly=True) as (_, cur):
        s, _who = _session_in(cur, request, sid, body.actor_agent_id)
    _running(s)
    with _LOCK:
        st = _state(sid, str(s["container_id"]))
        now = _clock()
        st.heard = st.beat = now
        if body.cmd_seq is not None:
            st.cmd_seq = max(st.cmd_seq, body.cmd_seq)
        if body.steps is not None and body.steps != st.steps:
            st.steps, st.active = body.steps, now
        if body.stream is not None:
            st.stream = body.stream
        if body.screen_w and body.screen_h:
            st.screen_w, st.screen_h = body.screen_w, body.screen_h
        by_seq = {r["seq"]: r for r in st.inputs}
        for res in body.results:
            row = by_seq.get(res.seq)
            if row is not None:
                row["status"], row["result"] = ("done" if res.ok else "failed"), res.result
                st.active = now
        _lapse(st)
        out = [{"seq": r["seq"], "kind": r["kind"], "args": r["args"]} for r in st.queued]
        for r in st.queued:
            r["status"] = "sent"
        st.queued.clear()
        return {"takeover": st.takeover, "inputs": out}


@app.delete("/api/qa/sessions/{sid}/live", status_code=204)
def end_qa_live(sid: str, request: Request, actor_agent_id: Optional[str] = Query(default=None)):
    """Drops what is held of the session (also what an ended session's next read does)."""
    with db_cursor(readonly=True) as (_, cur):
        _session_in(cur, request, sid, actor_agent_id)
    _forget(sid)
    return Response(status_code=204)


# ---------------------------------------------------------------- a person driving

class TakeoverBody(ActorBody):
    on: bool
    still: bool = Field(default=False, description="The driving page's heartbeat: never starts a takeover that has lapsed")


@app.post("/api/qa/sessions/{sid}/live/takeover")
def qa_live_takeover(sid: str, body: TakeoverBody, request: Request):
    """`on: true` holds the agent after its current step and gives the device to this person (409
    while another person has it, or when no tool server is there to play inputs). With `still: true`
    it only says the page is there: a takeover that lapsed stays over, so a page left open cannot
    take the device back. `on: false` hands the device back to the agent."""
    with db_cursor() as (conn, cur):
        s = qs.load_session(cur, sid)
        cid = str(s["container_id"])
        who = qs.human(cur, request, cid, body.actor_agent_id, "take over a QA device")
        _running(s)
        with _LOCK:
            st = _LIVE.get(sid)
            if st is not None:
                _lapse(st)
            event = None
            if body.on and body.still:
                if st is not None and st.takeover is not None and st.takeover["by_id"] == who["id"]:
                    st.watched = _clock()
            elif body.on:
                if st is None or _clock() - st.beat > BEAT_GONE_S:
                    raise HTTPException(409, "the session's tool server is not answering, so nothing can play your inputs")
                held = st.takeover
                if held is not None and held["by_id"] != who["id"]:
                    raise HTTPException(409, f"{held['by']} is driving this device")
                if held is None:
                    st.takeover = {"by_id": who["id"], "by": who["alias"], "since": qs.iso(qs.now())}
                    st.last_input, st.made, st.notice = _clock(), 0, None
                    event = "qa_takeover_started"
                st.watched = _clock()
            elif st is not None and st.takeover is not None:
                st.takeover = None  # inputs made before this still play
                event = "qa_takeover_ended"
            out = {"takeover": st.takeover if st is not None else None}
        if event:
            log_event(cur, cid, "human", who["id"], "qa_session", sid, event, {"platform": s["platform"], "kind": s["kind"]})
            conn.commit()
    return out


class InputBody(ActorBody):
    kind: Literal["tap", "long_press", "swipe", "type", "press", "open_url"]
    args: dict[str, Any] = Field(default_factory=dict, description=(
        "tap: {x, y}. long_press: {x, y, duration_ms?}. swipe: {x1, y1, x2, y2, duration_ms?}, {x, y, dx, dy} for a "
        "wheel scroll, or {direction}. type: {text}. press: {key}. open_url: {url}. Points are in the screen units `GET live` gives."))


def _number(args: dict[str, Any], key: str, low: float, high: float) -> int:
    value = args.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high:
        raise HTTPException(422, f"{key} must be a number from {low:g} to {high:g}")
    return int(value)


def _clean_args(kind: str, args: dict[str, Any]) -> dict[str, Any]:
    """Only what the input needs, checked: the tool server plays this on a real device."""
    out: dict[str, Any] = {}
    if "duration_ms" in args:
        out["duration_ms"] = _number(args, "duration_ms", 1, 10_000)
    if kind in ("tap", "long_press"):
        return {**out, "x": _number(args, "x", 0, MAX_COORD), "y": _number(args, "y", 0, MAX_COORD)}
    if kind == "swipe":
        if "direction" in args:
            if args["direction"] not in ("up", "down", "left", "right"):
                raise HTTPException(422, "direction must be up, down, left or right")
            return {"direction": args["direction"]}
        if "dx" in args or "dy" in args:
            return {**out, "x": _number(args, "x", 0, MAX_COORD), "y": _number(args, "y", 0, MAX_COORD),
                    "dx": _number(args, "dx", -MAX_COORD, MAX_COORD), "dy": _number(args, "dy", -MAX_COORD, MAX_COORD)}
        return {**out, **{k: _number(args, k, 0, MAX_COORD) for k in ("x1", "y1", "x2", "y2")}}
    if kind == "press":
        if args.get("key") not in INPUT_KEYS:
            raise HTTPException(422, f"key must be one of {', '.join(INPUT_KEYS)}")
        return {"key": args["key"]}
    text = args.get("url" if kind == "open_url" else "text")
    if not isinstance(text, str) or not text or len(text) > MAX_TYPED_CHARS:
        raise HTTPException(422, f"{'url' if kind == 'open_url' else 'text'} must be 1 to {MAX_TYPED_CHARS} characters")
    if kind == "open_url":
        if not text.lower().startswith(("http://", "https://")):
            raise HTTPException(422, "url must be an http(s) address")
        return {"url": text}
    return {"text": text}


@app.post("/api/qa/sessions/{sid}/live/input", status_code=201)
def qa_live_input(sid: str, body: InputBody, request: Request):
    """One input of the person driving → {seq, status}. Queued for the tool server, which plays
    them in order between the agent's steps. The screen shows the result."""
    args = _clean_args(body.kind, body.args)
    with db_cursor(readonly=True) as (_, cur):
        s = qs.load_session(cur, sid)
        who = qs.human(cur, request, str(s["container_id"]), body.actor_agent_id, "drive a QA device")
    _running(s)
    with _LOCK:
        st = _LIVE.get(sid)
        if st is not None:
            _lapse(st)
        if st is None or st.takeover is None or st.takeover["by_id"] != who["id"]:
            raise HTTPException(409, "take over the device first")
        if len(st.queued) >= MAX_QUEUED_INPUTS:
            raise HTTPException(429, "too many inputs are waiting")
        row = {"seq": st.next_seq, "kind": body.kind, "args": args, "status": "pending", "result": None}
        st.next_seq += 1
        st.queued.append(row)
        st.inputs.append(row)
        st.last_input = _clock()
        st.made += 1
        return _public_input(row)
