"""Orcha QA handoff routes (migration 096; contract: docs/orcha-qa-plan.md, "Handoff and workflow
integration"; the logic is qa_handoff).

  POST /api/tasks/{tid}/qa/requests   hand a task to QA, from an agent or a person
  POST C/requests, GET C/requests     the same with no source task; the list
  GET  /api/qa/requests/{rid}         one request and everything it led to
  POST /api/qa/requests/{rid}/cancel  the requester or a person stops it
  GET  C/settings, PUT C/settings     the project's QA agent and defaults (PUT: a person)
  GET  C/workflow-presets             drafts for the normal workflow preview and create routes
  GET  C/workflow-blocks              the Quality blocks a workflow can embed
  POST C/workflow-blocks/splice       a block in a draft, checked by the workflow preview
  POST /api/qa/findings/{fid}/triage  record a diagnosis (the agent's `triage_finding`)
  POST /api/qa/findings/{fid}/triage-request   "Triage" on a finding: a request for an agent
  POST /api/qa/findings/{fid}/not-a-bug        a person's call; kept in the memory
  GET  C/triage                       the Triage inbox: untriaged, needs a person, decided
  GET  C/memory, POST C/memory        what people told QA (POST: a person)

C = /api/containers/{cid}/qa. Writes carry actor_agent_id. A QA result is evidence: who has the final
say is the project's `final_decision`, a person's setting.
"""

from __future__ import annotations

from typing import Annotated, Literal, Optional

from fastapi import HTTPException, Query, Request
from pydantic import BaseModel, Field

from portal_backend import qa_blocks, qa_handoff, qa_store as qs, qa_triage
from portal_backend.qa_conditions import Conditions
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.identity_routes import require_member_read
from portal_backend.schemas.workflows import WorkflowDraft
from portal_backend.workflow_graph import conflict


class QaRequestBuild(BaseModel):
    """What to test."""

    branch: Optional[str] = Field(default=None, max_length=300)
    commit: Optional[str] = Field(default=None, max_length=100)
    url: Optional[str] = Field(default=None, max_length=2000)
    app_path: Optional[str] = Field(default=None, max_length=1000)
    notes: Optional[str] = Field(default=None, max_length=2000)


class QaRequestBody(BaseModel):
    actor_agent_id: Optional[str] = None
    kind: Optional[Literal["map", "explore", "draft", "check", "triage"]] = Field(
        default=None, description="Default: check when the project has approved scenarios, else explore")
    finding_ids: list[str] = Field(default_factory=list, max_length=50, description="`triage`: the findings to diagnose")
    platform: Optional[Literal["ios", "android", "web"]] = None
    scenario_ids: list[str] = Field(default_factory=list, max_length=50)
    tags: list[Annotated[str, Field(max_length=60)]] = Field(default_factory=list, max_length=20)
    focus: Optional[str] = Field(default=None, max_length=2000)
    minutes: Optional[int] = Field(default=None, ge=1, le=480)
    acceptance: list[Annotated[str, Field(max_length=1000)]] = Field(
        default_factory=list, max_length=30, description="Lines to prove; default the source task's definition of done")
    build: Optional[QaRequestBuild] = None
    on_fail: Optional[Literal["report", "reopen"]] = Field(default=None, description="Default: the project's setting")
    device: Optional[str] = Field(default=None, max_length=200, description="The device to run on, by name; empty: QA picks")
    conditions: Optional[Conditions] = Field(default=None, description="What the run needs: an OS version, language, text size, "
                                             "account... (qa_conditions)")


class QaOnDoneBody(BaseModel):
    actor_agent_id: Optional[str] = None
    enabled: Optional[bool] = Field(description="True: send it to Quality when its agent finishes it. False: never. "
                                    "Null: the project's Quality trigger decides")
    platform: Optional[Literal["ios", "android", "web"]] = Field(default=None, description="Default: the project's")
    device: Optional[str] = Field(default=None, max_length=200, description="The device to run on, by name; empty: QA picks")
    conditions: Optional[Conditions] = Field(default=None, description="What the run needs (qa_conditions)")
    kind: Optional[Literal["check", "explore"]] = Field(default=None, description="Default: check when the platform has "
                                                        "approved scenarios, else explore")


class QaRequestCancelBody(BaseModel):
    actor_agent_id: Optional[str] = None


class QaSettingsBody(BaseModel):
    actor_agent_id: Optional[str] = None
    agent_id: Optional[str] = Field(default=None, description="The project's QA agent; empty: the agent whose role says QA")
    default_platform: Optional[Literal["ios", "android", "web"]] = None
    trigger: Literal["manual", "ui_changes", "always"] = "manual"
    on_fail: Literal["report", "reopen"] = "report"
    max_rounds: int = Field(default=qa_handoff.DEFAULT_MAX_ROUNDS, ge=1, le=10)
    auto_triage: Literal["off", "critical", "all"] = Field(default="off", description="A failed request outside a workflow "
                                                           "goes to triage. Each run holds a device and spends model time")
    max_per_run: int = Field(default=qa_triage.DEFAULT_MAX_PER_RUN, ge=1, le=20)
    final_decision: Optional[Literal["person", "quality"]] = Field(
        default=None, description="Who has the final say on finished work. Left out, it stays as it is. `quality`: a task finishes "
        "without a person only when every line has strong proof from someone other than its author")


class QaBlockSpliceBody(BaseModel):
    block: str = Field(..., max_length=80, description="A key from GET C/workflow-blocks")
    draft: WorkflowDraft
    after: list[str] = Field(default_factory=list, max_length=3, description="The steps it goes after, by client_key; empty: at the start")
    build_step: Optional[str] = Field(default=None, description="Where work goes back to; default the step before")


class QaDiagnosisBody(BaseModel):
    actor_agent_id: Optional[str] = None
    classification: Literal["product_bug", "test_issue", "environment", "flaky", "agent_error", "duplicate", "not_a_bug"]
    reproduced: Optional[bool] = None
    attempts: Optional[int] = Field(default=None, ge=0, le=50)
    reproductions: Optional[int] = Field(default=None, ge=0, le=50)
    root_cause: Optional[str] = Field(default=None, max_length=4000)
    severity: Optional[Literal["blocker", "major", "minor", "trivial"]] = None
    duplicate_of: Optional[str] = None
    note: Optional[str] = Field(default=None, max_length=4000)
    scenario_id: Optional[str] = None
    frame_ids: list[str] = Field(default_factory=list, max_length=20)
    needs_person: bool = Field(default=False, description="A judgement call: the owner decides")


class QaNotABugBody(BaseModel):
    actor_agent_id: Optional[str] = None
    reason: str = Field(..., min_length=1, max_length=2000)


class QaMemoryBody(BaseModel):
    actor_agent_id: Optional[str] = None
    kind: Literal["not_a_bug", "convention", "decision"]
    text: str = Field(..., min_length=1, max_length=2000)
    scenario_id: Optional[str] = None
    screen_key: Optional[str] = Field(default=None, max_length=300)


def _spec(body: QaRequestBody) -> dict:
    spec = body.model_dump(exclude={"actor_agent_id"})
    spec["build"] = body.build.model_dump(exclude_none=True) or None if body.build else None
    return spec


@app.post("/api/tasks/{tid}/qa/requests", status_code=201)
def create_task_qa_request(tid: str, body: QaRequestBody, request: Request):
    """Hand this task to QA: files the request, creates the linked QA task assigned to the QA agent
    and returns {request, qa_task_id}. A person asking approves the run's plan; an agent's request
    follows the project's rule."""
    qs.require_uuid(tid, "task_id")
    with db_cursor() as (conn, cur):
        cur.execute("SELECT container_id FROM tasks WHERE id=%s", (tid,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, f"task {tid} not found")
        cid = str(row["container_id"])
        qs.container_read(cur, request, cid)
        who = qs.actor(cur, request, cid, body.actor_agent_id)
        conn.commit()
    return qa_handoff.hand_off(cid, who, _spec(body), source_task_id=tid)


@app.put("/api/tasks/{tid}/qa/on-done")
def set_task_qa_on_done(tid: str, body: QaOnDoneBody, request: Request):
    """Send this task to Quality when its agent finishes it, or never, or as the project's trigger
    says (`enabled` null). A person decides. Not for a workflow's task, the root task or a
    cancelled one. Returns {task_id, on_done}."""
    qs.require_uuid(tid, "task_id")
    with db_cursor() as (conn, cur):
        cur.execute("SELECT * FROM tasks WHERE id=%s", (tid,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, f"task {tid} not found")
        task = dict(row)
        cid = str(task["container_id"])
        qs.container_read(cur, request, cid)
        who = qs.human(cur, request, cid, body.actor_agent_id, "choose whether a task goes to Quality")
        value = qa_handoff.set_on_done(cur, task, who, enabled=body.enabled, platform=body.platform, device=body.device, kind=body.kind,
                                       conditions=body.conditions)
        conn.commit()
    return {"task_id": tid, "on_done": value}


@app.post("/api/containers/{cid}/qa/requests", status_code=201)
def create_qa_request(cid: str, body: QaRequestBody, request: Request):
    """A handoff with no source task: the result goes back to whoever asked."""
    with db_cursor() as (conn, cur):
        qs.container_read(cur, request, cid)
        who = qs.actor(cur, request, cid, body.actor_agent_id)
        conn.commit()
    return qa_handoff.hand_off(cid, who, _spec(body))


@app.get("/api/containers/{cid}/qa/requests")
def list_qa_requests(cid: str, request: Request, status: Optional[str] = Query(default=None),
                     kind: Optional[str] = Query(default=None), source_task_id: Optional[str] = Query(default=None),
                     source_workflow_id: Optional[str] = Query(default=None), limit: int = Query(default=50, ge=1, le=200)):
    for value, what in ((source_task_id, "source_task_id"), (source_workflow_id, "source_workflow_id")):
        if value is not None:
            qs.require_uuid(value, what)
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
        return {"requests": qa_handoff.list_requests(cur, cid, status=status, kind=kind, source_task_id=source_task_id,
                                                     source_workflow_id=source_workflow_id, limit=limit)}


@app.get("/api/qa/requests/{rid}")
def get_qa_request(rid: str, request: Request):
    with db_cursor(readonly=True) as (_, cur):
        row = qa_handoff.load(cur, rid)
        require_member_read(cur, request, str(row["container_id"]))
        return qa_handoff.detail(cur, row)


@app.post("/api/qa/requests/{rid}/cancel")
def cancel_qa_request(rid: str, body: QaRequestCancelBody, request: Request):
    with db_cursor() as (conn, cur):
        row = qa_handoff.load(cur, rid)
        cid = str(row["container_id"])
        who = qs.actor(cur, request, cid, body.actor_agent_id)
        conn.commit()
    return qa_handoff.cancel(cid, rid, who, request)


@app.get("/api/containers/{cid}/qa/settings")
def get_qa_settings(cid: str, request: Request):
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
        return qa_handoff.settings(cur, cid)


@app.put("/api/containers/{cid}/qa/settings")
def put_qa_settings(cid: str, body: QaSettingsBody, request: Request):
    with db_cursor() as (conn, cur):
        qs.container_read(cur, request, cid)
        who = qs.human(cur, request, cid, body.actor_agent_id, "change the QA settings")
        out = qa_handoff.save_settings(cur, cid, who, agent_id=body.agent_id or None, default_platform=body.default_platform,
                                       trigger=body.trigger, on_fail=body.on_fail, max_rounds=body.max_rounds,
                                       auto_triage=body.auto_triage, max_per_run=body.max_per_run, final_decision=body.final_decision)
        conn.commit()
    return out


@app.get("/api/containers/{cid}/qa/workflow-presets")
def qa_workflow_presets(cid: str, request: Request):
    """{presets: [{key, name, description, draft}]}: `draft` is a WorkflowDraft for
    POST /api/containers/{cid}/workflows/preview and POST /api/containers/{cid}/workflows."""
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
        return {"presets": qa_blocks.presets(cur, cid)}


@app.get("/api/containers/{cid}/qa/workflow-blocks")
def qa_workflow_blocks(cid: str, request: Request):
    """{blocks: [{key, name, description, placeholders, tails, closing, draft}]}: each `draft` is shaped
    like a preset's, with its own steps, and may name `build` (the step before) and `next` (what follows)."""
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
        return {"blocks": qa_blocks.catalogue(cur, cid)}


@app.post("/api/containers/{cid}/qa/workflow-blocks/splice")
def splice_qa_workflow_block(cid: str, body: QaBlockSpliceBody, request: Request):
    """The draft with the block in it: {draft, added, preview}. Checked by the same preview as any
    draft, so a splice the engine refuses comes back as 422 {code, message} and changes nothing."""
    from pydantic import ValidationError

    from portal_backend import workflow_service as service
    from portal_backend.workflow_integration import IntegratedWorkflowHooks

    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
        block = next((b for b in qa_blocks.catalogue(cur, cid) if b["key"] == body.block), None)
        if block is None:
            conflict("unknown_block", "That Quality block does not exist.", status=404)
        draft, added = qa_blocks.splice(body.draft.model_dump(mode="json"), block, body.after, body.build_step)
        try:
            WorkflowDraft.model_validate(draft)
        except ValidationError as e:
            where = e.errors()[0]
            limit = "depends_on" in where["loc"]
            conflict("block_does_not_fit", "A step can wait for at most three others, and this would make it four."
                     if limit else "This block does not fit the workflow here.", status=422)
        preview = service.WorkflowService(cur, IntegratedWorkflowHooks()).preview_draft(cid, draft)
    return {"draft": draft, "added": added, "preview": preview}


@app.post("/api/qa/findings/{fid}/triage")
def triage_qa_finding(fid: str, body: QaDiagnosisBody, request: Request):
    """Record a diagnosis and do what it means (`action` says what). A product bug below major is
    filed as a backlog task, after this commit. `not_a_bug` is refused: a person uses not-a-bug."""
    from portal_backend import qa_routes

    with db_cursor() as (conn, cur):
        f = qs.load_finding(cur, fid)
        cid = str(f["container_id"])
        who = qs.actor(cur, request, cid, body.actor_agent_id)
        out = qa_triage.record_diagnosis(
            cur, f, who, classification=body.classification, reproduced=body.reproduced, attempts=body.attempts,
            reproductions=body.reproductions, root_cause=body.root_cause, severity=body.severity, duplicate_of=body.duplicate_of,
            note=body.note, scenario_id=body.scenario_id, frame_ids=body.frame_ids, needs_person=body.needs_person)
        conn.commit()
    if out.pop("file"):
        filed = qa_routes.patch_qa_finding(fid, qa_routes.FindingPatchBody(action="file", actor_agent_id=who["id"]), qs.internal_request())
        return {**filed, "action": out["action"]}
    return out


class QaTriageRequestBody(BaseModel):
    actor_agent_id: Optional[str] = None
    conditions: Optional[Conditions] = Field(default=None, description="Reproduce it under these; default: the finding's own")


@app.post("/api/qa/findings/{fid}/triage-request", status_code=201)
def request_qa_triage(fid: str, body: QaTriageRequestBody, request: Request):
    """"Triage" on a finding: a triage request for the QA agent. {request, qa_task_id}. It reproduces
    the finding under `conditions`, else under the finding's own."""
    with db_cursor() as (conn, cur):
        f = qs.load_finding(cur, fid)
        cid = str(f["container_id"])
        who = qs.actor(cur, request, cid, body.actor_agent_id)
        conn.commit()
    return qa_handoff.triage_findings(cid, who, [fid], body.conditions)


@app.post("/api/qa/findings/{fid}/not-a-bug")
def mark_qa_finding_not_a_bug(fid: str, body: QaNotABugBody, request: Request):
    """A person's call: dismissed, kept in the memory, and QA agents never report it again."""
    with db_cursor() as (conn, cur):
        f = qs.load_finding(cur, fid)
        who = qs.human(cur, request, str(f["container_id"]), body.actor_agent_id, "mark a finding not a bug")
        out = qa_triage.mark_not_a_bug(cur, f, who, body.reason)
        conn.commit()
    return out


@app.get("/api/containers/{cid}/qa/triage")
def get_qa_triage(cid: str, request: Request):
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
        return qa_triage.inbox(cur, cid)


@app.get("/api/containers/{cid}/qa/memory")
def get_qa_memory(cid: str, request: Request):
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
        return {"memory": qa_triage.memory(cur, cid)}


@app.post("/api/containers/{cid}/qa/memory", status_code=201)
def add_qa_memory(cid: str, body: QaMemoryBody, request: Request):
    with db_cursor() as (conn, cur):
        qs.container_read(cur, request, cid)
        who = qs.human(cur, request, cid, body.actor_agent_id, "tell QA what to remember")
        out = qa_triage.add_memory(cur, cid, who, body.kind, body.text, scenario_id=body.scenario_id, screen_key=body.screen_key)
        conn.commit()
    return out
