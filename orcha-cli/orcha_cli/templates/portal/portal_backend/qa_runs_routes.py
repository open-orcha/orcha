"""Orcha QA run page: one session as a run, read in one document, plus what it records beside its
steps (migration 095, "runs"). Contract: docs/orcha-qa-plan.md, "Run page".

  GET  /api/qa/sessions/{sid}/run          the page's document; polled while the session runs
  POST /api/qa/sessions/{sid}/telemetry    log lines and network calls, idempotent on seq
  GET  /api/qa/sessions/{sid}/logs         log lines past after_seq
  GET  /api/qa/sessions/{sid}/requests     network calls past after_seq
  PUT  /api/qa/sessions/{sid}/feedback     a person's answer to a criterion's verdict
  GET  /api/qa/sessions/{sid}/perf         its screen timings, the screens' history and its calls
  GET  /api/containers/{cid}/qa/live       running sessions and those just ended, as wall tiles
"""

from __future__ import annotations

import datetime as _dt
import re
from typing import Literal, Optional

from fastapi import HTTPException, Query, Request
from pydantic import BaseModel, Field

from portal_backend import qa_explorations, qa_perf, qa_store as qs, sql
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.identity_routes import require_member_read

#: One session keeps at most this many of each; a long crawl must not grow without bound.
MAX_ROWS = 20000
#: Days of a project's other sessions a screen's usual time is read from, and how many samples.
PERF_HISTORY_DAYS = 90
PERF_HISTORY_LIMIT = 800
#: An ended session stays on the live wall this long, showing its result.
WALL_LINGER_S = 120


class LogRow(BaseModel):
    seq: int = Field(..., ge=1)
    step_seq: Optional[int] = Field(default=None, ge=0)
    at_ms: int = Field(default=0, ge=0)
    level: Literal["error", "warn", "info", "debug"] = "info"
    source: Literal["console", "network", "device", "crash"] = "console"
    text: str = Field(..., min_length=1, max_length=8000)
    detail: Optional[dict] = None


class QaRunRequestRow(BaseModel):
    seq: int = Field(..., ge=1)
    step_seq: Optional[int] = Field(default=None, ge=0)
    at_ms: int = Field(default=0, ge=0)
    kind: Literal["fetch", "xhr", "document", "other"] = "fetch"
    method: str = Field(..., min_length=1, max_length=16)
    url: str = Field(..., min_length=1, max_length=4000)
    status: Optional[int] = Field(default=None, ge=0, le=999)
    duration_ms: Optional[int] = Field(default=None, ge=0)
    failure: Optional[str] = Field(default=None, max_length=1000)
    request_body: Optional[str] = Field(default=None, max_length=8000)


class TelemetryBody(BaseModel):
    actor_agent_id: Optional[str] = None
    logs: list[LogRow] = Field(default_factory=list, max_length=1000)
    requests: list[QaRunRequestRow] = Field(default_factory=list, max_length=1000)


class QaRunFeedbackBody(BaseModel):
    actor_agent_id: Optional[str] = None
    scenario_id: str
    criterion_index: int = Field(..., ge=0, le=11)
    status: Literal["not_a_bug", "acknowledged", "resolved"]
    note: Optional[str] = Field(default=None, max_length=4000)


def _read(cur, request: Request, sid: str) -> dict:
    s = qs.load_session(cur, sid)
    require_member_read(cur, request, str(s["container_id"]))
    return s


def _rows(cur, table: str, sid: str, after_seq: int, limit: int) -> list[dict]:
    cur.execute(f"SELECT * FROM {table} WHERE session_id=%s AND seq>%s ORDER BY seq LIMIT %s", (sid, after_seq, limit))
    return [qs.public(r, drop=("container_id", "session_id")) for r in cur.fetchall()]


#: How a task names the scenarios a person picked (Run this scenario, the first run).
PICKED_SCENARIO = re.compile(r"(?:--scenario|Check scenario) ([0-9a-f]{8}-[0-9a-f-]{27})")


def picked_scenarios(cur, task_id: Optional[str]) -> list[str]:
    """The scenarios the session's task names; none means the whole approved suite."""
    if not task_id:
        return []
    cur.execute("SELECT description FROM tasks WHERE id=%s", (str(task_id),))
    row = cur.fetchone()
    return PICKED_SCENARIO.findall((row or {}).get("description") or "")


def scenarios_of(cur, cid: str, verdicts: list[dict], kind: str, platform: str, picked: Optional[list[str]] = None) -> list[dict]:
    """The scenarios this run reports on: every one with a verdict and, for a check run, what it
    set out to check, so one not reached yet shows: the scenarios a person picked, else every
    validated scenario of its platform."""
    ids = sorted({str(v["scenario_id"]) for v in verdicts} | set(picked or []))
    rows: dict[str, dict] = {}
    if ids:
        cur.execute(f"SELECT * FROM qa_scenarios WHERE {sql.in_list('id')}", (sql.list_param(ids),))
        for r in cur.fetchall():
            rows[str(r["id"])] = qs.public(r)
    if kind == "check" and not picked:
        cur.execute("SELECT * FROM qa_scenarios WHERE container_id=%s AND platform=%s AND status='validated' ORDER BY name",
                    (cid, platform))
        for r in cur.fetchall():
            rows.setdefault(str(r["id"]), qs.public(r))
    return list(rows.values())


@app.get("/api/qa/sessions/{sid}/run")
def get_qa_run(sid: str, request: Request):
    """Everything the run page shows of one session, in one read."""
    with db_cursor(readonly=True) as (_, cur):
        qa_cid = str(_read(cur, request, sid)["container_id"])
    qa_explorations.sweep_abandoned(qa_cid)
    with db_cursor(readonly=True) as (_, cur):
        s = _read(cur, request, sid)
        cid = str(s["container_id"])
        detail = qs.session_detail(cur, s)
        cur.execute("SELECT * FROM qa_steps WHERE session_id=%s ORDER BY seq LIMIT %s", (sid, MAX_ROWS))
        steps = [qs.public(r) for r in cur.fetchall()]
        verdicts = _all_verdicts(cur, sid)
        cur.execute("SELECT scenario_id, criterion_index, status, note FROM qa_criterion_feedback WHERE session_id=%s", (sid,))
        feedback = [qs.public(r) for r in cur.fetchall()]
        rows = {k: detail.pop(k) for k in ("walks", "findings", "drafts", "steps_count")}
        detail.pop("verdicts", None)
        return {
            "session": detail,
            **rows,
            "verdicts": verdicts,
            "steps": steps,
            "logs": _rows(cur, "qa_session_logs", sid, 0, 2000),
            "scenarios": scenarios_of(cur, cid, verdicts, s["kind"], s["platform"], picked_scenarios(cur, s.get("task_id"))),
            "feedback": feedback,
        }


def _all_verdicts(cur, sid: str) -> list[dict]:
    """Oldest first: a criterion checked twice ends on its newest verdict."""
    cur.execute("SELECT * FROM qa_verdicts WHERE session_id=%s ORDER BY created_at", (sid,))
    return [qs.public(r) for r in cur.fetchall()]


def _count(cur, table: str, sid: str) -> int:
    cur.execute(f"SELECT count(*) AS n FROM {table} WHERE session_id=%s", (sid,))
    row = cur.fetchone()
    return int(row["n"]) if row else 0


@app.post("/api/qa/sessions/{sid}/telemetry")
def add_qa_telemetry(sid: str, body: TelemetryBody, request: Request):
    """A batch of log lines and network calls. A seq already stored is skipped, never changed (the
    MCP server resends a batch it could not confirm)."""
    with db_cursor() as (conn, cur):
        s = qs.load_session(cur, sid)
        cid = str(s["container_id"])
        qs.actor(cur, request, cid, body.actor_agent_id)
        logs = requests = 0
        if body.logs and _count(cur, "qa_session_logs", sid) < MAX_ROWS:
            for r in body.logs:
                cur.execute(
                    """INSERT INTO qa_session_logs (id, container_id, session_id, seq, step_seq, at_ms, level, source, text, detail)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (session_id, seq) DO NOTHING""",
                    (qs.new_id(), cid, sid, r.seq, r.step_seq, r.at_ms, r.level, r.source, r.text,
                     qs.dumps(r.detail) if r.detail is not None else None),
                )
                logs += max(cur.rowcount, 0)
        if body.requests and _count(cur, "qa_session_requests", sid) < MAX_ROWS:
            for r in body.requests:
                cur.execute(
                    """INSERT INTO qa_session_requests (id, container_id, session_id, seq, step_seq, at_ms, kind, method, url,
                                                        status, duration_ms, failure, request_body)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (session_id, seq) DO NOTHING""",
                    (qs.new_id(), cid, sid, r.seq, r.step_seq, r.at_ms, r.kind, r.method, r.url, r.status,
                     r.duration_ms, r.failure, r.request_body),
                )
                requests += max(cur.rowcount, 0)
        conn.commit()
    return {"logs": logs, "requests": requests}


@app.get("/api/qa/sessions/{sid}/logs")
def list_qa_logs(sid: str, request: Request, after_seq: int = Query(default=0, ge=0), limit: int = Query(default=500, ge=1, le=2000)):
    with db_cursor(readonly=True) as (_, cur):
        _read(cur, request, sid)
        return {"logs": _rows(cur, "qa_session_logs", sid, after_seq, limit)}


@app.get("/api/qa/sessions/{sid}/requests")
def list_qa_requests(sid: str, request: Request, after_seq: int = Query(default=0, ge=0), limit: int = Query(default=2000, ge=1, le=2000)):
    with db_cursor(readonly=True) as (_, cur):
        _read(cur, request, sid)
        return {"requests": _rows(cur, "qa_session_requests", sid, after_seq, limit)}


@app.put("/api/qa/sessions/{sid}/feedback")
def put_qa_feedback(sid: str, body: QaRunFeedbackBody, request: Request):
    """A person's answer to one criterion's verdict. It changes no verdict: an agent never
    certifies, and neither does this; it says how a person read the verdict."""
    with db_cursor() as (conn, cur):
        s = qs.load_session(cur, sid)
        cid = str(s["container_id"])
        who = qs.human(cur, request, cid, body.actor_agent_id, "answer a verdict")
        qs.require_uuid(body.scenario_id, "scenario_id")
        cur.execute("SELECT id FROM qa_scenarios WHERE id=%s AND container_id=%s", (body.scenario_id, cid))
        if not cur.fetchone():
            raise HTTPException(404, "that scenario is not in this project")
        if body.status == "not_a_bug" and not (body.note or "").strip():
            raise HTTPException(400, "say why this is not a bug")
        cur.execute(
            """INSERT INTO qa_criterion_feedback (id, container_id, session_id, scenario_id, criterion_index, status, note, agent_id)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (session_id, scenario_id, criterion_index)
               DO UPDATE SET status=excluded.status, note=excluded.note, agent_id=excluded.agent_id""",
            (qs.new_id(), cid, sid, body.scenario_id, body.criterion_index, body.status, body.note, str(who["id"])),
        )
        conn.commit()
    return {"status": body.status}


def _tile(cur, s: dict) -> dict:
    sid = str(s["id"])
    cur.execute("SELECT seq, kind, args, result, screen_key, frame_id, at FROM qa_steps WHERE session_id=%s ORDER BY seq DESC LIMIT 40", (sid,))
    recent = [qs.public(r) for r in cur.fetchall()]
    frame = next((r for r in recent if r.get("frame_id")), None)
    cur.execute("SELECT severity FROM qa_findings WHERE session_id=%s AND status<>'dismissed'", (sid,))
    findings = [r["severity"] for r in cur.fetchall()]
    cur.execute("SELECT scenario_id, criterion_index, example_row, verdict FROM qa_verdicts WHERE session_id=%s ORDER BY created_at", (sid,))
    latest = {(str(r["scenario_id"]), r["criterion_index"], r["example_row"]): r["verdict"] for r in cur.fetchall()}
    cur.execute("SELECT count(*) AS n FROM qa_steps WHERE session_id=%s", (sid,))
    count = cur.fetchone()
    return {
        "session": qs.public(s),
        "frame_id": frame["frame_id"] if frame else None,
        "last_step": recent[0] if recent else None,
        "steps_count": int(count["n"]) if count else 0,
        "findings": findings,
        "verdicts": list(latest.values()),
    }


@app.get("/api/qa/sessions/{sid}/perf")
def get_qa_run_perf(sid: str, request: Request):
    """The Performance tab's read: this session's samples from its timed steps, the clean samples
    of the same screens from its project's earlier sessions, each screen's frame, its timed actions
    and its network calls. Comparing them is the page's (`buildRunScreens`)."""
    with db_cursor(readonly=True) as (_, cur):
        s = _read(cur, request, sid)
        cid, platform = str(s["container_id"]), str(s["platform"])
        settings = qa_perf.read_settings(cur, cid)
        cur.execute("SELECT session_id, seq, kind, duration_ms, timing, screen_key, at FROM qa_steps WHERE session_id=%s ORDER BY seq", (sid,))
        steps = [{**qs.public(r), "platform": platform, "device_name": s.get("device_name")} for r in cur.fetchall()]
        cur.execute("SELECT key, label, frame_id FROM qa_map_nodes WHERE container_id=%s AND platform=%s AND kind='screen'", (cid, platform))
        nodes = [dict(r) for r in cur.fetchall()]
        labels = {(platform, str(n["key"])): str(n["label"]) for n in nodes if n.get("label")}
        samples = qa_perf.samples_of(steps, labels, settings["load_limit"])
        keys = {x["screen_key"] for x in samples}
        history: list[dict] = []
        if keys:
            window = qa_perf.read_perf(cur, cid, PERF_HISTORY_DAYS, platform)["samples"]
            first = min(x["created_at"] for x in samples)
            past = [x for x in window if x["run_id"] != sid and x["screen_key"] in keys and x["noise"] is None and x["created_at"] < first]
            history = sorted(past, key=lambda x: x["created_at"], reverse=True)[:PERF_HISTORY_LIMIT]
        frames = {str(n["key"]): f"/api/qa/frames/{n['frame_id']}" for n in nodes if n.get("frame_id")}
        return {
            "session": {"status": s["status"], "platform": platform, "device_name": s.get("device_name"), "started_at": qs.iso(s.get("started_at"))},
            "samples": samples,
            "history": history,
            "frames": {k: v for k, v in frames.items() if k in keys},
            "steps": [{k: x.get(k) for k in ("seq", "kind", "duration_ms", "timing", "screen_key", "at")} for x in steps],
            "requests": _rows(cur, "qa_session_requests", sid, 0, 2000),
            "settings": settings,
        }


@app.get("/api/containers/{cid}/qa/live")
def get_qa_live(cid: str, request: Request, platform: Optional[str] = Query(default=None)):
    """The live wall's one poll: what is running now and what ended a moment ago."""
    if platform is not None:
        qs.require_platform(platform)
    qa_explorations.sweep_abandoned(cid)
    since = qs.now() - _dt.timedelta(seconds=WALL_LINGER_S)
    q, args = "SELECT * FROM qa_sessions WHERE container_id=%s AND (status='running' OR ended_at>=%s)", [cid, since]
    if platform is not None:
        q += " AND platform=%s"
        args.append(platform)
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
        cur.execute(q + " ORDER BY started_at DESC LIMIT 60", tuple(args))
        rows = cur.fetchall()
        tiles = [_tile(cur, r) for r in rows]
        names = qs.with_names(cur, [t["session"] for t in tiles])
        for t, named in zip(tiles, names):
            t["session"] = named
        return {"tiles": tiles}
