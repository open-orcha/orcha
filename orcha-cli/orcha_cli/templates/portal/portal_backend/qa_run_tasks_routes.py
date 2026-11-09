"""Orcha QA run tasks (migration 097; the logic is qa_run_tasks).

  POST C/run-task                the task a new session starts on, for the tool server: the worker's
                                 current task, else a new run task. {task_id, created}
  GET  C/run-tasks               every run task of the project
  GET  /api/agents/{aid}/qa-runs an agent's Quality runs, with outcome, cost, time and links

C = /api/containers/{cid}/qa.
"""

from __future__ import annotations

from typing import Literal, Optional

from fastapi import Header, HTTPException, Query, Request
from pydantic import BaseModel, Field

from portal_backend import qa_run_tasks, qa_store as qs
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.identity_routes import require_member_read


class QaRunTaskBody(BaseModel):
    actor_agent_id: Optional[str] = None
    kind: Literal["map", "explore", "draft", "check"]
    platform: Literal["ios", "android", "web"]
    goal: Optional[str] = Field(default=None, max_length=4000)


@app.post("/api/containers/{cid}/qa/run-task")
def resolve_qa_run_task(cid: str, body: QaRunTaskBody, request: Request,
                        x_orcha_run_token: Optional[str] = Header(default=None, alias="X-Orcha-Run-Token")):
    """The task this worker's session belongs to. Nothing a person ever sees or sets."""
    with db_cursor() as (conn, cur):
        qs.container_read(cur, request, cid)
        who = qs.actor(cur, request, cid, body.actor_agent_id)
        conn.commit()
    return qa_run_tasks.resolve_task(cid, who, kind=body.kind, platform=body.platform, goal=body.goal, run_token=x_orcha_run_token)


@app.get("/api/containers/{cid}/qa/run-tasks")
def list_qa_run_tasks(cid: str, request: Request, limit: int = Query(default=200, ge=1, le=500)):
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
        return {"run_tasks": qa_run_tasks.list_run_tasks(cur, cid, limit=limit)}


@app.get("/api/agents/{aid}/qa-runs")
def list_agent_qa_runs(aid: str, request: Request, limit: int = Query(default=50, ge=1, le=200)):
    qs.require_uuid(aid, "agent_id")
    with db_cursor(readonly=True) as (_, cur):
        cur.execute("SELECT container_id FROM agents WHERE id=%s", (aid,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, f"agent {aid} not found")
        require_member_read(cur, request, str(row["container_id"]))
        return qa_run_tasks.agent_runs(cur, aid, limit=limit)
