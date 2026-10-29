"""Workflows API with separate hosted, local-human, and worker trust lanes.

Hosted browsers use the proxy-verified login. A local portal may name the human
selected in its UI, and the server validates that person against the live project
membership. Authenticated work tokens remain the only agent identity lane.
"""

from typing import Literal

from fastapi import HTTPException, Request, Query

from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import valid_uuid
from portal_backend.identity_routes import (
    proxy_login,
    require_member_read,
    _proxy_trusted,
)
from portal_backend.schemas import workflows as model
from portal_backend import workflow_routing as routing
from portal_backend import workflow_service as service
from portal_backend.workflow_graph import conflict, validate_graph
from portal_backend.worker_auth import require_work_lane
from portal_backend.workflow_integration import IntegratedWorkflowHooks

HOOKS = IntegratedWorkflowHooks()
LOCAL_ACTOR_HEADER = "X-Orcha-Local-Actor"


def _local_actor_claim(request, claimed_actor_id=None):
    """Return the selected human only when proxy identity is not authoritative.

    Local Orcha has no sign-in boundary, including when its owner exposes it on the
    LAN. The selected identity is only a claim: every write revalidates its live
    project membership below. Proxy trust always wins and ignores local claims.
    """
    if _proxy_trusted():
        return None
    header_actor = (request.headers.get(LOCAL_ACTOR_HEADER) or "").strip() or None
    claimed_actor = str(claimed_actor_id).strip() if claimed_actor_id else None
    if header_actor and claimed_actor and header_actor != claimed_actor:
        conflict(
            "actor_mismatch",
            "The selected local project member changed. Refresh and try again.",
            status=403,
        )
    return claimed_actor or header_actor


def resolve_human_actor(cur, request, cid, *, claimed_actor_id=None):
    """Resolve a live non-viewer human through the hosted or local trust lane."""
    login = proxy_login(request)
    if not login:
        local_actor_id = _local_actor_claim(request, claimed_actor_id)
        if local_actor_id:
            cur.execute(
                """SELECT id,kind,member_role FROM agents
                   WHERE id=%s AND container_id=%s AND terminated_at IS NULL""",
                (local_actor_id, cid),
            )
            row = cur.fetchone()
            if not row or row["member_role"] == "viewer":
                conflict(
                    "verified_member_required",
                    "A current non-viewer project membership is required.",
                    status=403,
                )
            if row["kind"] != "human":
                conflict(
                    "human_required",
                    "Choose a human project member for this action.",
                    status=403,
                )
            return service.WorkflowActor(str(row["id"]), True)
        conflict(
            "verified_sign_in_required" if _proxy_trusted() else "human_required",
            "Choose a current human member of this project. Hosted proxy deployments use "
            "the verified signed-in member.",
            status=403,
        )
    cur.execute(
        "SELECT id FROM agents WHERE container_id=%s AND kind='human' AND terminated_at IS NULL AND member_role<>'viewer' AND lower(github_login)=lower(%s)",
        (cid, login),
    )
    rows = cur.fetchall()
    if len(rows) != 1:
        conflict(
            "verified_member_required",
            "A unique current project membership is required.",
            status=403,
        )
    return service.WorkflowActor(str(rows[0]["id"]), True)


def resolve_actor(cur, request, cid, *, allow_agent=False):
    token = request.headers.get("X-Orcha-Run-Token")
    if allow_agent and token:
        cur.execute(
            "SELECT agent_id FROM embodiment_tokens WHERE run_token=%s AND revoked_at IS NULL AND lane='work'",
            (token,),
        )
        row = cur.fetchone()
        if not row:
            conflict(
                "work_lane_required",
                "An authenticated work session is required.",
                status=403,
            )
        aid = str(row["agent_id"])
        require_work_lane(cur, aid, token, request)
        actor = service.WorkflowActor(aid, True, True)
        service.WorkflowService(cur, HOOKS).actor(actor, cid)
        return actor
    if token:
        conflict(
            "human_required",
            "A worker token cannot authorize a human action.",
            status=403,
        )
    return resolve_human_actor(cur, request, cid)


def read_context(cur, request, wid):
    svc = service.WorkflowService(cur, HOOKS)
    w = svc.workflow(wid)
    require_member_read(cur, request, w["container_id"])
    actor = None
    if proxy_login(request) or _local_actor_claim(request):
        try:
            actor = resolve_actor(cur, request, w["container_id"])
        except Exception as exc:
            from fastapi import HTTPException

            if not isinstance(exc, HTTPException):
                raise
    return svc, w, actor


@app.get("/api/containers/{cid}/workflows/capability", response_model=model.Capability)
def workflow_capability(cid: str, request: Request):
    with db_cursor(readonly=True) as (_, cur):
        require_member_read(cur, request, cid)
        flexible = routing.capability()
        if not service.WORKFLOWS_INTEGRATED:
            return model.Capability(**flexible)
        try:
            resolve_actor(cur, request, cid)
            return model.Capability(workflow_human_write=True, reason=None, **flexible)
        except Exception as exc:
            from fastapi import HTTPException

            if not isinstance(exc, HTTPException):
                raise
            return model.Capability(reason=exc.detail["code"], **flexible)


@app.get("/api/containers/{cid}/workflows", response_model=model.WorkflowList)
def list_workflows(
    cid: str,
    request: Request,
    status: str | None = None,
    cursor: str | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    visibility: Literal["visible", "hidden", "all"] = Query(
        default="visible",
        description="GH #350 §4.14: `visible` (default) excludes hidden workflows, `hidden` "
        "lists only hidden ones for the Hidden workflows view, `all` returns both.",
    ),
):
    with db_cursor(readonly=True) as (_, cur):
        require_member_read(cur, request, cid)
        svc = service.WorkflowService(cur, HOOKS)
        query = "SELECT id FROM workflows WHERE container_id=%s"
        params = [cid]
        if status:
            query += " AND status=%s"
            params.append(status)
        if visibility == "visible":
            query += " AND hidden_at IS NULL"
        elif visibility == "hidden":
            query += " AND hidden_at IS NOT NULL"
        if cursor:
            query += " AND id>%s"
            params.append(cursor)
        query += " ORDER BY id LIMIT %s"
        params.append(limit + 1)
        rows = svc.rows(query, tuple(params))
        actor = None
        if proxy_login(request) or _local_actor_claim(request):
            from fastapi import HTTPException

            try:
                actor = resolve_actor(cur, request, cid)
            except HTTPException:
                pass
        return {
            "workflows": [svc.detail(r["id"], actor) for r in rows[:limit]],
            "capability": workflow_capability(cid, request),
            "next_cursor": rows[limit - 1]["id"] if len(rows) > limit else None,
        }


@app.get(
    "/api/containers/{cid}/workflow-task-search",
    response_model=model.WorkflowTaskSearch,
)
def search_workflow_tasks(
    cid: str,
    request: Request,
    query: str = Query(default="", max_length=200),
    selected: list[str] = Query(default_factory=list, max_length=200),
    limit: int = Query(default=5, ge=1, le=5),
):
    """Return a bounded picker page and only the draft's selected task records."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    selected_ids = list(dict.fromkeys(selected))
    if any(not valid_uuid(task_id) for task_id in selected_ids):
        raise HTTPException(400, "selected task id is not a valid UUID")
    fields = "id,title,status,is_root,workflow_id"
    with db_cursor(readonly=True) as (_, cur):
        require_member_read(cur, request, cid)
        selected_rows = []
        if selected_ids:
            placeholders = ",".join("%s" for _ in selected_ids)
            cur.execute(
                f"SELECT {fields} FROM tasks WHERE container_id=%s "
                f"AND id IN ({placeholders})",
                (cid, *selected_ids),
            )
            by_id = {str(row["id"]): row for row in cur.fetchall()}
            selected_rows = [
                service._row(by_id[task_id])
                for task_id in selected_ids
                if task_id in by_id
            ]

        where = "container_id=%s"
        params: list[object] = [cid]
        term = query.strip().lower()
        if term:
            escaped = (
                term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            )
            where += " AND lower(title) LIKE %s ESCAPE '\\'"
            params.append(f"%{escaped}%")
        if selected_ids:
            placeholders = ",".join("%s" for _ in selected_ids)
            where += f" AND id NOT IN ({placeholders})"
            params.extend(selected_ids)
        cur.execute(
            f"SELECT {fields} FROM tasks WHERE {where} "
            "ORDER BY lower(title),created_at,id LIMIT %s",
            (*params, limit),
        )
        results = [service._row(row) for row in cur.fetchall()]
    return {"results": results, "selected": selected_rows}


@app.post("/api/containers/{cid}/workflows/preview", response_model=model.Preview)
def preview_workflow(cid: str, body: model.WorkflowDraft, request: Request):
    with db_cursor(readonly=True) as (_, cur):
        require_member_read(cur, request, cid)
        resolve_actor(cur, request, cid)
        svc = service.WorkflowService(cur, HOOKS)
        return svc.preview_draft(cid, body.model_dump(mode="json"))


@app.post(
    "/api/containers/{cid}/workflows",
    response_model=model.WorkflowDetail,
    status_code=201,
)
def create_workflow(cid: str, body: model.WorkflowCreate, request: Request):
    service.require_capability()
    with db_cursor() as (_, cur):
        actor = resolve_actor(cur, request, cid)
        return service.WorkflowService(cur, HOOKS).mutate(
            cid, actor, "create", body.model_dump(mode="json")
        )


@app.get("/api/workflows/{wid}", response_model=model.WorkflowDetail)
def get_workflow(wid: str, request: Request):
    with db_cursor(readonly=True) as (_, cur):
        svc, _, actor = read_context(cur, request, wid)
        return svc.detail(wid, actor)


@app.get("/api/workflows/{wid}/completion-check", response_model=model.CompletionCheck)
def workflow_completion(wid: str, request: Request):
    with db_cursor(readonly=True) as (_, cur):
        svc, _, _ = read_context(cur, request, wid)
        return svc.snapshot(wid)["completion"]


@app.get("/api/workflows/{wid}/tasks", response_model=list[model.WorkflowTask])
def workflow_tasks(wid: str, request: Request):
    return get_workflow(wid, request)["tasks"]


@app.get("/api/workflows/{wid}/dependencies", response_model=dict[str, list[str]])
def workflow_dependencies(wid: str, request: Request):
    with db_cursor(readonly=True) as (_, cur):
        svc, _, _ = read_context(cur, request, wid)
        return svc.snapshot(wid)["dependencies"]


def _ids(values):
    return [v for value in values for v in value.split(",") if v]


def _impact(wid, request, kind, task_ids=(), holds=("start",)):
    with db_cursor(readonly=True) as (_, cur):
        svc, _, actor = read_context(cur, request, wid)
        return svc.impact(wid, actor, kind, _ids(task_ids), list(holds))


@app.get("/api/workflows/{wid}/start-check", response_model=model.WorkflowImpact)
def workflow_start_check(
    wid: str, request: Request, task_ids: list[str] = Query(default_factory=list)
):
    """Per-task result of Start for the selected (default: all prepared) tasks;
    selected IDs/revisions are echoed by the mutation, which revalidates."""
    return _impact(wid, request, "start", task_ids)


@app.get("/api/workflows/{wid}/release-check", response_model=model.WorkflowImpact)
def workflow_release_check(
    wid: str,
    request: Request,
    task_ids: list[str] = Query(default_factory=list),
    holds: list[Literal["start", "human"]] = Query(default=["start"]),
):
    """Per-task result of releasing the named holds on the selected tasks."""
    return _impact(wid, request, "release", task_ids, holds)


@app.get(
    "/api/workflows/{wid}/cancellation-check", response_model=model.WorkflowImpact
)
def workflow_cancellation_check(wid: str, request: Request):
    """Counts by task state, accepted results kept and named workers to stop."""
    return _impact(wid, request, "cancellation")


@app.get(
    "/api/workflows/{wid}/visibility-check", response_model=model.VisibilityCheck
)
def workflow_visibility_check(wid: str, request: Request):
    """GH #350 §4.14: fresh Hide / Restore eligibility (finished, no live worker turn,
    current hidden state) with the exact blockers; read-only."""
    with db_cursor(readonly=True) as (_, cur):
        svc, _w, _actor = read_context(cur, request, wid)
        return svc.visibility_check(wid)


@app.post("/api/workflows/{wid}/import-preview", response_model=model.Preview)
def workflow_import_preview(wid: str, body: model.ImportPreview, request: Request):
    with db_cursor(readonly=True) as (_, cur):
        svc, w, _ = read_context(cur, request, wid)
        actor = resolve_actor(cur, request, w["container_id"])
        svc.owner(w, actor)
        return svc.preview_import(w["container_id"], body.task_ids, w)


@app.get(
    "/api/containers/{cid}/workflow-operations/{idempotency_key}",
    response_model=model.Receipt,
)
def workflow_receipt(cid: str, idempotency_key: str, operation: str, request: Request):
    with db_cursor(readonly=True) as (_, cur):
        actor = resolve_actor(cur, request, cid, allow_agent=True)
        row = service.WorkflowService(cur, HOOKS).receipt(
            cid, actor, operation, idempotency_key
        )
        return {
            "status": "saved" if row else "not_found",
            "operation": operation,
            "idempotency_key": idempotency_key,
            "result": row["result"] if row else None,
        }


def _workflow_action(path, operation, body_model, *, method="POST", allow_agent=False):
    def endpoint(wid: str, request: Request, body):
        service.require_capability()
        with db_cursor() as (_, cur):
            svc = service.WorkflowService(cur, HOOKS)
            w = svc.workflow(wid)
            actor = resolve_actor(
                cur, request, w["container_id"], allow_agent=allow_agent
            )
            return svc.mutate(
                w["container_id"],
                actor,
                operation,
                body.model_dump(mode="json"),
                wid=wid,
            )

    endpoint.__name__ = "workflow_" + operation
    endpoint.__annotations__["body"] = body_model
    app.add_api_route(
        path,
        endpoint,
        methods=[method],
        response_model=model.WorkflowDetail,
        openapi_extra={"x-workflow-operation": operation},
    )


def _task_action(path, operation, body_model, *, allow_agent=False):
    def endpoint(tid: str, request: Request, body):
        service.require_capability()
        with db_cursor() as (_, cur):
            svc = service.WorkflowService(cur, HOOKS)
            t = svc.one(
                "SELECT workflow_id,container_id FROM tasks WHERE id=%s", (tid,)
            )
            if not t or not t["workflow_id"]:
                conflict(
                    "workflow_task_required", "A workflow task is required.", status=404
                )
            actor = resolve_actor(
                cur, request, t["container_id"], allow_agent=allow_agent
            )
            return svc.mutate(
                t["container_id"],
                actor,
                operation,
                body.model_dump(mode="json"),
                wid=t["workflow_id"],
                tid=tid,
            )

    endpoint.__name__ = "workflow_task_" + operation
    endpoint.__annotations__["body"] = body_model
    app.add_api_route(
        path,
        endpoint,
        methods=["POST"],
        response_model=model.WorkflowDetail,
        openapi_extra={"x-workflow-operation": operation},
    )


for name in ("pause", "resume", "cancel", "finish", "hide", "restore", "run_again"):
    _workflow_action("/api/workflows/{wid}/" + name, name, model.Mutation)
_workflow_action("/api/workflows/{wid}", "patch", model.WorkflowPatch, method="PATCH")
_workflow_action(
    "/api/workflows/{wid}/tasks", "add_tasks", model.TaskBatch, allow_agent=True
)
_workflow_action("/api/workflows/{wid}/import", "import", model.ImportTasks)
_workflow_action("/api/workflows/{wid}/move", "move", model.MoveTasks)
_workflow_action("/api/workflows/{wid}/start", "start", model.ReleaseTasks)
_workflow_action("/api/workflows/{wid}/release", "release", model.ReleaseTasks)
_workflow_action("/api/workflows/{wid}/goal/accept", "accept_goal", model.AcceptBasis)
_workflow_action(
    "/api/workflows/{wid}/transfer-owner", "transfer_owner", model.TransferOwner
)
_workflow_action("/api/workflows/{wid}/decisions", "loop_decision", model.LoopDecision)
_workflow_action("/api/workflows/{wid}/flow", "flow", model.FlowEdit, method="PUT")
_workflow_action(
    "/api/workflows/{wid}/review-rounds",
    "review_round",
    model.ReviewRound,
    allow_agent=True,
)
for path, operation, body_model in [
    ("prepare", "prepare", model.PrepareTask),
    ("hold", "hold", model.TaskMutation),
    ("stop", "stop", model.TaskMutation),
    ("retry", "retry", model.RetryTask),
    ("reissue-stop", "reissue_stop", model.TaskMutation),
    ("release-lost-worker", "release_lost_worker", model.TaskMutation),
    ("withdraw-from-scope", "withdraw", model.TaskMutation),
    ("external-result", "external_result", model.OutsideResult),
    ("accept", "accept", model.AcceptTask),
    ("reject", "reject", model.TaskMutation),
    ("outcome", "report_outcome", model.OutcomeReport),
]:
    _task_action(
        "/api/tasks/{tid}/" + path,
        operation,
        body_model,
        allow_agent=operation in {"accept", "report_outcome"},
    )


@app.post("/api/tasks/{tid}/outcome/preview", response_model=model.RoutingPreview)
def preview_task_outcome(tid: str, body: model.OutcomeChoice, request: Request):
    """Where an outcome would lead, before it is reported or accepted."""
    with db_cursor(readonly=True) as (_, cur):
        svc = service.WorkflowService(cur, HOOKS)
        t = svc.one("SELECT workflow_id,container_id FROM tasks WHERE id=%s", (tid,))
        if not t or not t["workflow_id"]:
            conflict(
                "workflow_task_required", "A workflow task is required.", status=404
            )
        resolve_actor(cur, request, t["container_id"], allow_agent=True)
        return svc.routing_preview(tid, body.outcome, body.expected_work_revision)


@app.get("/api/tasks/{tid}/round-context", response_model=model.RoundContext)
def task_round_context(tid: str, request: Request):
    """The outcomes and round feedback the step's worker sees in its prompt."""
    from portal_backend.workflow_prompt import round_context

    with db_cursor(readonly=True) as (_, cur):
        svc = service.WorkflowService(cur, HOOKS)
        t = svc.one("SELECT * FROM tasks WHERE id=%s", (tid,))
        if not t or not t["workflow_id"]:
            conflict(
                "workflow_task_required", "A workflow task is required.", status=404
            )
        require_member_read(cur, request, t["container_id"])
        w = svc.workflow(t["workflow_id"])
        context = (
            round_context(cur, t, t["workflow_id"])
            if w.get("semantics_version") == 2
            else None
        )
        return context or {"task_id": str(tid)}


@app.put(
    "/api/tasks/{tid}/dependencies",
    response_model=model.WorkflowDetail,
    openapi_extra={"x-workflow-operation": "dependencies"},
)
def edit_workflow_dependencies(tid: str, body: model.DependencyEdit, request: Request):
    service.require_capability()
    with db_cursor() as (_, cur):
        svc = service.WorkflowService(cur, HOOKS)
        t = svc.one("SELECT workflow_id,container_id FROM tasks WHERE id=%s", (tid,))
        if not t or not t["workflow_id"]:
            conflict(
                "workflow_task_required", "A workflow task is required.", status=404
            )
        actor = resolve_actor(cur, request, t["container_id"])
        return svc.mutate(
            t["container_id"],
            actor,
            "dependencies",
            body.model_dump(mode="json"),
            wid=t["workflow_id"],
            tid=tid,
        )


@app.post(
    "/api/workflows/{wid}/objectives/{oid}/accept",
    response_model=model.WorkflowDetail,
    openapi_extra={"x-workflow-operation": "accept_objective"},
)
def accept_workflow_objective(
    wid: str, oid: str, body: model.AcceptBasis, request: Request
):
    service.require_capability()
    with db_cursor() as (_, cur):
        svc = service.WorkflowService(cur, HOOKS)
        w = svc.workflow(wid)
        actor = resolve_actor(cur, request, w["container_id"])
        return svc.mutate(
            w["container_id"],
            actor,
            "accept_objective",
            dict(body.model_dump(mode="json"), objective_id=oid),
            wid=wid,
        )


@app.post(
    "/api/tasks/{tid}/external-result/{eid}/withdraw",
    response_model=model.WorkflowDetail,
    openapi_extra={"x-workflow-operation": "withdraw_evidence"},
)
def withdraw_outside_result(
    tid: str, eid: str, body: model.TaskMutation, request: Request
):
    service.require_capability()
    with db_cursor() as (_, cur):
        svc = service.WorkflowService(cur, HOOKS)
        t = svc.one("SELECT workflow_id,container_id FROM tasks WHERE id=%s", (tid,))
        if not t or not t["workflow_id"]:
            conflict(
                "workflow_task_required", "A workflow task is required.", status=404
            )
        actor = resolve_actor(cur, request, t["container_id"])
        return svc.mutate(
            t["container_id"],
            actor,
            "withdraw_evidence",
            dict(body.model_dump(mode="json"), evidence_id=eid),
            wid=t["workflow_id"],
            tid=tid,
        )


@app.post(
    "/api/workflows/{wid}/review-loops/{tid}/resolve",
    response_model=model.WorkflowDetail,
    openapi_extra={"x-workflow-operation": "resolve_loop"},
)
def resolve_workflow_review(wid: str, tid: str, body: model.Mutation, request: Request):
    service.require_capability()
    with db_cursor() as (_, cur):
        svc = service.WorkflowService(cur, HOOKS)
        w = svc.workflow(wid)
        actor = resolve_actor(cur, request, w["container_id"])
        return svc.mutate(
            w["container_id"],
            actor,
            "resolve_loop",
            body.model_dump(mode="json"),
            wid=wid,
            tid=tid,
        )


@app.patch(
    "/api/workflows/{wid}/objectives/{oid}",
    response_model=model.WorkflowDetail,
    openapi_extra={"x-workflow-operation": "edit_objective"},
)
def edit_workflow_objective(
    wid: str, oid: str, body: model.ObjectiveEdit, request: Request
):
    service.require_capability()
    with db_cursor() as (_, cur):
        svc = service.WorkflowService(cur, HOOKS)
        w = svc.workflow(wid)
        actor = resolve_actor(cur, request, w["container_id"])
        return svc.mutate(
            w["container_id"],
            actor,
            "edit_objective",
            dict(body.model_dump(mode="json"), objective_id=oid),
            wid=wid,
        )


@app.get("/api/workflows/{wid}/activity", response_model=model.ActivityPage)
def workflow_activity(
    wid: str,
    request: Request,
    before_at: str | None = None,
    before_id: str | None = None,
    limit: int = Query(default=50, ge=1, le=200),
):
    with db_cursor(readonly=True) as (_, cur):
        svc, _, _ = read_context(cur, request, wid)
        query = "SELECT * FROM workflow_history WHERE workflow_id=%s"
        params = [wid]
        if bool(before_at) != bool(before_id):
            conflict(
                "cursor_required", "Supply both activity cursor fields.", status=422
            )
        if before_at:
            query += " AND (created_at<%s OR (created_at=%s AND id<%s))"
            params.extend([before_at, before_at, before_id])
        query += " ORDER BY created_at DESC,id DESC LIMIT %s"
        params.append(limit + 1)
        rows = svc.rows(query, tuple(params))
        last = rows[limit - 1] if len(rows) > limit else None
        return {
            "activity": rows[:limit],
            "next_before_at": last["created_at"] if last else None,
            "next_before_id": last["id"] if last else None,
        }


@app.post(
    "/api/workflows/{wid}/tasks/{tid}/evidence",
    response_model=model.WorkflowDetail,
    openapi_extra={"x-workflow-operation": "add_evidence"},
)
def add_workflow_evidence(
    wid: str, tid: str, body: model.AddEvidence, request: Request
):
    service.require_capability()
    with db_cursor() as (_, cur):
        svc = service.WorkflowService(cur, HOOKS)
        w = svc.workflow(wid)
        actor = resolve_actor(cur, request, w["container_id"])
        return svc.mutate(
            w["container_id"],
            actor,
            "add_evidence",
            body.model_dump(mode="json"),
            wid=wid,
            tid=tid,
        )
