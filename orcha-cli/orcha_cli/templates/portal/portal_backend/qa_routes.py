"""Orcha QA routes (migration 093; contract: docs/orcha-qa-plan.md, "HTTP API").

Container scope C = /api/containers/{cid}/qa:
  GET  C/overview                     counts per platform (members read)
  GET  C/targets, PUT C/targets/{p}   the app under test per platform (PUT: a person)
  GET  C/map?platform=                features, nodes, edges, last build
  GET  C/atlas?since=                 the Screen atlas, read from what is stored (qa_atlas)
  POST C/map/import                   merge one source's nodes/edges/features (qa_map)
  POST C/map/observe                  meet a live capture with a screen, mark it seen
  POST C/map/blocked                  why a screen could not be reached
  PUT  C/features                     upsert features (max 30)
  POST C/sessions, GET C/sessions     QA sessions
  GET  C/flows, POST C/flows          the flow queue (upsert by key)
  GET  C/scenarios, POST C/scenarios  list / propose (created | updated | suggested)
  POST C/scenarios/status             validate / pause / retire / back to draft (a person)
  GET  C/scenarios/export.md          scenario markdown
  GET  C/suggestions                  suggestions against non-draft scenarios
Item scope:
  GET/PATCH /api/qa/sessions/{sid}; POST .../frames (raw image/jpeg, <= 4 MB); GET /api/qa/frames/{fid};
  POST/GET .../steps (idempotent on seq); POST .../findings; PATCH /api/qa/findings/{fid} (dismiss |
  file as task | reopen); POST .../walks/next; PATCH /api/qa/walks/{wid}; GET/PATCH /api/qa/scenarios/{id};
  POST /api/qa/suggestions/{id} (a person); POST .../verdicts; GET /api/tasks/{tid}/qa.

Writes carry actor_agent_id (trusted_actor). Agents write the map, sessions, steps, frames,
findings, flows, walks, draft scenarios, evidence and verdicts; only a person sets a scenario's
status, decides a suggestion or edits targets. Nothing here changes a task's status.
"""

from __future__ import annotations

import datetime as _dt
import re
from urllib.parse import urlsplit
from typing import Annotated, Any, Literal, Optional

from fastapi import HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse
from pydantic import BaseModel, Field

from portal_backend import qa_atlas, qa_explorations, qa_growth, qa_handoff, qa_map, qa_onboarding, qa_read_cache, qa_run_tasks, qa_scenario_health, qa_scenarios, qa_store as qs, sql
from portal_backend import qa_conditions
from portal_backend.qa_conditions import Conditions
from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_task, valid_uuid
from portal_backend.identity_routes import require_member_read
from portal_backend.limits import MAX_DESC_LEN, MAX_DOD_LEN, MAX_NAME_LEN
from portal_backend.static_pages import serve_page

Platform = Literal["ios", "android", "web"]
BlockedKind = Literal["needs_sign_in", "needs_data", "needs_permission", "paywall", "external", "crash", "other"]
Text300 = Annotated[str, Field(max_length=300)]
Text2000 = Annotated[str, Field(max_length=2000)]
Criterion = Annotated[str, Field(min_length=1, max_length=1000)]
Short = Annotated[str, Field(max_length=200)]
#: A note that looks like it carries a secret ("password: hunter2").
_SECRET = re.compile(r"\b(?:pass(?:word|code|phrase)?|pwd|secret|token)\s*[:=]\s*\S", re.IGNORECASE)


class ActorBody(BaseModel):
    actor_agent_id: Optional[str] = None


class TargetBody(ActorBody):
    app_id: Optional[str] = Field(default=None, max_length=300,
                                  description="Bundle id (iOS), package (Android) or the http(s) URL to open (web)")
    app_name: Optional[str] = Field(default=None, max_length=200)
    build_path: Optional[str] = Field(default=None, max_length=1000, description="Optional .app / .apk to install")
    device_name: Optional[str] = Field(default=None, max_length=200,
                                       description="Default simulator / emulator name; on the web the viewport, "
                                                   "desktop or mobile")
    notes: Optional[str] = Field(default=None, max_length=4000,
                                 description="Sign-in identity hints for agents. Never a password.")


class FeatureIn(BaseModel):
    key: Optional[str] = Field(default=None, max_length=120)
    name: str = Field(..., min_length=1, max_length=200)
    summary: Optional[str] = Field(default=None, max_length=2000)
    entry: Optional[str] = Field(default=None, max_length=300)
    paths: list[Text300] = Field(default_factory=list, max_length=50)


class MapNodeIn(BaseModel):
    kind: Literal["screen", "endpoint", "entity", "flow"]
    key: str = Field(..., min_length=1, max_length=300)
    label: Optional[str] = Field(default=None, max_length=300)
    feature_key: Optional[str] = Field(default=None, max_length=120)
    evidence: Any = None
    detail: dict = Field(default_factory=dict)


class MapEdgeIn(BaseModel):
    kind: Literal["navigates", "calls", "reads", "writes", "steps"]
    from_key: str = Field(..., min_length=1, max_length=300)
    to_key: str = Field(..., min_length=1, max_length=300)
    from_kind: Literal["screen", "endpoint", "entity", "flow"] = "screen"
    to_kind: Literal["screen", "endpoint", "entity", "flow"] = "screen"
    label: str = Field(default="", max_length=200)
    evidence: Any = None
    detail: dict = Field(default_factory=dict)


class MapImportBody(ActorBody):
    platform: Platform
    source: Literal["code", "tests", "live", "crawl", "agent"]
    features: list[FeatureIn] = Field(default_factory=list, max_length=30)
    nodes: list[MapNodeIn] = Field(default_factory=list, max_length=5000)
    edges: list[MapEdgeIn] = Field(default_factory=list, max_length=20000)
    replace_source: bool = Field(default=False, description="The payload is everything this source says now: its "
                                 "part goes from rows it no longer lists")


class ObserveBody(ActorBody):
    platform: Platform
    session_id: str
    title: Optional[str] = Field(default=None, max_length=300)
    route: Optional[str] = Field(default=None, max_length=2000,
                                 description="Web: the page's path (or URL); matched first, ids collapsed to *")
    texts: list[Text2000] = Field(default_factory=list, max_length=600)
    anchors: list[Text2000] = Field(default_factory=list, max_length=600)
    frame_id: Optional[str] = None
    from_key: Optional[str] = Field(default=None, max_length=300)
    action: Optional[str] = Field(default=None, max_length=200)
    screen_hash: Optional[str] = Field(default=None, max_length=128)


class BlockedBody(ActorBody):
    platform: Platform
    screen: str = Field(..., min_length=1, max_length=300)
    kind: BlockedKind
    reason: str = Field(..., min_length=1, max_length=2000)
    session_id: Optional[str] = None


class FeaturesBody(ActorBody):
    features: list[FeatureIn] = Field(..., max_length=30)
    source: Literal["code", "exploration", "manual"] = "manual"


class SessionCreateBody(ActorBody):
    kind: Literal["map", "explore", "draft", "check"]
    platform: Platform
    task_id: Optional[str] = Field(default=None, description="Required: no QA session exists without a task. Only a named "
                                   "`request_id` can stand in for it, since the request has its task")
    device_name: Optional[str] = Field(default=None, max_length=200)
    device_udid: Optional[str] = Field(default=None, max_length=100)
    app_id: Optional[str] = Field(default=None, max_length=300)
    budget_minutes: Optional[int] = Field(default=None, ge=1, le=480)
    goal: Optional[str] = Field(default=None, max_length=4000)
    draft_sources: Optional[Literal["code", "exploration", "both"]] = None
    request_id: Optional[str] = Field(default=None, description="The QA request this session works; a task's open "
                                      "request is linked without naming it")
    conditions: Optional[Conditions] = Field(default=None, description="What this run needs (qa_conditions); a request's own are used when none")


class QaDeviceWait(BaseModel):
    """What a session waits for while another run holds its device: read from the lock files by the
    tool server, so it names other projects' runs too."""
    device: str = Field(..., max_length=200)
    devices: list[str] = Field(default_factory=list, max_length=20)
    used_by: Optional[str] = Field(default=None, max_length=300, description="Who has it, in words; empty: only the line is ahead")
    project: Optional[str] = Field(default=None, max_length=200)
    kind: Optional[str] = Field(default=None, max_length=20)
    held_session_id: Optional[str] = Field(default=None, max_length=100)
    position: int = Field(default=1, ge=1)
    reason: str = Field(..., max_length=500)


class SessionPatchBody(ActorBody):
    status: Optional[Literal["running", "done", "failed", "cancelled", "abandoned"]] = None
    briefing: Optional[dict] = None
    charter: Optional[Any] = None
    result: Optional[dict] = None
    report_md: Optional[str] = Field(default=None, max_length=100_000)
    heartbeat: bool = False
    device_name: Optional[str] = Field(default=None, max_length=200)
    device_udid: Optional[str] = Field(default=None, max_length=100)
    build_label: Optional[str] = Field(default=None, max_length=200)
    device_appearance: Optional[Literal["light", "dark"]] = None
    waiting: Optional[QaDeviceWait] = Field(default=None, description="Its device is held: the session is in line, not failed")
    device_ready: bool = Field(default=False, description="The line is over: it has its device, and its clock starts now")
    starting: Optional[str] = Field(default=None, max_length=200, description="The stage of opening its device, in plain words; empty when it is open")
    conditions: Optional[Conditions] = Field(default=None, description="The conditions set on its device now (qa_conditions)")


class StepIn(BaseModel):
    seq: int = Field(..., ge=0, le=10_000_000)
    kind: Literal["screen", "tap", "type", "swipe", "press", "open_url", "launch", "terminate", "wait", "note"]
    args: dict = Field(default_factory=dict)
    result: Optional[str] = Field(default=None, max_length=8000)
    screen_key: Optional[str] = Field(default=None, max_length=300)
    screen_hash: Optional[str] = Field(default=None, max_length=128)
    frame_id: Optional[str] = None
    at: Optional[_dt.datetime] = None
    duration_ms: Optional[int] = Field(default=None, ge=0, le=3_600_000)
    timing: Optional[dict] = None


class StepsBody(ActorBody):
    steps: list[StepIn] = Field(..., min_length=1, max_length=500)


class FindingBody(ActorBody):
    severity: Literal["blocker", "major", "minor", "trivial"]
    title: str = Field(..., min_length=1, max_length=200)
    detail: Optional[str] = Field(default=None, max_length=8000)
    expected: Optional[str] = Field(default=None, max_length=4000)
    actual: Optional[str] = Field(default=None, max_length=4000)
    frame_ids: list[str] = Field(default_factory=list, max_length=20)
    start_seq: Optional[int] = Field(default=None, ge=0)
    end_seq: Optional[int] = Field(default=None, ge=0)
    screen_key: Optional[str] = Field(default=None, max_length=300)
    lens: Optional[Literal["works", "usable", "resilient", "accessible", "visual", "copy", "fast"]] = None
    fix_prompt: Optional[str] = Field(default=None, max_length=8000, description="What a coding agent should do about it")
    scenario_id: Optional[str] = Field(default=None, description="The scenario being checked when it was found")


class FindingConditionsBody(ActorBody):
    conditions: Optional[Conditions] = Field(default=None, description="What it takes to reproduce it; null clears them")


class FindingPatchBody(ActorBody):
    action: Literal["dismiss", "file", "reopen"]
    title: Optional[str] = Field(default=None, max_length=MAX_NAME_LEN, description="Task title when filing")
    assignee_agent_id: Optional[str] = Field(default=None, description="Assign the filed task to this member")


class FlowStepIn(BaseModel):
    text: str = Field(..., min_length=1, max_length=500)
    screen: Optional[str] = Field(default=None, max_length=300)
    check: Optional[str] = Field(default=None, max_length=500)


class FlowIn(BaseModel):
    key: Optional[str] = Field(default=None, max_length=120)
    name: str = Field(..., min_length=1, max_length=200)
    persona: Optional[str] = Field(default=None, max_length=200)
    criticality: Literal["high", "medium", "low"] = "medium"
    steps: list[FlowStepIn] = Field(default_factory=list, max_length=40)
    data: dict = Field(default_factory=dict)


class FlowsBody(ActorBody):
    platform: Platform
    flows: list[FlowIn] = Field(..., min_length=1, max_length=50)
    source: Literal["code", "plan", "briefing", "person"] = "plan"


class WalkStepIn(BaseModel):
    index: int = Field(..., ge=0, le=100, description="0-based: the flow's first step is 0")
    reached: bool
    text: Optional[str] = Field(default=None, max_length=500, description="The step as walked (kept on the walk)")
    expected: Optional[str] = Field(default=None, max_length=2000, description="What the step should show")
    result: Optional[str] = Field(default=None, max_length=2000)
    checked: list[Short] = Field(default_factory=list, max_length=20)
    finding_id: Optional[str] = None
    frame_id: Optional[str] = None
    seq: Optional[int] = Field(default=None, ge=0)
    screen_key: Optional[str] = Field(default=None, max_length=300)


class WalkPatchBody(ActorBody):
    step: Optional[WalkStepIn] = None
    outcome: Optional[Literal["passed", "failed", "unreachable", "abandoned"]] = None
    reason: Optional[str] = Field(default=None, max_length=2000)
    blocked_kind: Optional[BlockedKind] = None
    end_seq: Optional[int] = Field(default=None, ge=0, description="Last step seq of the walk (default: the session's)")


class CheckIn(BaseModel):
    criterion_index: Optional[int] = Field(default=None, ge=0, le=11,
                                           description="0-based criterion the line checks; null for the scenario")
    line: str = Field(..., min_length=1, max_length=500, description="One `Check:` line of scenario markdown v3")


class EvidenceIn(BaseModel):
    criterion_index: int = Field(..., ge=0, le=11)
    status: Literal["verified", "unconfirmed", "code_only"]
    frame_id: Optional[str] = None
    code_ref: Optional[str] = Field(default=None, max_length=500)
    note: Optional[str] = Field(default=None, max_length=2000)


class _ScenarioFields(ActorBody):
    conditions: Optional[Conditions] = Field(default=None, description="What every run of it needs (qa_conditions)")
    fresh: Optional[bool] = Field(default=None, description="Mobile: true clears the app's data first, false keeps it, null the default")
    permissions: Optional[Literal["ask"]] = Field(default=None, description="`ask`: nothing granted first, it tests the prompt")
    session: Optional[str] = Field(default=None, max_length=120, description="A named signed-in session")
    shared: Optional[bool] = Field(default=None, description="Runs on every platform of the project")
    examples: Optional[dict] = Field(default=None, description="{columns, rows, secret}: one run per row")
    seed: Optional[list[Annotated[str, Field(max_length=2000)]]] = Field(default=None, max_length=30)
    cleanup: Optional[list[Annotated[str, Field(max_length=2000)]]] = Field(default=None, max_length=30)
    events: Optional[list[Annotated[str, Field(max_length=500)]]] = Field(default=None, max_length=30)
    category: Optional[str] = Field(default=None, max_length=100)
    persona: Optional[str] = Field(default=None, max_length=200)
    description: Optional[str] = Field(default=None, max_length=MAX_DESC_LEN)
    checks: Optional[list[CheckIn]] = Field(default=None, max_length=50, description=
                                            "Stored and returned as [{criterion_index: int|null, line: str}]")
    data: Optional[dict] = None
    needs: Optional[list[Short]] = Field(default=None, max_length=20)
    tags: Optional[list[Annotated[str, Field(max_length=60)]]] = Field(default=None, max_length=20)
    depends_on: Optional[list[Short]] = Field(default=None, max_length=20)
    source: Optional[Literal["authored", "generated", "walk"]] = None
    walk_id: Optional[str] = None
    session_id: Optional[str] = None
    task_id: Optional[str] = None
    evidence: Optional[list[EvidenceIn]] = Field(default=None, max_length=60)
    reason: Optional[str] = Field(default=None, max_length=2000, description="Why (kept on a suggestion)")


class ScenarioProposeBody(_ScenarioFields):
    platform: Platform
    name: str = Field(..., min_length=1, max_length=200)
    criteria: list[Criterion] = Field(..., min_length=2, max_length=12)


class ScenarioPatchBody(_ScenarioFields):
    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    criteria: Optional[list[Criterion]] = Field(default=None, min_length=2, max_length=12)
    status: Optional[Literal["draft", "validated", "quarantined", "paused", "retired"]] = Field(
        default=None, description="People only")
    platform: Optional[Platform] = Field(default=None, description="People only: pin it to this platform")


class ScenarioStatusBody(ActorBody):
    ids: list[str] = Field(..., min_length=1, max_length=200)
    status: Literal["draft", "validated", "quarantined", "paused", "retired"]
    reason: Optional[str] = Field(default=None, max_length=2000)
    until: Optional[str] = Field(default=None, max_length=30, description="Paused: resume on this date (YYYY-MM-DD)")
    issue: Optional[str] = Field(default=None, max_length=300, description="Paused: resume when this task or issue closes")
    replaced_by: Optional[str] = Field(default=None, description="Retired: the scenario that took its place")


class DecisionBody(ActorBody):
    decision: Literal["accept", "dismiss"]


class OnboardingBody(ActorBody):
    action: Literal["start", "confirm", "run_live", "skip_live", "bring_in", "first_run", "skip", "restart"]
    options: Optional[dict] = Field(default=None, description="start: live?, platform?, agent_id?. confirm: platforms? "
                                    "([kind] or [{kind, app_id?, app_name?, device_name?}]), live? (ask|true|false), "
                                    "agent_id?. run_live: depth?, platform?, agent_id?. bring_in: migrate?, draft?, "
                                    "frameworks?, areas?, gap_screen_ids?, agent_id?. first_run: scenario_id?, suite?, "
                                    "platform?, agent_id?")


class VerdictBody(ActorBody):
    scenario_id: Optional[str] = Field(default=None, description="Left out when the verdict is on an acceptance line alone")
    criterion_index: Optional[int] = Field(default=None, ge=0, le=11)
    acceptance_line: Optional[int] = Field(default=None, ge=0, le=99, description="The 0-based line of the session's QA "
                                           "request this verdict proves or disproves")
    verdict: Literal["pass", "fail", "blocked", "inconclusive"]
    note: Optional[str] = Field(default=None, max_length=4000)
    frame_ids: list[str] = Field(default_factory=list, max_length=20)
    check_fix: Optional[dict] = Field(default=None, description="The criterion's check line is wrong, not the app: "
                                      "{expression, kind, reason, proposed?}. A person accepts or dismisses it")
    check_repairs: Optional[list[dict]] = Field(default=None, max_length=20, description="Lines this check judged in a "
                                                "corrected form: each as check_fix")
    example_row: Optional[int] = Field(default=None, ge=0, le=99, description="The 0-based Examples row it is for")


# ======================================================================== helpers

def _session_in(cur, request: Request, sid: str, actor_id: Optional[str]) -> tuple[dict, dict]:
    """A session and the live member of its project acting on it."""
    s = qs.load_session(cur, sid)
    return s, qs.actor(cur, request, str(s["container_id"]), actor_id)


def _session_read(cur, request: Request, sid: str) -> dict:
    s = qs.load_session(cur, sid)
    require_member_read(cur, request, str(s["container_id"]))
    return s


def _running(s: dict) -> None:
    if s["status"] != "running":
        raise HTTPException(409, f"this QA session is {s['status']}")


def _criteria(values: Optional[list[str]]) -> Optional[list[str]]:
    if values is None:
        return None
    out = [" ".join(v.split()) for v in values]
    if any(not v for v in out):
        raise HTTPException(400, "a criterion cannot be blank")
    return out


def _scenario_fields(body: _ScenarioFields) -> tuple[dict, Optional[list[dict]]]:
    sent = body.model_dump(exclude_unset=True)
    fields = {k: v for k, v in sent.items() if k in qa_scenarios.FIELDS}
    if "criteria" in fields:
        fields["criteria"] = _criteria(fields["criteria"])
    if "name" in fields:
        fields["name"] = " ".join(fields["name"].split())
        if not fields["name"]:
            raise HTTPException(400, "a scenario needs a name")
    for k in ("walk_id", "session_id", "task_id"):
        if fields.get(k):
            qs.require_uuid(fields[k], k)
    evidence = [e.model_dump() for e in body.evidence] if body.evidence is not None else None
    return fields, evidence


# ======================================================================== the page

@app.get("/qa", response_class=HTMLResponse)
def qa_page():
    """The QA project tab (views by ?view=). SPA shell, like /routines; data from the routes below."""
    return serve_page("dist/index.html")  # React SPA shell


# ======================================================================== onboarding

@app.get("/api/containers/{cid}/qa/onboarding")
def get_qa_onboarding(cid: str, request: Request,
                      since: Optional[str] = Query(default=None, max_length=120, description="The `snapshot_version` you hold: while it "
                                                   "stands the map part is left out and `snapshot_unchanged` is true. Poll with this"),
                      fields: Optional[Literal["row"]] = Query(default=None, description="`row`: the row and its phases, no snapshot")):
    """The onboarding row with the map's snapshot (the UI's `OnboardingMap` shape). A row left
    running by a thread that died is picked up here."""
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
    return qa_onboarding.read(cid, since=since, row_only=fields == "row")


@app.post("/api/containers/{cid}/qa/onboarding", status_code=202)
def post_qa_onboarding(cid: str, body: OnboardingBody, request: Request):
    """A person's step: answers at once with {project_id, phase, state, phases}; a background
    thread advances the phases and the UI polls the GET. A step that cannot happen now answers 409
    with a sentence that says why."""
    with db_cursor() as (conn, cur):
        qs.container_read(cur, request, cid)
        who = qs.human(cur, request, cid, body.actor_agent_id, "run QA onboarding")
        conn.commit()
    return qa_onboarding.act(cid, who, body.action, body.options)


# ======================================================================== overview + targets

@app.get("/api/containers/{cid}/qa/overview")
def qa_overview(cid: str, request: Request):
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
        cur.execute("SELECT count(*) AS n FROM qa_features WHERE container_id=%s", (cid,))
        features = int(cur.fetchone()["n"] or 0)
        platforms = {}
        for p in qs.PLATFORMS:
            # a feature is on a platform when one of that platform's map nodes names it
            cur.execute("""SELECT count(*) AS n FROM qa_features f
                            WHERE f.container_id=%s AND EXISTS (
                                  SELECT 1 FROM qa_map_nodes m WHERE m.container_id=f.container_id
                                     AND m.platform=%s AND m.feature_key=f.key)""", (cid, p))
            platform_features = int(cur.fetchone()["n"] or 0)
            cur.execute("""SELECT state, count(*) AS n FROM qa_map_nodes
                            WHERE container_id=%s AND platform=%s AND kind='screen' GROUP BY state""", (cid, p))
            screens = {"seen": 0, "declared": 0, "blocked": 0}
            screens.update({r["state"]: int(r["n"]) for r in cur.fetchall()})
            cur.execute("""SELECT status, count(*) AS n FROM qa_scenarios
                            WHERE container_id=%s AND platform=%s GROUP BY status""", (cid, p))
            scenarios = {s: 0 for s in qa_scenarios.STATUSES}
            scenarios.update({r["status"]: int(r["n"]) for r in cur.fetchall()})
            cur.execute("""SELECT sum(CASE WHEN f.status='open' THEN 1 ELSE 0 END) AS open_n,
                                  sum(CASE WHEN f.status='open' AND f.triage IS NULL THEN 1 ELSE 0 END) AS untriaged
                             FROM qa_findings f JOIN qa_sessions s ON s.id = f.session_id
                            WHERE f.container_id=%s AND s.platform=%s""", (cid, p))
            findings = cur.fetchone()
            open_findings = int(findings["open_n"] or 0)
            last = {}
            for kind in qs.SESSION_KINDS:
                cur.execute("""SELECT * FROM qa_sessions WHERE container_id=%s AND platform=%s AND kind=%s
                                ORDER BY started_at DESC LIMIT 1""", (cid, p, kind))
                last[kind] = qs.public(cur.fetchone())
            qs.with_names(cur, list(last.values()))
            platforms[p] = {"target": qs.public(qs.target(cur, cid, p)), "features": platform_features,
                            "screens": screens, "scenarios": scenarios, "open_findings": open_findings,
                            "untriaged": int(findings["untriaged"] or 0),
                            "last_session": last}
    return {"container_id": cid, "features": features, "features_total": features, "platforms": platforms}


@app.get("/api/containers/{cid}/qa/targets")
def qa_targets(cid: str, request: Request):
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
        out = []
        for p in qs.PLATFORMS:
            row = qs.public(qs.target(cur, cid, p))
            out.append(row or {"container_id": cid, "platform": p, "app_id": None, "app_name": None,
                               "build_path": None, "device_name": None, "notes": None, "updated_at": None,
                               "updated_by_agent_id": None})
    return {"targets": out}


def _check_web_target(body: TargetBody) -> None:
    """A web target opens a URL in a desktop- or mobile-sized browser."""
    url = (body.app_id or "").strip()
    if url:
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.netloc:
            raise HTTPException(400, "a web target's app is the http(s) URL to open, e.g. https://staging.example.com")
    device = (body.device_name or "").strip()
    if device and device not in qs.WEB_VIEWPORTS:
        raise HTTPException(400, "a web target's device is desktop or mobile")


@app.put("/api/containers/{cid}/qa/targets/{platform}")
def put_qa_target(cid: str, platform: str, body: TargetBody, request: Request):
    qs.require_platform(platform)
    if body.notes and _SECRET.search(body.notes):
        raise HTTPException(400, "notes hold sign-in hints for agents, never a password or a secret")
    if platform == "web":
        _check_web_target(body)
    with db_cursor() as (conn, cur):
        qs.container_read(cur, request, cid)
        who = qs.human(cur, request, cid, body.actor_agent_id, "edit QA targets")
        clean = {k: ((getattr(body, k) or "").strip() or None)
                 for k in ("app_id", "app_name", "build_path", "device_name", "notes")}
        cur.execute(
            """INSERT INTO qa_targets (container_id, platform, app_id, app_name, build_path, device_name, notes,
                                       updated_at, updated_by_agent_id)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (container_id, platform) DO UPDATE SET
                 app_id=EXCLUDED.app_id, app_name=EXCLUDED.app_name, build_path=EXCLUDED.build_path,
                 device_name=EXCLUDED.device_name, notes=EXCLUDED.notes, updated_at=EXCLUDED.updated_at,
                 updated_by_agent_id=EXCLUDED.updated_by_agent_id""",
            (cid, platform, clean["app_id"], clean["app_name"], clean["build_path"], clean["device_name"],
             clean["notes"], qs.now(), who["id"]),
        )
        log_event(cur, cid, "human", who["id"], "container", cid, "qa_target_changed",
                  {"platform": platform, "app_id": clean["app_id"]})
        row = qs.public(qs.target(cur, cid, platform))
        conn.commit()
    return row


# ======================================================================== map

@app.get("/api/containers/{cid}/qa/map")
def get_qa_map(cid: str, request: Request, platform: str = Query(...)):
    qs.require_platform(platform)
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
        return qa_read_cache.json_response(("map", cid, platform), qa_read_cache.live_version(cur, cid),
                                           lambda: qa_map.read_map(cur, cid, platform))


@app.get("/api/containers/{cid}/qa/atlas")
def get_qa_atlas(cid: str, request: Request, since: Optional[str] = Query(default=None, max_length=80)):
    """Every screen at a glance, across platforms: a reading of the map, steps and frames."""
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
        return qa_read_cache.json_response(("atlas", cid, since), qa_read_cache.live_version(cur, cid),
                                           lambda: qa_atlas.read_atlas(cur, cid, since))


@app.post("/api/containers/{cid}/qa/map/import")
def import_qa_map(cid: str, body: MapImportBody, request: Request):
    """Merge one source's view of the map. Returns counts (added / changed / removed)."""
    with db_cursor() as (conn, cur):
        qs.container_read(cur, request, cid)
        who = qs.actor(cur, request, cid, body.actor_agent_id)
        counts = qa_map.import_map(
            cur, cid, body.platform, body.source,
            nodes=[n.model_dump() for n in body.nodes], edges=[e.model_dump() for e in body.edges],
            features=[f.model_dump() for f in body.features], replace_source=body.replace_source,
            agent_id=who["id"])
        qa_growth.after_map_build(cur, cid)
        conn.commit()
    return {"platform": body.platform, "source": body.source, "counts": counts}


@app.post("/api/containers/{cid}/qa/map/observe")
def observe_qa_screen(cid: str, body: ObserveBody, request: Request):
    """Meet one live capture with a screen node: {screen_key, label, state, new, matched_by}."""
    with db_cursor() as (conn, cur):
        qs.container_read(cur, request, cid)
        s, _who = _session_in(cur, request, body.session_id, body.actor_agent_id)
        if str(s["container_id"]) != cid:
            raise HTTPException(400, "that QA session belongs to another project")
        if s["platform"] != body.platform:
            raise HTTPException(400, f"that QA session is on {s['platform']}, not {body.platform}")
        if body.frame_id:
            qs.require_frames_in(cur, cid, [body.frame_id])
        out = qa_map.observe(cur, s, platform=body.platform, texts=body.texts, anchors=body.anchors,
                             title=body.title, frame_id=body.frame_id, from_key=body.from_key,
                             action=body.action, screen_hash=body.screen_hash, route=body.route)
        cur.execute("UPDATE qa_sessions SET last_seen_at=%s WHERE id=%s", (qs.now(), str(s["id"])))
        conn.commit()
    return out


@app.post("/api/containers/{cid}/qa/map/blocked")
def block_qa_screen(cid: str, body: BlockedBody, request: Request):
    with db_cursor() as (conn, cur):
        qs.container_read(cur, request, cid)
        qs.actor(cur, request, cid, body.actor_agent_id)
        if body.session_id:
            s = qs.load_session(cur, body.session_id)
            if str(s["container_id"]) != cid:
                raise HTTPException(400, "that QA session belongs to another project")
        out = qa_map.mark_blocked(cur, cid, body.platform, body.screen.strip(), body.kind, body.reason.strip(),
                                  body.session_id)
        conn.commit()
    return out


@app.put("/api/containers/{cid}/qa/features")
def put_qa_features(cid: str, body: FeaturesBody, request: Request):
    """Upsert features by key (from the name when missing). Never deletes one."""
    with db_cursor() as (conn, cur):
        qs.container_read(cur, request, cid)
        qs.actor(cur, request, cid, body.actor_agent_id)
        out = qa_map.set_features(cur, cid, [f.model_dump() for f in body.features], body.source)
        conn.commit()
    return {"features": out}


# ======================================================================== sessions

@app.post("/api/containers/{cid}/qa/sessions", status_code=201)
def create_qa_session(cid: str, body: SessionCreateBody, request: Request):
    with db_cursor() as (conn, cur):
        qs.container_read(cur, request, cid)
        who = qs.actor(cur, request, cid, body.actor_agent_id)
        tid = body.task_id
        if not tid and body.request_id:
            tid = qa_handoff.load(cur, body.request_id).get("qa_task_id")
        if not tid:
            raise HTTPException(400, "A QA session needs a task: every run is one.")
        tid = qs.require_task_in(cur, cid, str(tid))
        s = qs.create_session(cur, cid, who, kind=body.kind, platform=body.platform, task_id=tid,
                              device_name=body.device_name, device_udid=body.device_udid, app_id=body.app_id,
                              budget_minutes=body.budget_minutes, goal=body.goal, draft_sources=body.draft_sources)
        s = qa_handoff.link_session(cur, s, body.request_id)
        asked = qa_conditions.clean(body.conditions)
        if not asked and s.get("request_id"):
            asked = qa_conditions.clean(qa_handoff.load(cur, str(s["request_id"])).get("conditions"))
        if asked:
            qa_conditions.store(cur, "qa_sessions", str(s["id"]), asked)
            s = qs.load_session(cur, str(s["id"]))
        conn.commit()
    return qs.public(s)


@app.get("/api/containers/{cid}/qa/sessions")
def list_qa_sessions(cid: str, request: Request, kind: Optional[str] = Query(default=None),
                     status: Optional[str] = Query(default=None), task_id: Optional[str] = Query(default=None),
                     platform: Optional[str] = Query(default=None), limit: int = Query(default=50, ge=1, le=200)):
    qa_explorations.sweep_abandoned(cid)
    if kind is not None and kind not in qs.SESSION_KINDS:
        raise HTTPException(400, f"kind must be one of {', '.join(qs.SESSION_KINDS)}")
    if status is not None and status not in qs.SESSION_STATUSES:
        raise HTTPException(400, f"status must be one of {', '.join(qs.SESSION_STATUSES)}")
    if platform is not None:
        qs.require_platform(platform)
    if task_id is not None:
        qs.require_uuid(task_id, "task_id")
    q, args = "SELECT * FROM qa_sessions WHERE container_id=%s" + ("" if status else f" AND {qs.STARTED_SQL}"), [cid]
    for col, val in (("kind", kind), ("status", status), ("task_id", task_id), ("platform", platform)):
        if val is not None:
            q += f" AND {col}=%s"
            args.append(val)
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
        cur.execute(q + " ORDER BY started_at DESC LIMIT %s", (*args, limit))
        return {"sessions": qs.with_names(cur, [qs.public(r) for r in cur.fetchall()])}


@app.get("/api/containers/{cid}/qa/session-digests")
def list_qa_session_digests(cid: str, request: Request, platform: Optional[str] = Query(default=None),
                            limit: int = Query(default=40, ge=1, le=100)):
    """What the Sessions view's cards show of the newest sessions, in one read: each one's
    findings, walks and drafts, and its screenshot steps in order."""
    if platform is not None:
        qs.require_platform(platform)
    q, args = f"SELECT id FROM qa_sessions WHERE container_id=%s AND {qs.STARTED_SQL}", [cid]
    if platform is not None:
        q += " AND platform=%s"
        args.append(platform)
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
        cur.execute(q + " ORDER BY started_at DESC LIMIT %s", (*args, limit))
        return {"digests": qs.session_digests(cur, [str(r["id"]) for r in cur.fetchall()])}


@app.get("/api/qa/sessions/{sid}")
def get_qa_session(sid: str, request: Request):
    """Adds to the row `queued`, `queue`, `stop_reason` (on every session row) and `run_again`."""
    with db_cursor(readonly=True) as (_, cur):
        cid = str(_session_read(cur, request, sid)["container_id"])
    qa_explorations.sweep_abandoned(cid)
    with db_cursor(readonly=True) as (_, cur):
        s = _session_read(cur, request, sid)
        return qs.session_detail(cur, s)


@app.patch("/api/qa/sessions/{sid}")
def patch_qa_session(sid: str, body: SessionPatchBody, request: Request):
    """Status, briefing, charter, result, report_md, or just a heartbeat. A session that ended
    stays ended; ending one abandons any walk still walking."""
    with db_cursor() as (conn, cur):
        s, who = _session_in(cur, request, sid, body.actor_agent_id)
        sets, args = ["last_seen_at=%s"], [qs.now()]
        if body.status is not None and body.status != s["status"]:
            if s["status"] != "running":
                raise HTTPException(409, f"this QA session already ended ({s['status']})")
            if body.status == "running":
                raise HTTPException(409, "this QA session is already running")
            sets += ["status=%s", "ended_at=%s"]
            args += [body.status, qs.now()]
            qs.end_open_walks(cur, sid, f"the session ended ({body.status})")
        if body.briefing is not None:
            sets.append("briefing=%s")
            args.append(qs.dumps(body.briefing))
        if body.charter is not None:
            sets.append("charter=%s")
            args.append(qs.dumps(qs.validate_charter(body.charter)))
        if body.result is not None:
            sets.append("result=%s")
            args.append(qs.dumps(body.result))
        if body.report_md is not None:
            sets.append("report_md=%s")
            args.append(body.report_md)
        for col in ("device_name", "device_udid", "build_label", "device_appearance"):
            if getattr(body, col) is not None:
                sets.append(f"{col}=%s")
                args.append(getattr(body, col))
        if body.conditions is not None:
            sets.append("conditions=%s")
            args.append(qa_conditions.dumps(body.conditions))
        if body.waiting is not None:
            if s["status"] != "running":
                raise HTTPException(409, f"this QA session already ended ({s['status']})")
            sets += ["queued_at=COALESCE(queued_at, %s)", "claimed_at=NULL", "result=%s"]
            args += [qs.now(), qs.dumps({"waiting": body.waiting.model_dump()})]
        if body.starting is not None and body.result is None and not body.device_ready and s["status"] == "running":
            sets.append("result=%s")
            args.append(qs.dumps({"starting": body.starting, "since": qs.now()}) if body.starting else None)
        if body.device_ready and s["status"] == "running":
            sets += ["queued_at=COALESCE(queued_at, %s)", "claimed_at=%s", "started_at=%s"]
            args += [qs.now(), qs.now(), qs.now()]
            if body.result is None:
                sets.append("result=NULL")
        cur.execute(f"UPDATE qa_sessions SET {', '.join(sets)} WHERE id=%s", (*args, sid))
        if body.briefing is not None:
            qa_explorations.snapshot_app_model(cur, str(s["container_id"]), s["platform"], "briefing", "The explorer's briefing")
        if body.status and body.status != s["status"]:
            log_event(cur, str(s["container_id"]), "ai" if who["kind"] != "human" else "human", who["id"],
                      "qa_session", sid, "qa_session_ended", {"status": body.status, "kind": s["kind"]})
        out = qs.public(qs.load_session(cur, sid))
        conn.commit()
    if body.status == "cancelled" and who["kind"] == "human" and s.get("task_id"):
        _stop_task_workers(request, str(s["task_id"]), who)
        # A run's own task goes with it, or the next wake starts the run over. A workflow step is the workflow's.
        with db_cursor(readonly=True) as (_, cur):
            run = qa_run_tasks.run_of(cur, str(s["task_id"]))
        if run and run["origin"] != "workflow":
            qa_explorations.cancel_queued_task(request, str(s["task_id"]), who, "A person stopped this run.")
    if body.status and body.status != s["status"]:
        qa_handoff.after_session_end(sid)
    # Stopped before any agent took it: the task it waited on goes too, or an agent would still run it.
    if body.status == "cancelled" and s.get("task_id") and s.get("queued_at") and not s.get("claimed_at"):
        qa_explorations.cancel_queued_task(request, str(s["task_id"]), who)
    return out


def _stop_task_workers(request: Request, tid: str, who: dict) -> None:
    """A person stopped the run: the agent working it stops too. Left alone it goes on spending,
    looking for why its session ended."""
    from portal_backend.schemas.worker_runs import WorkerRunStop
    from portal_backend.worker_run_finish_routes import stop_worker_run

    with db_cursor(readonly=True) as (_, cur):
        cur.execute("SELECT run_id FROM worker_runs WHERE task_id=%s AND status='running' AND ended_at IS NULL", (tid,))
        runs = [str(r["run_id"]) for r in cur.fetchall()]
    for run_id in runs:
        stop_worker_run(run_id, WorkerRunStop(actor_agent_id=str(who["id"])), request)


# ---------------------------------------------------------------- frames

@app.post("/api/qa/sessions/{sid}/frames", status_code=201)
async def upload_qa_frame(sid: str, request: Request,
                          actor_agent_id: Optional[str] = Query(default=None),
                          screen_hash: Optional[str] = Query(default=None, max_length=128),
                          fingerprint: Optional[str] = Query(default=None, max_length=60),
                          appearance: Optional[Literal["light", "dark"]] = Query(default=None),
                          blank: Optional[Literal["uniform", "flag_secure"]] = Query(default=None)):
    """Raw `image/jpeg` body, at most 4 MB → {frame_id, width, height}. Stored under the
    attachments dir at qa/<cid>/<sid>/<frame_id>.jpg. `fingerprint`, `appearance` and `blank` are
    what the CLI read from the frame as it took it (`frame_facts`): the portal never decodes one."""
    ctype = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if ctype != qs.FRAME_TYPE:
        raise HTTPException(415, "a frame is sent as a raw image/jpeg body")
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > qs.MAX_FRAME_BYTES:
        raise HTTPException(413, "a frame is at most 4 MB")
    data = bytearray()
    async for chunk in request.stream():
        data += chunk
        if len(data) > qs.MAX_FRAME_BYTES:
            raise HTTPException(413, "a frame is at most 4 MB")
    if not data:
        raise HTTPException(400, "the frame is empty")
    if not bytes(data[:3]) == b"\xff\xd8\xff":
        raise HTTPException(400, "the body is not a JPEG image")
    facts = {"fingerprint": fingerprint, "appearance": appearance, "blank": blank}
    return await run_in_threadpool(_save_frame, sid, request, actor_agent_id, screen_hash, bytes(data), facts)


def _save_frame(sid: str, request: Request, actor_agent_id: Optional[str], screen_hash: Optional[str],
                data: bytes, facts: Optional[dict] = None) -> dict:
    with db_cursor() as (conn, cur):
        s, _who = _session_in(cur, request, sid, actor_agent_id)
        out = qs.store_frame(cur, s, data, screen_hash, facts)
        conn.commit()
    return out


@app.get("/api/qa/frames/{fid}")
def get_qa_frame(fid: str, request: Request):
    with db_cursor(readonly=True) as (_, cur):
        f = qs.load_frame(cur, fid)
        require_member_read(cur, request, str(f["container_id"]))
    path = qs.frame_file(f)
    if path is None or not path.is_file():
        raise HTTPException(404, "this frame's image is no longer on disk")
    return FileResponse(path, media_type=qs.FRAME_TYPE,
                        headers={"X-Content-Type-Options": "nosniff", "Content-Disposition": "inline"})


# ---------------------------------------------------------------- steps

@app.post("/api/qa/sessions/{sid}/steps")
def add_qa_steps(sid: str, body: StepsBody, request: Request):
    """A batch of steps, idempotent on seq: a seq already stored is skipped, never changed."""
    seqs = [st.seq for st in body.steps]
    if len(seqs) != len(set(seqs)):
        raise HTTPException(400, "a batch names each seq once")
    with db_cursor() as (conn, cur):
        s, _who = _session_in(cur, request, sid, body.actor_agent_id)
        for st in body.steps:
            if st.frame_id:
                qs.require_uuid(st.frame_id, "frame_id")
        out = qs.add_steps(cur, s, [st.model_dump() for st in body.steps])
        conn.commit()
    return out


@app.get("/api/qa/sessions/{sid}/steps")
def list_qa_steps(sid: str, request: Request, from_seq: Optional[int] = Query(default=None, ge=0),
                  to_seq: Optional[int] = Query(default=None, ge=0), limit: int = Query(default=500, ge=1, le=2000)):
    q, args = "SELECT * FROM qa_steps WHERE session_id=%s", [sid]
    if from_seq is not None:
        q += " AND seq>=%s"
        args.append(from_seq)
    if to_seq is not None:
        q += " AND seq<=%s"
        args.append(to_seq)
    with db_cursor(readonly=True) as (_, cur):
        _session_read(cur, request, sid)
        cur.execute(q + " ORDER BY seq LIMIT %s", (*args, limit))
        return {"steps": [qs.public(r) for r in cur.fetchall()]}


# ---------------------------------------------------------------- findings

@app.post("/api/qa/sessions/{sid}/findings", status_code=201)
def add_qa_finding(sid: str, body: FindingBody, request: Request):
    with db_cursor() as (conn, cur):
        s, who = _session_in(cur, request, sid, body.actor_agent_id)
        cid = str(s["container_id"])
        frames = qs.require_frames_in(cur, cid, body.frame_ids)
        fid = qs.new_id()
        cur.execute(
            """INSERT INTO qa_findings (id, container_id, session_id, task_id, severity, title, detail, expected,
                                        actual, frame_ids, start_seq, end_seq, screen_key, status, created_at,
                                        lens, fix_prompt, request_id, scenario_id)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'open',%s,%s,%s,%s,%s)""",
            (fid, cid, sid, s.get("task_id"), body.severity, body.title.strip(), body.detail, body.expected,
             body.actual, qs.dumps(frames), body.start_seq, body.end_seq, body.screen_key, qs.now(), body.lens,
             body.fix_prompt, s.get("request_id"), body.scenario_id),
        )
        log_event(cur, cid, "ai" if who["kind"] != "human" else "human", who["id"], "qa_finding", fid,
                  "qa_finding_recorded", {"severity": body.severity, "title": body.title, "session_id": sid})
        # Found under conditions: reproducing it needs them too.
        qa_conditions.store(cur, "qa_findings", fid, s.get("conditions"))
        out = qs.public(qs.load_finding(cur, fid))
        conn.commit()
    return out


def _finding_task_texts(f: dict, s: dict) -> tuple[str, str, str]:
    where = f"{s['platform']}" + (f" ({s['app_id']})" if s.get("app_id") else "")
    lines = [f"QA finding ({f['severity']}) from a {s['kind']} session on {where}."]
    for label, key in (("What happened", "actual"), ("Expected", "expected"), ("Detail", "detail"),
                       ("Screen", "screen_key")):
        if f.get(key):
            lines.append(f"{label}: {f[key]}")
    if f.get("start_seq") is not None:
        span = f"steps {f['start_seq']} to {f['end_seq']}" if f.get("end_seq") is not None else f"step {f['start_seq']}"
        lines.append(f"Seen at {span} of QA session {s['id']}.")
    else:
        lines.append(f"QA session {s['id']}.")
    frames = qs._json(f.get("frame_ids"), [])
    if frames:
        lines.append("Frames: " + ", ".join(f"/api/qa/frames/{x}" for x in frames))
    description = "\n".join(lines)[:MAX_DESC_LEN]
    expect = f.get("expected") or f"the problem “{f['title']}” no longer happens"
    dod = (f"On {s['platform']}, {expect}. Walk the steps that showed the finding again and record the "
           f"result as evidence.")[:MAX_DOD_LEN]
    return f"Fix: {f['title']}"[:MAX_NAME_LEN], description, dod


@app.put("/api/qa/findings/{fid}/conditions")
def set_qa_finding_conditions(fid: str, body: FindingConditionsBody, request: Request):
    """A person's word on what it takes to reproduce a finding: an OS version, a language, an
    account. A reproduction (triage) uses them unless it asks for others."""
    with db_cursor() as (conn, cur):
        f = qs.load_finding(cur, fid)
        cid = str(f["container_id"])
        who = qs.human(cur, request, cid, body.actor_agent_id, "set what a finding needs to reproduce")
        qa_conditions.store(cur, "qa_findings", fid, body.conditions, replace=True)
        log_event(cur, cid, "human", who["id"], "qa_finding", fid, "qa_finding_conditions", {"conditions": qa_conditions.clean(body.conditions)})
        out = qs.public(qs.load_finding(cur, fid))
        conn.commit()
    return out


@app.patch("/api/qa/findings/{fid}")
def patch_qa_finding(fid: str, body: FindingPatchBody, request: Request):
    """dismiss, reopen, or `file`: create an Orcha task through the normal task-creation path
    (the finding is its description and definition of done) and link it."""
    from portal_backend import task_creation_routes
    from portal_backend.schemas import TaskCreateBody

    with db_cursor() as (conn, cur):
        f = qs.load_finding(cur, fid)
        cid = str(f["container_id"])
        who = qs.actor(cur, request, cid, body.actor_agent_id)
        if body.action != "file":
            if f["status"] == "filed":
                raise HTTPException(409, "this finding was already filed as a task")
            status = "dismissed" if body.action == "dismiss" else "open"
            cur.execute("UPDATE qa_findings SET status=%s WHERE id=%s", (status, fid))
            log_event(cur, cid, "ai" if who["kind"] != "human" else "human", who["id"], "qa_finding", fid,
                      f"qa_finding_{'dismissed' if status == 'dismissed' else 'reopened'}", {})
            out = qs.public(qs.load_finding(cur, fid))
            conn.commit()
            return out
        if f["status"] == "filed":
            raise HTTPException(409, "this finding was already filed as a task")
        if f["status"] == "dismissed":
            raise HTTPException(409, "this finding was dismissed; reopen it before filing it")
        assignee_alias = None
        if body.assignee_agent_id:
            qs.require_uuid(body.assignee_agent_id, "assignee_agent_id")
            cur.execute("SELECT alias, container_id, terminated_at FROM agents WHERE id=%s",
                        (body.assignee_agent_id,))
            a = cur.fetchone()
            if not a or str(a["container_id"]) != cid:
                raise HTTPException(404, "the assignee is not a member of this project")
            if a["terminated_at"] is not None:
                raise HTTPException(409, "the assignee is retired")
            assignee_alias = a["alias"]
        s = qs.load_session(cur, str(f["session_id"]))
        title, description, dod = _finding_task_texts(f, s)
        if body.title and body.title.strip():
            title = body.title.strip()
    created = task_creation_routes.create_task(
        cid,
        TaskCreateBody(title=title, description=description, definition_of_done=dod,
                       created_by_agent_id=who["id"], assignee_alias=assignee_alias),
        qs.internal_request(),
    )
    tid = str(created["task_id"])
    with db_cursor() as (conn, cur):
        cur.execute("UPDATE qa_findings SET status='filed', filed_task_id=%s WHERE id=%s", (tid, fid))
        log_event(cur, cid, "ai" if who["kind"] != "human" else "human", who["id"], "qa_finding", fid,
                  "qa_finding_filed", {"task_id": tid})
        out = qs.public(qs.load_finding(cur, fid))
        conn.commit()
    out["task"] = created
    return out


# ---------------------------------------------------------------- flows and walks

@app.get("/api/containers/{cid}/qa/flows")
def list_qa_flows(cid: str, request: Request, platform: Optional[str] = Query(default=None)):
    if platform is not None:
        qs.require_platform(platform)
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
        q, args = "SELECT * FROM qa_flows WHERE container_id=%s", [cid]
        if platform:
            q += " AND platform=%s"
            args.append(platform)
        cur.execute(q + " ORDER BY platform, score DESC, created_at", tuple(args))
        return {"flows": [qs.public(r) for r in cur.fetchall()]}


@app.post("/api/containers/{cid}/qa/flows")
def post_qa_flows(cid: str, body: FlowsBody, request: Request):
    """Upsert flows by key (from the name when missing)."""
    with db_cursor() as (conn, cur):
        qs.container_read(cur, request, cid)
        qs.actor(cur, request, cid, body.actor_agent_id)
        out = qs.upsert_flows(cur, cid, body.platform, [f.model_dump() for f in body.flows], body.source)
        qa_explorations.snapshot_app_model(cur, cid, body.platform, "plan", f"{len(body.flows)} flows queued")
        conn.commit()
    return {"flows": out}


@app.post("/api/qa/sessions/{sid}/walks/next")
def next_qa_walk(sid: str, body: ActorBody, request: Request):
    """{walk, flow} for the best-ranked flow (never walked +40, failed recently +30,
    criticality +30/+20/+10, uncovered +10), or {walk: null} when the queue is empty. A walk
    still walking in this session is returned again (resumed: true)."""
    with db_cursor() as (conn, cur):
        s, _who = _session_in(cur, request, sid, body.actor_agent_id)
        _running(s)
        out = qs.next_walk(cur, s)
        conn.commit()
    return out


@app.patch("/api/qa/walks/{wid}")
def patch_qa_walk(wid: str, body: WalkPatchBody, request: Request):
    """{step} records one step of the walk; {outcome, reason?, blocked_kind?, end_seq?} ends it.
    Steps are 0-based (the flow's first step is index 0). A step past the flow's last one, or any
    step of a flow with none, is appended. A walk passes only once its last recorded step is
    reached."""
    if (body.step is None) == (body.outcome is None):
        raise HTTPException(400, "send either a step or an outcome")
    with db_cursor() as (conn, cur):
        w = qs.load_walk(cur, wid)
        qs.actor(cur, request, str(w["container_id"]), body.actor_agent_id)
        if w["status"] != "walking":
            raise HTTPException(409, f"this walk already ended ({w['status']})")
        if body.step is not None:
            for k in ("finding_id", "frame_id"):
                v = getattr(body.step, k)
                if v:
                    qs.require_uuid(v, k)
            w = qs.walk_step(cur, w, body.step.model_dump())
        else:
            w = qs.end_walk(cur, w, body.outcome, body.reason, body.blocked_kind, body.end_seq)
            flow = qs.load_flow(cur, str(w["flow_id"]))
            qa_explorations.snapshot_app_model(cur, str(w["container_id"]), flow["platform"], "walks", f"{flow['name']}: {body.outcome}")
        out = {"walk": qs.public(w), "flow": qs.public(qs.load_flow(cur, str(w["flow_id"])))}
        conn.commit()
    return out


# ---------------------------------------------------------------- scenarios

@app.get("/api/containers/{cid}/qa/scenarios")
def list_qa_scenarios(cid: str, request: Request, platform: Optional[str] = Query(default=None),
                      status: Optional[str] = Query(default=None)):
    if platform is not None:
        qs.require_platform(platform)
    if status is not None and status not in qa_scenarios.STATUSES:
        raise HTTPException(400, f"status must be one of {', '.join(qa_scenarios.STATUSES)}")
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
        due = qa_scenarios.paused_due(cur, cid)
    if due:  # this page polls: it takes the write lock only with something to write
        with db_cursor() as (conn, cur):
            qa_scenarios.resume_due(cur, cid)
            conn.commit()
    with db_cursor(readonly=True) as (_, cur):
        return {"scenarios": qa_scenario_health.mark_suspicious(cur, cid, qa_scenarios.list_scenarios(cur, cid, platform, status))}


@app.get("/api/containers/{cid}/qa/scenarios/export.md")
def export_qa_scenarios(cid: str, request: Request, platform: Optional[str] = Query(default=None),
                        status: str = Query(default="validated")):
    if platform is not None:
        qs.require_platform(platform)
    if status not in qa_scenarios.STATUSES:
        raise HTTPException(400, f"status must be one of {', '.join(qa_scenarios.STATUSES)}")
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
        rows = qa_scenarios.list_scenarios(cur, cid, platform, status)
    return PlainTextResponse(qa_scenarios.export(rows), media_type="text/markdown; charset=utf-8")


@app.post("/api/containers/{cid}/qa/scenarios")
def propose_qa_scenario(cid: str, body: ScenarioProposeBody, request: Request):
    """{outcome: created | updated | suggested, scenario[, suggestion]}. A scenario that is not a
    draft is never changed by a proposal: it gets a suggestion a person decides."""
    fields, evidence = _scenario_fields(body)
    fields["name"], fields["criteria"] = " ".join(body.name.split()), _criteria(body.criteria)
    with db_cursor() as (conn, cur):
        qs.container_read(cur, request, cid)
        who = qs.actor(cur, request, cid, body.actor_agent_id)
        out = qa_scenarios.propose(cur, cid, who, body.platform, fields, evidence, body.reason)
        conn.commit()
    return out


@app.get("/api/qa/scenarios/{scid}")
def get_qa_scenario(scid: str, request: Request):
    with db_cursor(readonly=True) as (_, cur):
        row = qs.load_scenario(cur, scid)
        require_member_read(cur, request, str(row["container_id"]))
        return qa_scenarios.detail(cur, row)


@app.patch("/api/qa/scenarios/{scid}")
def patch_qa_scenario(scid: str, body: ScenarioPatchBody, request: Request):
    """An agent revises a draft (a non-draft gets a suggestion instead); a person may change
    any field, the status included."""
    fields, evidence = _scenario_fields(body)
    with db_cursor() as (conn, cur):
        row = qs.load_scenario(cur, scid)
        cid = str(row["container_id"])
        who = qs.actor(cur, request, cid, body.actor_agent_id)
        out = qa_scenarios.revise(cur, row, who, fields, evidence, body.status, body.reason)
        if body.status is not None and who["kind"] == "human":
            log_event(cur, cid, "human", who["id"], "qa_scenario", scid, "qa_scenario_status",
                      {"status": body.status})
        conn.commit()
    return out


@app.post("/api/containers/{cid}/qa/scenarios/status")
def set_qa_scenario_status(cid: str, body: ScenarioStatusBody, request: Request):
    """Validate, pause, retire, or send back to draft. A person only."""
    for i in body.ids:
        qs.require_uuid(i, "scenario")
    with db_cursor() as (conn, cur):
        qs.container_read(cur, request, cid)
        who = qs.human(cur, request, cid, body.actor_agent_id, "change a scenario's status")
        rows = qa_scenarios.set_status(cur, cid, who, body.ids, body.status, body.reason, body.until, body.issue,
                                       body.replaced_by)
        log_event(cur, cid, "human", who["id"], "container", cid, "qa_scenario_status",
                  {"status": body.status, "ids": [r["id"] for r in rows]})
        conn.commit()
    return {"status": body.status, "scenarios": rows}


@app.get("/api/containers/{cid}/qa/suggestions")
def list_qa_suggestions(cid: str, request: Request, status: Optional[str] = Query(default="proposal")):
    if status is not None and status not in ("proposal", "accepted", "dismissed"):
        raise HTTPException(400, "status must be proposal, accepted or dismissed")
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
        return {"suggestions": qa_scenarios.list_suggestions(cur, cid, status)}


@app.post("/api/qa/suggestions/{gid}")
def decide_qa_suggestion(gid: str, body: DecisionBody, request: Request):
    """Accept (apply the proposal; the scenario keeps its status) or dismiss. A person only."""
    with db_cursor() as (conn, cur):
        g = qs.load_suggestion(cur, gid)
        cid = str(g["container_id"])
        who = qs.human(cur, request, cid, body.actor_agent_id, "decide a suggestion")
        out = qa_scenarios.decide(cur, g, who, body.decision)
        log_event(cur, cid, "human", who["id"], "qa_scenario", str(g["scenario_id"]), "qa_suggestion_decided",
                  {"suggestion_id": gid, "decision": body.decision})
        conn.commit()
    return out


# ---------------------------------------------------------------- verdicts

@app.post("/api/qa/sessions/{sid}/verdicts", status_code=201)
def add_qa_verdict(sid: str, body: VerdictBody, request: Request):
    """One verdict on a scenario's criterion, on an acceptance line of the session's QA request, or
    on both at once. The answer is the verdict row, or the line's row when it names no scenario."""
    if body.scenario_id is None and body.acceptance_line is None:
        raise HTTPException(400, "a verdict names a scenario's criterion or an acceptance line")
    if (body.scenario_id is None) != (body.criterion_index is None):
        raise HTTPException(400, "a scenario's verdict names both scenario_id and criterion_index")
    if body.scenario_id is not None:
        qs.require_uuid(body.scenario_id, "scenario_id")
    with db_cursor() as (conn, cur):
        s, _who = _session_in(cur, request, sid, body.actor_agent_id)
        cid = str(s["container_id"])
        frames = qs.require_frames_in(cur, cid, body.frame_ids)
        out, sc = None, None
        if body.scenario_id is not None:
            sc = qs.load_scenario(cur, body.scenario_id)
            if str(sc["container_id"]) != cid:
                raise HTTPException(400, "that scenario belongs to another project")
            n = len(qs._json(sc.get("criteria"), []))
            if body.criterion_index >= n:
                raise HTTPException(400, f"this scenario has criteria 0 to {n - 1}")
        line = None
        if body.acceptance_line is not None:
            line = qa_handoff.add_line_verdict(cur, s, line=body.acceptance_line, verdict=body.verdict, note=body.note, frames=frames,
                                               scenario_id=body.scenario_id, criterion_index=body.criterion_index)
        if sc is not None:
            vid = qs.new_id()
            cur.execute(
                """INSERT INTO qa_verdicts (id, container_id, session_id, scenario_id, criterion_index, verdict, note,
                                            frame_ids, check_fix, check_repairs, example_row, created_at, request_id)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (vid, cid, sid, body.scenario_id, body.criterion_index, body.verdict, body.note, qs.dumps(frames),
                 qs.dumps(body.check_fix) if body.check_fix else None, qs.dumps(body.check_repairs or []), body.example_row,
                 qs.now(), s.get("request_id")),
            )
            cur.execute("SELECT * FROM qa_verdicts WHERE id=%s", (vid,))
            out = qs.public(cur.fetchone())
            qa_scenarios.after_verdict(cur, dict(sc))
        conn.commit()
    return out if out is not None else line


# ---------------------------------------------------------------- a task's QA

@app.get("/api/tasks/{tid}/qa")
def get_task_qa(tid: str, request: Request):
    """The task's QA sessions, findings (its own and those filed as it), drafted scenarios and
    the verdicts its sessions gave, its `run_result` and its last `final_decision`. A task handed to
    QA also lists what those requests' QA tasks produced: that work runs on the QA task."""
    if not valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    with db_cursor(readonly=True) as (_, cur):
        task = require_task(cur, tid)
        require_member_read(cur, request, str(task["container_id"]))
        cur.execute("SELECT qa_task_id FROM qa_requests WHERE source_task_id=%s AND qa_task_id IS NOT NULL", (tid,))
        tasks = (sql.list_param(sorted({tid, *(str(r["qa_task_id"]) for r in cur.fetchall())})),)
        cur.execute(f"SELECT * FROM qa_sessions WHERE {sql.in_list('task_id')} ORDER BY started_at DESC", tasks)
        sessions = qs.with_names(cur, [qs.public(r) for r in cur.fetchall()])
        cur.execute(f"SELECT * FROM qa_findings WHERE {sql.in_list('task_id')} OR filed_task_id=%s ORDER BY created_at", (*tasks, tid))
        findings = qs.with_names(cur, [qs.public(r) for r in cur.fetchall()])
        cur.execute(f"SELECT * FROM qa_scenarios WHERE {sql.in_list('task_id')} ORDER BY created_at", tasks)
        scenarios = [qs.public(r) for r in cur.fetchall()]
        cur.execute(
            f"""SELECT v.*, s.name AS scenario_name FROM qa_verdicts v
                 JOIN qa_sessions q ON q.id = v.session_id
                 JOIN qa_scenarios s ON s.id = v.scenario_id
                WHERE {sql.in_list('q.task_id')} ORDER BY v.created_at""",
            tasks,
        )
        verdicts = [qs.public(r) for r in cur.fetchall()]
        requests = qa_handoff.task_requests(cur, tid)
        run_result = qa_run_tasks.run_result(cur, tid)
        decision = qa_run_tasks.latest_decision(cur, tid)
        cur.execute("SELECT qa_on_done FROM tasks WHERE id=%s", (tid,))
        on_done = qa_handoff.on_done_of(dict(cur.fetchone() or {}))
    return {"task_id": tid, "on_done": on_done, "sessions": sessions, "findings": findings, "scenarios": scenarios,
            "verdicts": verdicts, "requests": requests, "is_run_task": bool(run_result and run_result["is_run_task"]),
            "run_result": run_result, "final_decision": decision}
