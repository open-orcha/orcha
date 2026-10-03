"""Plan usage snapshots (mig 069) — PUT/GET /api/plan-usage, GET /api/plan-usage/summary.

The Embodent desktop app computes Claude (Max) / Codex (Plus) plan limits locally — the
Claude numbers come from the Keychain OAuth token + Anthropic usage API, the Codex ones from
local logs. A phone can do neither, so the desktop PUBLISHES a snapshot here after each limits
refresh and the mobile apps READ it.

PRIVACY (hard rule): a snapshot carries ONLY plan names, window labels / used % / reset times
and today's token count + estimated cost. The models below are STRICT (`extra="forbid"` at
every level), so a client that tries to smuggle an OAuth token, credential, file path, prompt
or account email in any field the contract does not name is refused with a 422 — nothing
unexpected is ever stored.

Scope: per-PORTAL, not per-project (there is no cid). One row per desktop host, upserted.

Auth (identity-level, like /api/prefs — there is no container to scope to):
  * trust off (self-host / laptop) or a header-less break-glass call ⇒ open, as every other
    project-setting write on that lane;
  * trusted login ⇒ READ needs a live human membership in ANY project on this stack; WRITE
    additionally refuses the read-only viewer role.
"""

import json
from datetime import datetime
from typing import List, Literal, Optional

from fastapi import HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.identity_routes import proxy_login

MAX_WINDOWS = 10
MAX_PROVIDERS = 4


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PlanUsageWindow(_Strict):
    key: str = Field(min_length=1, max_length=40)
    label: str = Field(min_length=1, max_length=40)
    used_pct: float = Field(ge=0, le=100)
    resets_at: Optional[datetime] = None


class PlanUsageToday(_Strict):
    tokens: int = Field(ge=0)
    cost_usd: Optional[float] = Field(default=None, ge=0)


class PlanUsageProvider(_Strict):
    provider: Literal["claude", "codex"]
    plan: Optional[str] = Field(default=None, max_length=30)
    headline: Optional[str] = Field(default=None, max_length=80)
    windows: List[PlanUsageWindow] = Field(default_factory=list, max_length=MAX_WINDOWS)
    today: Optional[PlanUsageToday] = None


class PlanUsageSnapshotIn(_Strict):
    host: str = Field(min_length=1, max_length=120)
    captured_at: datetime
    providers: List[PlanUsageProvider] = Field(default_factory=list, max_length=MAX_PROVIDERS)


class PlanUsageSnapshotOut(BaseModel):
    host: str
    captured_at: datetime
    updated_at: datetime
    providers: List[PlanUsageProvider]


class PlanUsageList(BaseModel):
    snapshots: List[PlanUsageSnapshotOut]


class PlanUsageSummary(BaseModel):
    snapshot: Optional[PlanUsageSnapshotOut] = None


def _mapped_member_anywhere(cur, login):
    cur.execute(
        """SELECT member_role FROM agents
           WHERE kind='human' AND terminated_at IS NULL
             AND lower(github_login)=lower(%s)
           ORDER BY (member_role IS DISTINCT FROM 'viewer') DESC LIMIT 1""",
        (login,),
    )
    return cur.fetchone()


def _gate(cur, request: Request, write: bool) -> None:
    login = proxy_login(request)
    if not login:
        return  # trust off / break-glass: open, like the other self-host lanes
    member = _mapped_member_anywhere(cur, login)
    if member is None:
        raise HTTPException(
            403, f"your GitHub account ('{login}') is not a member of any project on this Embodent"
        )
    if write and member["member_role"] == "viewer":
        raise HTTPException(403, "your role is viewer — it is read-only")


def _row_out(row) -> PlanUsageSnapshotOut:
    payload = row["payload"] or {}
    if isinstance(payload, str):
        payload = json.loads(payload)
    return PlanUsageSnapshotOut(
        host=row["host"],
        captured_at=row["captured_at"],
        updated_at=row["updated_at"],
        providers=[PlanUsageProvider.model_validate(p) for p in payload.get("providers", [])],
    )


@app.put("/api/plan-usage", response_model=PlanUsageSnapshotOut, tags=["plan-usage"])
def put_plan_usage(request: Request, body: PlanUsageSnapshotIn):
    """Upsert this desktop host's plan-usage snapshot (privacy-safe, strictly validated)."""
    payload = {"providers": [p.model_dump(mode="json") for p in body.providers]}
    with db_cursor() as (conn, cur):
        _gate(cur, request, write=True)
        cur.execute(
            """INSERT INTO plan_usage_snapshots (host, payload, captured_at, updated_at)
               VALUES (%s, %s::jsonb, %s, now())
               ON CONFLICT (host) DO UPDATE
                 SET payload=EXCLUDED.payload, captured_at=EXCLUDED.captured_at, updated_at=now()
               RETURNING host, payload, captured_at, updated_at""",
            (body.host, json.dumps(payload), body.captured_at),
        )
        row = cur.fetchone()
        conn.commit()
    return _row_out(row)


@app.get("/api/plan-usage", response_model=PlanUsageList, tags=["plan-usage"])
def get_plan_usage(request: Request):
    """Every desktop host's latest snapshot, newest first."""
    with db_cursor() as (conn, cur):
        _gate(cur, request, write=False)
        cur.execute(
            """SELECT host, payload, captured_at, updated_at FROM plan_usage_snapshots
               ORDER BY captured_at DESC, updated_at DESC"""
        )
        rows = cur.fetchall()
    return PlanUsageList(snapshots=[_row_out(r) for r in rows])


@app.get("/api/plan-usage/summary", response_model=PlanUsageSummary, tags=["plan-usage"])
def get_plan_usage_summary(request: Request):
    """The newest snapshot only, or {"snapshot": null} when no desktop has published."""
    with db_cursor() as (conn, cur):
        _gate(cur, request, write=False)
        cur.execute(
            """SELECT host, payload, captured_at, updated_at FROM plan_usage_snapshots
               ORDER BY captured_at DESC, updated_at DESC LIMIT 1"""
        )
        row = cur.fetchone()
    return PlanUsageSummary(snapshot=_row_out(row) if row else None)
