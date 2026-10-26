"""Runner-only workflow launches; capability stays off until combined integration."""

from typing import Optional
from uuid import uuid4

from fastapi import Header, Request
from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse

from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.identity_routes import require_member_read
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


def _runner_run(cur, aid, run_id, credential):
    runner = require_runner(cur, credential, aid)
    workflow, task, execution = lock_run(cur, run_id)
    cur.execute("SELECT runner_credential_id FROM workflow_launch_permits WHERE run_id=%s", (run_id,))
    if str(cur.fetchone()["runner_credential_id"]) != str(runner["id"]):
        conflict("wrong_runner", "This worker belongs to another runner.", status=403)
    return runner, workflow, task, execution


@app.post("/api/agents/{aid}/runs/reserve", status_code=201)
def reserve_worker(aid: str, body: WorkflowReserve,
                   x_orcha_runner_token: Optional[str] = Header(default=None)):
    require_capability()
    with db_cursor() as (_, cur):
        runner = require_runner(cur, x_orcha_runner_token, aid)
        service = WorkflowService(cur, runtime_hooks_factory())
        t = service.one("SELECT workflow_id,container_id FROM tasks WHERE id=%s", (body.task_id,))
        if not t or not t["workflow_id"] or str(t["container_id"]) != str(runner["container_id"]):
            conflict("workflow_task_required", "A task in this runner's workflow project is required.")
        # Lock before receipt lookup so duplicate reserve calls cannot both schedule.
        service.lock(t["workflow_id"])
        payload = body.model_dump()
        receipt = launch_receipt(cur, runner, x_orcha_runner_token, body.operation_key, payload)
        if receipt:
            return receipt
        service.lock(t["workflow_id"], body.expected_workflow_revision)
        service.task(t["workflow_id"], body.task_id, body.expected_work_revision)
        execution = service.reserve_turn(body.task_id, WorkflowActor(aid, True, True), run_id=str(uuid4()))
        return preallocate_run(cur, execution, runner, x_orcha_runner_token, operation_key=body.operation_key, payload=payload)


@app.post("/api/agents/{aid}/runs/{rid}/activate")
def activate_worker(aid: str, rid: str, body: WorkflowActivate):
    require_capability()
    with db_cursor() as (_, cur):
        _, _, execution = lock_run(cur, rid)
        return activate(cur, execution, aid=aid, run_id=rid, **body.model_dump())


@app.post("/api/agents/{aid}/runs/{rid}/abort-launch")
def abort_worker_launch(aid: str, rid: str, x_orcha_runner_token: Optional[str] = Header(default=None)):
    require_capability()
    with db_cursor() as (_, cur):
        _, w, _, e = _runner_run(cur, aid, rid, x_orcha_runner_token)
        result = abort_launch(cur, e, run_id=rid, terminalize=terminalize)
        WorkflowService(cur, runtime_hooks_factory()).reconcile(str(w["id"]))
        return result


@app.post("/api/agents/{aid}/runs/{rid}/confirm-stopped")
def confirm_worker_stopped(aid: str, rid: str, body: WorkflowStopObserved,
                           x_orcha_runner_token: Optional[str] = Header(default=None)):
    require_capability()
    with db_cursor() as (_, cur):
        _, w, task, e = _runner_run(cur, aid, rid, x_orcha_runner_token)
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
        if (
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
def continue_worker(aid: str, rid: str, body: WorkflowContinue,
                    x_orcha_runner_token: Optional[str] = Header(default=None)):
    require_capability()
    with db_cursor() as (_, cur):
        runner, _, _, e = _runner_run(cur, aid, rid, x_orcha_runner_token)
        return continue_turn(cur, e, runner, x_orcha_runner_token, operation_key=body.operation_key,
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
