"""Orcha QA exploration routes (migration 095; the store is qa_explorations).

Person only (like approving a scenario):
  PATCH /api/qa/sessions/{sid}/keep                rename, notes, archive, pin
  POST  /api/qa/sessions/{sid}/again               queue the same work, in the same series
  POST  /api/qa/sessions/{sid}/duplicate           queue a copy, as a new series
  POST  /api/containers/{cid}/qa/sessions/queue    a session waiting for the task Run QA created
  PATCH /api/qa/findings/{fid}/severity            change a finding's severity, say why
Members:
  POST  /api/qa/findings/{fid}/scenario            draft the finding's one scenario (draft only)
  POST  /api/qa/sessions/{sid}/measured            the audit's measurements of a screen
  GET   /api/containers/{cid}/qa/app-model         the App model, newest or ?version=

Nothing here changes a task's status or validates a scenario.
"""

from __future__ import annotations

from typing import Annotated, Literal, Optional

from fastapi import HTTPException, Query, Request
from pydantic import BaseModel, Field

from portal_backend import qa_explorations as qx
from portal_backend import qa_conditions
from portal_backend.qa_conditions import Conditions
from portal_backend import qa_handoff, qa_run_tasks
from portal_backend import qa_scenarios, qa_store as qs
from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.limits import MAX_DESC_LEN

Platform = Literal["ios", "android", "web"]
Kind = Literal["map", "explore", "draft", "check"]
Criterion = Annotated[str, Field(min_length=1, max_length=1000)]

SKILL = {"map": "orcha-qa-map", "explore": "orcha-qa-explore", "draft": "orcha-qa-draft", "check": "orcha-qa-check"}
DOD = {
    "map": "The app is mapped; its features and screens (seen, not reached yet, or blocked with why) are in the QA tab's Map.",
    "explore": "The app is explored; findings, walked flows and draft scenarios are in the QA tab for review.",
    "draft": "Draft scenarios that meet the test-design bar are in the QA tab for a person to approve.",
    "check": "Every approved scenario has a verdict per criterion with screenshots; failures are reported as findings.",
}
TIMED = ("map", "explore")


class Actor(BaseModel):
    actor_agent_id: Optional[str] = None


class ContinueBody(Actor):
    minutes: int = Field(default=20, ge=0, le=480, description="Extra minutes; 0 means no limit")


class KeepBody(Actor):
    name: Optional[str] = Field(default=None, max_length=120, description="Empty goes back to the computed name")
    notes: Optional[str] = Field(default=None, max_length=4000)
    archived: Optional[bool] = None
    pinned: Optional[bool] = None


class QueueBody(Actor):
    kind: Kind
    platform: Platform
    task_id: str
    goal: Optional[str] = Field(default=None, max_length=4000)
    budget_minutes: Optional[int] = Field(default=None, ge=0, le=480, description="Minutes; 0 means no limit")
    agent_id: Optional[str] = None
    draft_sources: Optional[Literal["code", "exploration", "both"]] = None
    conditions: Optional[Conditions] = None


class SeverityBody(Actor):
    severity: Literal["blocker", "major", "minor", "trivial"]
    reason: Optional[str] = Field(default=None, max_length=1000)


class FindingScenarioBody(Actor):
    name: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = Field(default=None, max_length=MAX_DESC_LEN)
    criteria: list[Criterion] = Field(..., min_length=2, max_length=12)
    category: Optional[str] = Field(default=None, max_length=100)
    persona: Optional[str] = Field(default=None, max_length=200)


class MeasuredIn(BaseModel):
    fingerprint: str = Field(..., min_length=1, max_length=128)
    kind: str = Field(..., min_length=1, max_length=60)
    severity: Literal["blocker", "major", "minor", "cosmetic", "info"]
    summary: str = Field(..., min_length=1, max_length=500)
    measured: Optional[float] = None
    threshold: Optional[float] = None
    unit: Optional[str] = Field(default=None, max_length=40)
    rect: Optional[list[float]] = Field(default=None, max_length=4)
    element_label: Optional[str] = Field(default=None, max_length=300)
    element_identifier: Optional[str] = Field(default=None, max_length=300)
    appearance: Optional[str] = Field(default=None, max_length=20)
    confident: bool = True
    extra: dict = Field(default_factory=dict)
    screen_key: Optional[str] = Field(default=None, max_length=300)
    screen_hash: Optional[str] = Field(default=None, max_length=128)
    frame_id: Optional[str] = None
    step_seq: Optional[int] = Field(default=None, ge=0)


class MeasuredBody(Actor):
    rows: list[MeasuredIn] = Field(..., min_length=1, max_length=200)


def _kind(who: dict) -> str:
    return "human" if who["kind"] == "human" else "ai"


@app.patch("/api/qa/sessions/{sid}/keep")
def keep_qa_session(sid: str, body: KeepBody, request: Request):
    """What a person keeps on a session: its name, notes, archived, pinned. A session that
    still runs cannot be archived."""
    sent = body.model_dump(exclude_unset=True)
    with db_cursor() as (conn, cur):
        s = qs.load_session(cur, sid)
        cid = str(s["container_id"])
        who = qs.human(cur, request, cid, body.actor_agent_id, "keep or rename a QA session")
        sets, args = [], []
        if "name" in sent:
            sets.append("name=%s")
            args.append(" ".join((body.name or "").split()) or None)
        if "notes" in sent:
            sets.append("notes=%s")
            args.append((body.notes or "").strip() or None)
        if body.archived is not None:
            if body.archived and s["status"] == "running":
                raise HTTPException(409, "stop this session before archiving it")
            sets.append("archived_at=%s")
            args.append(qs.now() if body.archived else None)
        if body.pinned is not None:
            sets.append("pinned_at=%s")
            args.append(qs.now() if body.pinned else None)
        if sets:
            cur.execute(f"UPDATE qa_sessions SET {', '.join(sets)} WHERE id=%s", (*args, sid))
            log_event(cur, cid, "human", who["id"], "qa_session", sid, "qa_session_kept", {k: sent[k] for k in sent if k != "actor_agent_id"})
        out = qs.public(qs.load_session(cur, sid))
        conn.commit()
    return out


def _repeat_description(s: dict) -> str:
    skill = SKILL[s["kind"]]
    cmd = f"Run /{skill} for this task on {s['platform']}"
    if s["kind"] in TIMED and s.get("budget_minutes") is not None:
        cmd += f" --minutes {s['budget_minutes']}"
    goal = " ".join((s.get("goal") or "").split()).replace('"', "'")
    if goal and s["kind"] == "map":
        cmd += f' --feature "{goal}"'
    elif goal and s["kind"] in ("explore", "draft"):
        cmd += f' --focus "{goal}"'
    lines = [cmd]
    if goal and s["kind"] == "check":
        lines += ["", f"Focus on: {goal}"]
    lines += ["", "Results land in the project's QA tab; a person reviews them there."]
    return "\n".join(lines)


def _repeat_title(s: dict) -> str:
    app_word = {"ios": "iOS app", "android": "Android app", "web": "web app"}[s["platform"]]
    base = {"map": f"Map the {app_word}", "explore": f"Explore the {app_word}",
            "draft": f"Draft QA scenarios for the {app_word}", "check": f"Check the {app_word} against its approved scenarios"}[s["kind"]]
    goal = " ".join((s.get("goal") or "").split())
    return f"{base}: {goal[:59].rstrip()}…" if len(goal) > 60 else (f"{base}: {goal}" if goal else base)


def _repeat(sid: str, request: Request, actor_id: Optional[str], *, new_series: bool) -> dict:
    """A normal task for the same work and the session that waits for it, assigned to the agent
    that ran this one when it can still work. A run that stopped with its task still open goes on
    with that task (`qx.again_plan`): a second task would leave two agents on one piece of work. The
    person's click approves the plan; a person still verifies the result."""
    from portal_backend import task_creation_routes
    from portal_backend.schemas import TaskCreateBody

    with db_cursor(readonly=True) as (_, cur):
        s = qs.load_session(cur, sid)
        cid = str(s["container_id"])
        who = qs.human(cur, request, cid, actor_id, "start QA work")
        plan = qx.again_plan(cur, cid, s.get("task_id")) if s["status"] in qx.STOPPED and not new_series else None
        alias = None
        if s.get("agent_id"):
            cur.execute("SELECT alias, kind, terminated_at FROM agents WHERE id=%s", (str(s["agent_id"]),))
            a = cur.fetchone()
            if a and a["kind"] != "human" and a["terminated_at"] is None:
                alias = a["alias"]
    tid = plan["task_id"] if plan else None
    if not tid:
        created = task_creation_routes.create_task(
            cid,
            TaskCreateBody(title=_repeat_title(s), description=f"{qa_handoff.person_run_line(who['alias'])}\n\n{_repeat_description(s)}",
                           definition_of_done=DOD[s["kind"]], created_by_agent_id=who["id"], assignee_alias=alias),
            qs.internal_request(),
        )
        tid = str(created["task_id"])
    with db_cursor() as (conn, cur):
        qa_handoff.approve_plan(cur, tid, who["id"], qa_handoff.person_run_line(who["alias"]))
        if plan and plan["task_id"]:
            qx.resume_task(cur, cid, tid, plan, who)
        qa_run_tasks.mark(cur, cid, tid, qa_run_tasks.origin_for(s["kind"]), kind=s["kind"], platform=s["platform"])
        q = qx.queue_session(
            cur, cid, who, kind=s["kind"], platform=s["platform"], task_id=tid, goal=s.get("goal"),
            budget_minutes=s.get("budget_minutes"), agent_id=str(s["agent_id"]) if alias and s.get("agent_id") else None,
            name=f"{s['name']} (copy)" if new_series and s.get("name") else (None if new_series else s.get("name")),
            series_id=None if new_series else str(s.get("series_id") or s["id"]),
            previous_id=None if new_series else str(s["id"]), new_series=new_series,
        )
        log_event(cur, cid, "human", who["id"], "qa_session", str(q["id"]), "qa_session_queued",
                  {"from": sid, "task_id": tid, "new_series": new_series})
        out = qs.public(q)
        conn.commit()
    return {**out, "task_id": tid, "session_id": out["id"], "run_again": plan}


@app.post("/api/qa/sessions/{sid}/again", status_code=201)
def run_qa_session_again(sid: str, body: Actor, request: Request):
    return _repeat(sid, request, body.actor_agent_id, new_series=False)


@app.post("/api/qa/sessions/{sid}/continue", status_code=201)
def continue_qa_session(sid: str, body: ContinueBody, request: Request):
    """Give a timed-out request more time on the same task. Recorded verdicts stay in place.

    Ended sessions remain immutable. A retry returns the already queued continuation.
    Workflow evidence and completed/cancelled tasks cannot be reopened through this route.
    """
    from portal_backend import qa_time, sql
    with db_cursor() as (conn, cur):
        s = qs.load_session(cur, sid)
        cid = str(s["container_id"])
        who = qs.human(cur, request, cid, body.actor_agent_id, "continue a QA run")
        if s["status"] != "done" or not qa_time.reached(s):
            raise HTTPException(409, "Continue needs a run that stopped at its time limit.")
        req = qa_handoff.load(cur, str(s["request_id"]), lock=True) if s.get("request_id") else None
        tid = str(req["qa_task_id"] if req else s["task_id"])
        cur.execute("SELECT * FROM tasks WHERE id=%s" + sql.for_update(), (tid,))
        task = dict(cur.fetchone())
        if task["workflow_id"] or task["status"] in ("completed", "cancelled"):
            raise HTTPException(409, "Continue needs an open QA task outside a workflow.")
        if req:
            cur.execute("SELECT id FROM qa_requests WHERE qa_task_id=%s ORDER BY created_at DESC LIMIT 1", (tid,))
            newest_request = cur.fetchone()
            if req["status"] == "cancelled" or not newest_request or str(newest_request["id"]) != str(req["id"]):
                raise HTTPException(409, "This QA request was cancelled or replaced. Open the latest request.")
        if req is None:
            if qa_handoff.request_for_task(cur, tid):
                raise HTTPException(409, "This task already has another open QA request.")
            cur.execute("SELECT id FROM qa_sessions WHERE task_id=%s ORDER BY started_at DESC LIMIT 1", (tid,))
            if str(cur.fetchone()["id"]) != sid:
                raise HTTPException(409, "A newer session already exists. Open that session to continue.")
            req = qa_handoff._insert(cur, cid, spec={"kind": s["kind"], "platform": s["platform"],
                                                   "focus": s.get("goal"), "minutes": body.minutes},
                                    conf=qa_handoff.settings(cur, cid), origin="handoff", who_id=who["id"],
                                    source=None, source_agent=None, qa_task_id=tid, status="blocked", approved_by=who["id"])
            cur.execute("SELECT * FROM qa_sessions WHERE task_id=%s AND request_id IS NULL", (tid,))
            attempt = qa_time.portal_attempt([dict(row) for row in cur.fetchall()], s)
            cur.execute(f"UPDATE qa_sessions SET request_id=%s WHERE {sql.in_list('id')}",
                        (str(req["id"]), sql.list_param([str(row["id"]) for row in attempt])))
        cur.execute("SELECT * FROM qa_sessions WHERE request_id=%s ORDER BY started_at DESC LIMIT 1", (str(req["id"]),))
        latest = dict(cur.fetchone())
        if str(latest["id"]) != sid:
            if str(latest.get("previous_session_id")) == sid and latest["status"] == "running":
                return qs.public(latest)
            raise HTTPException(409, "A newer session already exists. Open that session to continue.")
        if req["status"] not in qa_handoff.FINISHED:
            raise HTTPException(409, "Wait for this QA request to finish before continuing.")
        current = qa_handoff.request_for_task(cur, tid)
        if current:
            raise HTTPException(409, "This task already has another open QA request.")
        cur.execute("""SELECT 1 AS hit FROM worker_runs WHERE status='running' AND
                       (task_id=%s OR run_id IN (SELECT run_id FROM worker_run_tasks WHERE task_id=%s)) LIMIT 1""", (tid, tid))
        if cur.fetchone():
            raise HTTPException(409, "Wait for the QA agent to stop before continuing.")
        lines = qa_handoff._line_results(cur, req)
        unfinished = [l for l in lines if l["verdict"] != "pass"]
        note = (f"Continue QA request {req['id']} with minutes={body.minutes}. "
                "Keep the recorded verdicts. Work only on unproven checks.\n" +
                "\n".join(f"Line {l['index']}: {l['text']}" for l in unfinished))
        cur.execute("UPDATE qa_requests SET status='requested', minutes=%s, result=NULL, finished_at=NULL WHERE id=%s",
                    (body.minutes, str(req["id"])))
        cur.execute("UPDATE tasks SET status='in_progress' WHERE id=%s", (tid,))
        cur.execute("INSERT INTO task_messages (task_id, author_id, body) VALUES (%s,%s,%s)", (tid, who["id"], note))
        qa_handoff.approve_plan(cur, tid, who["id"], qa_handoff.person_run_line(who["alias"]))
        q = qx.queue_session(cur, cid, who, kind=s["kind"], platform=s["platform"], task_id=tid, goal=s.get("goal"),
                             budget_minutes=body.minutes, agent_id=s.get("agent_id"), series_id=str(s.get("series_id") or sid),
                             previous_id=sid)
        cur.execute("UPDATE qa_sessions SET request_id=%s, result=%s WHERE id=%s",
                    (str(req["id"]), qs.dumps({"continued_from_session_id": sid}), str(q["id"])))
        qa_conditions.store(cur, "qa_sessions", str(q["id"]), qs._json(s.get("conditions"), None))
        qx.resume_task(cur, cid, tid, qx.again_plan(cur, cid, tid), who)
        qa_handoff._changed(cur, cid, qa_handoff.load(cur, str(req["id"])))
        log_event(cur, cid, "human", who["id"], "qa_session", str(q["id"]), "qa_session_continued",
                  {"from": sid, "task_id": tid, "minutes": body.minutes})
        out = qs.public(qs.load_session(cur, str(q["id"])))
        conn.commit()
    return out


@app.post("/api/qa/sessions/{sid}/duplicate", status_code=201)
def duplicate_qa_session(sid: str, body: Actor, request: Request):
    return _repeat(sid, request, body.actor_agent_id, new_series=True)


@app.post("/api/containers/{cid}/qa/sessions/queue", status_code=201)
def queue_qa_session(cid: str, body: QueueBody, request: Request):
    """The session a task from Run QA will become, so it shows as queued from the first moment."""
    with db_cursor() as (conn, cur):
        qs.container_read(cur, request, cid)
        who = qs.human(cur, request, cid, body.actor_agent_id, "start QA work")
        tid = qs.require_task_in(cur, cid, body.task_id)
        if body.agent_id:
            qs.require_uuid(body.agent_id, "agent_id")
        q = qx.queue_session(cur, cid, who, kind=body.kind, platform=body.platform, task_id=tid, goal=body.goal,
                             budget_minutes=body.budget_minutes, agent_id=body.agent_id, draft_sources=body.draft_sources)
        if body.conditions is not None:
            qa_conditions.store(cur, "qa_sessions", str(q["id"]), body.conditions)
            q = qs.load_session(cur, str(q["id"]))
        if tid:  # Run QA is a person's click: the task says so, and it approves the plan
            line = qa_handoff.person_run_line(who["alias"])
            cur.execute("UPDATE tasks SET description=%s || COALESCE(description, '') WHERE id=%s AND status<>'completed'", (f"{line}\n\n", tid))
            qa_handoff.approve_plan(cur, tid, who["id"], line)
            qa_run_tasks.mark(cur, cid, tid, qa_run_tasks.origin_for(body.kind), kind=body.kind, platform=body.platform)
        out = qs.public(q)
        conn.commit()
    return out


@app.patch("/api/qa/findings/{fid}/severity")
def set_qa_finding_severity(fid: str, body: SeverityBody, request: Request):
    """A person's call on a finding's severity. What the agent said stays beside it."""
    with db_cursor() as (conn, cur):
        f = qs.load_finding(cur, fid)
        cid = str(f["container_id"])
        who = qs.human(cur, request, cid, body.actor_agent_id, "change a finding's severity")
        reported = f.get("severity_reported") or f["severity"]
        cur.execute("UPDATE qa_findings SET severity=%s, severity_reported=%s, severity_by='person', severity_reason=%s WHERE id=%s",
                    (body.severity, reported, (body.reason or "").strip() or None, fid))
        log_event(cur, cid, "human", who["id"], "qa_finding", fid, "qa_finding_severity", {"from": f["severity"], "to": body.severity})
        out = qs.public(qs.load_finding(cur, fid))
        conn.commit()
    return out


@app.post("/api/qa/findings/{fid}/scenario", status_code=201)
def draft_qa_finding_scenario(fid: str, body: FindingScenarioBody, request: Request):
    """The finding's one draft scenario; a second call returns the first. Only a person validates it."""
    with db_cursor() as (conn, cur):
        f = qs.load_finding(cur, fid)
        cid = str(f["container_id"])
        who = qs.actor(cur, request, cid, body.actor_agent_id)
        if f.get("scenario_id"):
            cur.execute("SELECT * FROM qa_scenarios WHERE id=%s", (str(f["scenario_id"]),))
            row = cur.fetchone()
            if row:
                return {"scenario": qs.public(row), "created": False}
        s = qs.load_session(cur, str(f["session_id"]))
        fields = {"name": " ".join(body.name.split()), "criteria": [" ".join(c.split()) for c in body.criteria],
                  "description": body.description, "category": body.category, "persona": body.persona,
                  "source": "generated", "session_id": str(s["id"]), "task_id": str(s["task_id"]) if s.get("task_id") else None}
        got = qa_scenarios.propose(cur, cid, who, s["platform"], {k: v for k, v in fields.items() if v is not None}, None, None)
        scenario = got.get("scenario") or got
        cur.execute("UPDATE qa_findings SET scenario_id=%s WHERE id=%s", (str(scenario["id"]), fid))
        log_event(cur, cid, _kind(who), who["id"], "qa_finding", fid, "qa_finding_scenario", {"scenario_id": str(scenario["id"])})
        conn.commit()
    return {"scenario": scenario, "created": True}


@app.post("/api/qa/sessions/{sid}/measured", status_code=201)
def add_qa_measured(sid: str, body: MeasuredBody, request: Request):
    with db_cursor() as (conn, cur):
        s = qs.load_session(cur, sid)
        qs.actor(cur, request, str(s["container_id"]), body.actor_agent_id)
        added = qx.add_measured(cur, s, [r.model_dump() for r in body.rows])
        conn.commit()
    return {"added": added}


@app.get("/api/containers/{cid}/qa/app-model")
def get_qa_app_model(cid: str, request: Request, platform: str = Query(...), version: Optional[int] = Query(default=None, ge=1)):
    qs.require_platform(platform)
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
        return qx.app_model_payload(cur, cid, platform, version)
