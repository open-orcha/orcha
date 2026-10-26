"""Project-readable evidence history; writes belong to workflow lifecycle actions."""

from fastapi import Query, Request

from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.schemas.workflow_evidence import WorkflowTaskEvidence
from portal_backend.workflow_evidence_service import evidence_reference
from portal_backend.workflow_graph import conflict
from portal_backend.workflow_routes import read_context


@app.get("/api/workflows/{wid}/tasks/{tid}/evidence", response_model=WorkflowTaskEvidence)
def get_workflow_task_evidence(
    wid: str, tid: str, request: Request,
    before_revision: int | None = Query(default=None, ge=1),
    limit: int = Query(default=20, ge=1, le=100),
):
    with db_cursor(readonly=True) as (_, cur):
        svc, _, _ = read_context(cur, request, wid)
        # A read never asks svc.task() for its mutation lock.
        task = svc.one("SELECT id FROM tasks WHERE id=%s AND workflow_id=%s", (tid, wid))
        if not task:
            conflict("workflow_task_required", "Task not found in this workflow.", status=404)
        cur.execute("SELECT current_evidence_set_id FROM workflow_executions WHERE task_id=%s "
                    "ORDER BY generation DESC,created_at DESC LIMIT 1", (tid,))
        execution = cur.fetchone()
        current = execution["current_evidence_set_id"] if execution else None
        query = "SELECT id,result_revision FROM workflow_evidence_sets WHERE task_id=%s AND workflow_id=%s"
        params = [tid, wid]
        if before_revision is not None:
            query += " AND result_revision<%s"
            params.append(before_revision)
        query += " ORDER BY result_revision DESC LIMIT %s"
        params.append(limit + 1)
        cur.execute(query, tuple(params))
        rows = cur.fetchall()
        return {
            "task_id": tid, "workflow_id": wid,
            "current_evidence_set_id": str(current) if current else None,
            "sets": [evidence_reference(cur, row["id"]) for row in rows[:limit]],
            "next_before_revision": rows[limit - 1]["result_revision"] if len(rows) > limit else None,
        }
