"""Agent performance (evals-lite) read API — see agent_performance.py for every definition.

  GET /api/containers/{cid}/metrics/performance?range=7d|30d|90d|all
      project row + one row per AI agent (live agents always; retired agents only when
      they have activity in the window), each with metrics + a sparkline series.
  GET /api/containers/{cid}/metrics/performance/agents/{aid}?range=...
      one agent (the Configuration tab's Performance card).

Read-only, membership-gated exactly like the other metrics reads (require_member_read):
project-isolated, a trusted non-member gets 403, viewers may read.
"""

from __future__ import annotations

import datetime as _dt
from typing import Literal, Optional

from fastapi import HTTPException, Query, Request
from pydantic import BaseModel, Field

from portal_backend import agent_performance as perf
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container, valid_uuid
from portal_backend.identity_routes import require_member_read

RangeKey = Literal["7d", "30d", "90d", "all"]


# ---- response models (documented in /openapi.json) ------------------------ #

class PerfRate(BaseModel):
    value: Optional[float] = Field(None, description="numerator/denominator; null below min_sample")
    numerator: int
    denominator: int
    enough: bool = Field(..., description="denominator >= min_sample")


class PerfPlanRate(PerfRate):
    approved: int
    rejected: int


class PerfMedian(BaseModel):
    value: Optional[float] = Field(None, description="seconds; null below min_sample")
    n: int
    enough: bool


class PerfCost(BaseModel):
    value: Optional[float] = Field(
        None, description="USD per metered verified task; null below min_sample. Never 0: "
        "tasks whose runs did not all report a positive cost are excluded (not metered).")
    metered_tasks: int
    unmetered_tasks: int
    total_metered_usd: Optional[float] = None
    enough: bool


class PerfRework(BaseModel):
    total: int
    human_rejections: int
    manager_send_backs: int


class PerfMetrics(BaseModel):
    tasks_verified: int
    first_pass_rate: PerfRate
    rework: PerfRework
    median_time_to_verified_seconds: PerfMedian
    cost_per_verified_task_usd: PerfCost
    plan_approval_rate: PerfPlanRate
    escalations: int


class PerfBucket(BaseModel):
    start: str
    end: str
    verified: int
    rework: int


class PerfAgentRow(BaseModel):
    agent_id: str
    alias: str
    model: Optional[str] = None
    role: Optional[str] = None
    retired: bool
    metrics: PerfMetrics
    series: list[PerfBucket]


class PerfProjectRow(BaseModel):
    container_id: str
    name: Optional[str] = None
    metrics: PerfMetrics
    series: list[PerfBucket]


class PerformanceResponse(BaseModel):
    range: RangeKey
    since: Optional[str] = Field(None, description="inclusive UTC lower bound; null = all time")
    bucket_days: int
    min_sample: int
    generated_at: str
    project: PerfProjectRow
    agents: list[PerfAgentRow]


class AgentPerformanceResponse(BaseModel):
    range: RangeKey
    since: Optional[str] = None
    bucket_days: int
    min_sample: int
    generated_at: str
    agent: PerfAgentRow


# ---- helpers --------------------------------------------------------------- #

def _envelope(range_key: str, now, since) -> dict:
    return {
        "range": range_key,
        "since": since.isoformat() if since else None,
        "bucket_days": perf._BUCKET_DAYS[range_key],
        "min_sample": perf.MIN_SAMPLE,
        "generated_at": now.isoformat(),
    }


def _agent_row(aid: str, a, scoped: dict) -> dict:
    return {
        "agent_id": aid,
        "alias": a["alias"],
        "model": a["model"],
        "role": a["role"],
        "retired": a["terminated_at"] is not None,
        **scoped,
    }


def _load(cur, request: Request, cid: str, range_key: str):
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    require_container(cur, cid)
    require_member_read(cur, request, cid)
    now = _dt.datetime.now(_dt.timezone.utc)
    since = perf.range_since(range_key, now)
    facts = perf.load_facts(cur, cid, since)
    buckets = perf.build_buckets(range_key, now, facts["first_activity"])
    return now, since, facts, buckets


# ---- routes ------------------------------------------------------------------ #

@app.get("/api/containers/{cid}/metrics/performance", response_model=PerformanceResponse)
def container_performance(
    cid: str,
    request: Request,
    range: RangeKey = Query(default="30d", description="UTC calendar-day window"),
):
    """Agent performance (evals-lite) for a project: tasks verified, first-pass
    verification rate, rework (human rejections + AI-manager send-backs), median time
    to verified, cost per verified task (metered tasks only — never $0), plan approval
    rate and escalations — for the project and for each AI agent. Rates/medians/costs
    below `min_sample` are null with `enough: false` ("not enough data")."""
    with db_cursor() as (_, cur):
        now, since, facts, buckets = _load(cur, request, cid, range)
        cur.execute("SELECT name FROM containers WHERE id=%s", (cid,))
        crow = cur.fetchone() or {}
        project = perf.scope_metrics(facts, None, since, buckets)
        agents = []
        for aid, a in facts["agents"].items():
            scoped = perf.scope_metrics(facts, aid, since, buckets)
            if a["terminated_at"] is not None and not perf.has_activity(scoped["metrics"]):
                continue
            agents.append(_agent_row(aid, a, scoped))
    return {
        **_envelope(range, now, since),
        "project": {"container_id": cid, "name": crow.get("name"), **project},
        "agents": agents,
    }


@app.get(
    "/api/containers/{cid}/metrics/performance/agents/{aid}",
    response_model=AgentPerformanceResponse,
)
def agent_performance(
    cid: str,
    aid: str,
    request: Request,
    range: RangeKey = Query(default="30d", description="UTC calendar-day window"),
):
    """One AI agent's performance (evals-lite) — same definitions as the project read."""
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (_, cur):
        now, since, facts, buckets = _load(cur, request, cid, range)
        a = facts["agents"].get(aid)
        if a is None:
            raise HTTPException(404, f"AI agent {aid} not found in container {cid}")
        scoped = perf.scope_metrics(facts, aid, since, buckets)
    return {**_envelope(range, now, since), "agent": _agent_row(aid, a, scoped)}
