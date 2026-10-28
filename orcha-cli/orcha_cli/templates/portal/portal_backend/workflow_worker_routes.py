"""Workflow launches by this Orcha's own scheduler; capability stays off until combined integration."""

from uuid import uuid4

from fastapi import Request
from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse

from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.identity_routes import require_machine_lane_member, require_member_read
from portal_backend.schemas.workflow_workers import WorkflowActivate, WorkflowContinue, WorkflowReserve, WorkflowStopObserved
from portal_backend.workflow_graph import conflict
from portal_backend.workflow_service import WorkflowActor, WorkflowHooks, WorkflowService, require_capability
from portal_backend.workflow_worker_auth import lock_run, record_runner_contact, require_current_generation, token_execution
from portal_backend.workflow_worker_launch import abort_launch, activate, continue_turn, launch_receipt, preallocate_run, require_runner
from portal_backend.workflow_worker_stops import confirm_stopped, release_lost, stop_execution
from portal_backend.workflow_integration import IntegratedWorkflowHooks


def terminalize(cur, run_id, status, *, cause):
    # No fallback that releases capacity when evidence integration is unavailable.
    from portal_backend.workflow_evidence_service import terminalize_workflow_run_with_evidence
    return terminalize_workflow_run_with_evidence(cur, run_id, status, cause=cause)


class WorkflowWorkerHooks(WorkflowHooks):
    """Combine with the task-approval/evidence hooks at the integration boundary.

    Inherited availability denies all admission until the coordinator installs the
    authoritative plan/lane/budget/capacity adapter. No request body can override it.
    """
    def request_stop(self, cur, execution, actor, origin, reason):
        if origin == "lost_release":
            return release_lost(cur, execution, actor_id=actor.id, reason=reason, terminalize=terminalize)
        return stop_execution(cur, execution, origin=origin, actor_id=actor.id, reason=reason, operation_key=str(uuid4()))


runtime_hooks_factory = IntegratedWorkflowHooks


def _lane(cur, request, aid):
    """PS-07/PS-37: these routes reserve, activate and stop work AS the AI agent, and
    activation hands out its run token, so they sit on the machine lane like
    embodiment-tokens, wake-claim and run start. A header-less caller (the local
    notifier) passes through; a signed-in person must be a non-viewer member of the
    agent's project who may manage agents. Checked first, before anything is written."""
    cur.execute("SELECT container_id FROM agents WHERE id=%s", (aid,))
    agent = cur.fetchone()
    if agent:
        require_machine_lane_member(cur, request, str(agent["container_id"]))


def _runner_run(cur, aid, run_id):
    runner = require_runner(cur, aid)
    workflow, task, execution = lock_run(cur, run_id)
    cur.execute("SELECT runner_credential_id FROM workflow_launch_permits WHERE run_id=%s", (run_id,))
    if str(cur.fetchone()["runner_credential_id"]) != str(runner["id"]):
        conflict("wrong_runner", "This worker belongs to another runner.", status=403)
    return runner, workflow, task, execution


@app.post("/api/agents/{aid}/runs/reserve", status_code=201)
def reserve_worker(aid: str, body: WorkflowReserve, request: Request):
    require_capability()
    with db_cursor() as (_, cur):
        _lane(cur, request, aid)
        runner = require_runner(cur, aid)
        service = WorkflowService(cur, runtime_hooks_factory())
        t = service.one("SELECT workflow_id,container_id FROM tasks WHERE id=%s", (body.task_id,))
        if not t or not t["workflow_id"] or str(t["container_id"]) != str(runner["container_id"]):
            conflict("workflow_task_required", "A task in this runner's workflow project is required.")
        # Lock before receipt lookup so duplicate reserve calls cannot both schedule.
        service.lock(t["workflow_id"])
        payload = body.model_dump()
        receipt = launch_receipt(cur, runner, body.operation_key, payload)
        if receipt:
            return receipt
        service.lock(t["workflow_id"], body.expected_workflow_revision)
        service.task(t["workflow_id"], body.task_id, body.expected_work_revision)
        execution = service.reserve_turn(body.task_id, WorkflowActor(aid, True, True), run_id=str(uuid4()))
        return preallocate_run(cur, execution, runner, operation_key=body.operation_key, payload=payload)


@app.post("/api/agents/{aid}/runs/{rid}/activate")
def activate_worker(aid: str, rid: str, body: WorkflowActivate, request: Request):
    require_capability()
    with db_cursor() as (_, cur):
        _lane(cur, request, aid)
        _, _, execution = lock_run(cur, rid)
        return activate(cur, execution, aid=aid, run_id=rid, **body.model_dump())


@app.post("/api/agents/{aid}/runs/{rid}/abort-launch")
def abort_worker_launch(aid: str, rid: str, request: Request):
    require_capability()
    with db_cursor() as (_, cur):
        _lane(cur, request, aid)
        _, w, _, e = _runner_run(cur, aid, rid)
        result = abort_launch(cur, e, run_id=rid, terminalize=terminalize)
        WorkflowService(cur, runtime_hooks_factory()).reconcile(str(w["id"]))
        return result


@app.post("/api/agents/{aid}/runs/{rid}/confirm-stopped")
def confirm_worker_stopped(aid: str, rid: str, body: WorkflowStopObserved, request: Request):
    require_capability()
    with db_cursor() as (_, cur):
        _lane(cur, request, aid)
        _, w, task, e = _runner_run(cur, aid, rid)
        result = confirm_stopped(cur, e, run_id=rid, generation=body.generation, terminalize=terminalize)
        svc = WorkflowService(cur, runtime_hooks_factory())
        cur.execute(
            "SELECT * FROM tasks WHERE id=%s",
            (task["id"],),
        )
        current_task = cur.fetchone()
        cur.execute(
            "SELECT * FROM workflow_executions WHERE id=%s",
            (e["id"],),
        )
        current_execution = cur.fetchone()
        from portal_backend.workflow_review_handoff import after_stopped
        after_stopped(svc, w, current_task, current_execution)
        cur.execute("SELECT state FROM workflow_executions WHERE id=%s", (e["id"],))
        result["state"] = cur.fetchone()["state"]
        cur.execute("SELECT id FROM workflow_review_handoffs WHERE source_task_id=%s OR review_task_id=%s LIMIT 1", (task['id'],task['id']))
        has_handoff = cur.fetchone() is not None
        if (
            not has_handoff and
            current_task["status"] == "needs_verification"
            and current_task.get("autonomy") == "on"
            and current_execution["evidence_state"] == "saved"
            and current_execution["current_evidence_set_id"]
        ):
            from portal_backend.workflow_evidence_service import evidence_reference

            detail = svc.accept_task(
                str(task["id"]),
                WorkflowActor(aid, True, True),
                evidence_reference(cur, current_execution["current_evidence_set_id"]),
                expected_revision=w["revision"],
                expected_work_revision=current_task["work_revision"],
                idempotency_key=f"auto-accept:{e['id']}:{e['generation']}",
            )
            result = {**result, "task_status": "completed", "workflow": detail}
        else:
            svc.reconcile(str(w["id"]))
        return result


@app.post("/api/agents/{aid}/runs/{rid}/continue-reserve", status_code=201)
def continue_worker(aid: str, rid: str, body: WorkflowContinue, request: Request):
    require_capability()
    with db_cursor() as (_, cur):
        _lane(cur, request, aid)
        runner, _, _, e = _runner_run(cur, aid, rid)
        return continue_turn(cur, e, runner, operation_key=body.operation_key,
                             payload={"previous_run_id": rid, **body.model_dump()})


@app.get("/api/tasks/{tid}/worker-launch-policy")
def worker_launch_policy(tid: str, request: Request):
    """Legacy launchers ask BEFORE spawning, and refuse unknown policy responses."""
    with db_cursor(readonly=True) as (_, cur):
        cur.execute("SELECT container_id,workflow_id,work_revision FROM tasks WHERE id=%s", (tid,))
        t = cur.fetchone()
        if not t:
            conflict("task_unavailable", "Task not found.", status=404)
        require_member_read(cur, request, str(t["container_id"]))
        return {"task_id": tid, "workflow_id": str(t["workflow_id"]) if t["workflow_id"] else None,
                "requires_reservation": bool(t["workflow_id"]), "work_revision": t["work_revision"]}


def _contact(token):
    # Most run tokens are not workflow-bound. Look them up read-only first so ordinary
    # agent calls never take the SQLite write lock for this check.
    with db_cursor(readonly=True) as (_, cur):
        if not token_execution(cur, token):
            return None
    with db_cursor() as (_, cur):
        return record_runner_contact(cur, token)


@app.middleware("http")
async def workflow_worker_contact(request: Request, call_next):
    token = request.headers.get("X-Orcha-Run-Token")
    if token and request.url.path.startswith("/api/"):
        observed = await run_in_threadpool(_contact, token)
        if observed and request.method not in {"GET", "HEAD", "OPTIONS"}:
            from fastapi import HTTPException
            def check():
                with db_cursor() as (_, cur):
                    require_current_generation(cur, observed["binding"]["agent_id"], token)
            try:
                await run_in_threadpool(check)
            except HTTPException as exc:
                return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)
    return await call_next(request)


from pydantic import BaseModel, Field
from typing import Literal


class ReviewHandoffRequest(BaseModel):
    review_task_id: str
    expected_work_revision: int
    result: str = Field(..., min_length=1, max_length=20000)


class ReviewHandoffVerdict(BaseModel):
    handoff_id: str
    verdict: Literal['clean', 'changes_requested']
    result: str = Field(..., min_length=1, max_length=20000)


def _handoff_worker(cur, request, aid, rid):
    _lane(cur, request, aid)
    token = request.headers.get('X-Orcha-Run-Token')
    task = require_current_generation(cur, aid, token)
    binding = token_execution(cur, token)
    if str(binding['run_id']) != str(rid):
        conflict('wrong_reserved_task', 'Use the current worker for this task.', status=403)
    w, _, e = lock_run(cur, rid)
    if str(e['run_id']) != str(rid) or str(e['task_id']) != str(task['id']) or str(e['claimant_id']) != str(aid):
        conflict('wrong_reserved_task', 'Use the current worker for this task.', status=403)
    svc = WorkflowService(cur, runtime_hooks_factory())
    e = svc.one('SELECT * FROM workflow_executions WHERE id=%s', (e['id'],))
    return svc, w, task, e


@app.post('/api/agents/{aid}/runs/{rid}/review-handoff')
def handoff_review(aid: str, rid: str, body: ReviewHandoffRequest, request: Request):
    from portal_backend.workflow_review_handoff import request_review
    require_capability()
    with db_cursor() as (_, cur):
        svc,w,task,e = _handoff_worker(cur,request,aid,rid)
        if task['work_revision'] != body.expected_work_revision:
            conflict('work_revision_changed', 'Refresh the current task before handing off.')
        review = svc.task(w['id'],body.review_task_id)
        return request_review(svc,w,task,e,review,body.result)


@app.post('/api/agents/{aid}/runs/{rid}/review-verdict')
def handoff_verdict(aid: str, rid: str, body: ReviewHandoffVerdict, request: Request):
    from portal_backend.workflow_review_handoff import record_verdict
    require_capability()
    with db_cursor() as (_, cur):
        svc,w,task,e = _handoff_worker(cur,request,aid,rid)
        return record_verdict(svc,w,task,e,body.handoff_id,body.verdict,body.result)


@app.get('/api/workflows/{wid}/review-handoffs')
def review_handoffs(wid: str, request: Request):
    from portal_backend.workflow_evidence_service import evidence_reference
    with db_cursor(readonly=True) as (_, cur):
        svc = WorkflowService(cur,runtime_hooks_factory())
        w = svc.workflow(wid)
        require_member_read(cur,request,str(w['container_id']))
        rows = svc.rows('SELECT * FROM workflow_review_handoffs WHERE workflow_id=%s ORDER BY created_at,id', (wid,))
        for row in rows:
            e = svc.one('SELECT current_evidence_set_id FROM workflow_executions WHERE id=%s', (row['source_execution_id'],))
            row['reviewed_evidence'] = evidence_reference(cur,e['current_evidence_set_id']) if e and e['current_evidence_set_id'] else None
        return {'handoffs': rows}
