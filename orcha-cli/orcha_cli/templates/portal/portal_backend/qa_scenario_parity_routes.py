"""Scenario routes beyond the record itself (migration 095). Reads are members'; everything that
decides is a person's (`qs.human`), as in qa_routes.

Item scope:
  GET  /api/qa/scenarios/{id}/versions, POST .../restore        History
  DELETE /api/qa/scenarios/{id}                                 delete (a person)
  DELETE /api/qa/scenarios/{id}/quarantine                      release now (a person)
  GET/POST /api/qa/scenarios/{id}/check-fixes                   corrections runs proposed; dismiss one
  GET/DELETE /api/qa/scenarios/{id}/trace                       the recorded path; forget it
  GET/POST /api/qa/scenarios/{id}/files, DELETE /api/qa/scenario-files/{fid}
  POST /api/qa/scenarios/{id}/examples/reveal                   one sealed cell of its table
Container scope C = /api/containers/{cid}/qa:
  GET C/scenario-health, GET C/scenario-health/flags, POST C/scenario-health/actions
  GET/POST C/coverage/growth, POST C/coverage/growth/variations
  GET/POST C/coverage/links
"""

from __future__ import annotations

from typing import Annotated, Literal, Optional

from fastapi import HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from portal_backend import qa_growth, qa_growth_variations, qa_scenario_health, qa_scenario_parity as parity, qa_scenarios, qa_store as qs
from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.identity_routes import require_member_read

NO_STORE = {"Cache-Control": "no-store"}


class ActorBody(BaseModel):
    actor_agent_id: Optional[str] = None


class RestoreBody(ActorBody):
    version: int = Field(..., ge=1)


class CheckFixDismissBody(ActorBody):
    criterion_index: int = Field(..., ge=0, le=11)
    expression: str = Field(..., min_length=1, max_length=500)
    proposed: str = Field(default="", max_length=500)


class RevealBody(ActorBody):
    ref: str = Field(..., pattern=r"^sec_[0-9a-f]{8,64}$")


class HealthActionBody(ActorBody):
    action: Literal["drafts", "archive", "dismiss", "restore", "rename", "merge"]
    ids: list[str] = Field(..., min_length=1, max_length=200)
    kind: Optional[str] = None
    name: Optional[str] = Field(default=None, max_length=200)
    into: Optional[str] = None


class GrowthBody(ActorBody):
    action: Literal["baseline", "rebaseline"]
    reason: Optional[str] = Field(default=None, max_length=300)


class VariationBody(ActorBody):
    action: Literal["suggest", "apply", "dismiss"]
    scenario: Optional[str] = None
    ids: Optional[list[str]] = Field(default=None, max_length=50)
    rows: Optional[list[dict]] = Field(default=None, max_length=20, description="An agent's own rows: {technique, label, values}")


class LinkBody(ActorBody):
    action: Literal["link", "unlink", "confirm", "reject"]
    scenario_id: str
    feature_key: Annotated[str, Field(min_length=1, max_length=200)]


def _scenario(cur, request: Request, scid: str) -> tuple[dict, str]:
    row = dict(qs.load_scenario(cur, scid))
    return row, str(row["container_id"])


def _read(cur, request: Request, scid: str) -> dict:
    row, cid = _scenario(cur, request, scid)
    require_member_read(cur, request, cid)
    return row


# ---------------------------------------------------------------- History

@app.get("/api/qa/scenarios/{scid}/versions")
def list_qa_scenario_versions(scid: str, request: Request):
    """Every save, newest first. `snapshot.status_note` is a status change's History line."""
    with db_cursor(readonly=True) as (_, cur):
        _read(cur, request, scid)
        return {"versions": parity.versions(cur, scid), "pending": []}


@app.post("/api/qa/scenarios/{scid}/restore")
def restore_qa_scenario(scid: str, body: RestoreBody, request: Request):
    """Applies that version's fields and appends a new version: restoring is a save. A person only."""
    with db_cursor() as (conn, cur):
        row, cid = _scenario(cur, request, scid)
        who = qs.human(cur, request, cid, body.actor_agent_id, "restore a scenario")
        out = parity.restore(cur, row, who, body.version)
        log_event(cur, cid, "human", who["id"], "qa_scenario", scid, "qa_scenario_restored", {"version": body.version})
        conn.commit()
    return out


# ---------------------------------------------------------------- delete, quarantine

@app.delete("/api/qa/scenarios/{scid}")
def delete_qa_scenario(scid: str, request: Request, actor_agent_id: Optional[str] = Query(default=None)):
    """Removes it and its version history. A person only."""
    with db_cursor() as (conn, cur):
        row, cid = _scenario(cur, request, scid)
        who = qs.human(cur, request, cid, actor_agent_id, "delete a scenario")
        parity.delete(cur, row)
        log_event(cur, cid, "human", who["id"], "container", cid, "qa_scenario_deleted", {"id": scid, "name": row["name"]})
        conn.commit()
    return {"ok": True}


@app.delete("/api/qa/scenarios/{scid}/quarantine")
def release_qa_scenario(scid: str, request: Request, actor_agent_id: Optional[str] = Query(default=None)):
    """Out of quarantine now: its failures fail a check run again. A person only."""
    with db_cursor() as (conn, cur):
        row, cid = _scenario(cur, request, scid)
        who = qs.human(cur, request, cid, actor_agent_id, "release a scenario")
        out = parity.release(cur, row, who)
        log_event(cur, cid, "human", who["id"], "qa_scenario", scid, "qa_scenario_released", {})
        conn.commit()
    return {"scenario": out}


# ---------------------------------------------------------------- check corrections

@app.get("/api/qa/scenarios/{scid}/check-fixes")
def list_qa_check_fixes(scid: str, request: Request):
    """`{rows, dismissed}`: the screen works out what is still worth offering with the same parser
    it edits checks with. Accepting one is a PATCH of the scenario's `checks`."""
    with db_cursor(readonly=True) as (_, cur):
        _read(cur, request, scid)
        return parity.check_fix_rows(cur, scid)


@app.post("/api/qa/scenarios/{scid}/check-fixes")
def dismiss_qa_check_fix(scid: str, body: CheckFixDismissBody, request: Request):
    """Not offered again. Idempotent. A person only."""
    with db_cursor() as (conn, cur):
        row, cid = _scenario(cur, request, scid)
        who = qs.human(cur, request, cid, body.actor_agent_id, "dismiss a check correction")
        parity.dismiss_fix(cur, row, who, body.criterion_index, body.expression.strip(), body.proposed)
        conn.commit()
    return {"ok": True}


# ---------------------------------------------------------------- the recorded path

@app.get("/api/qa/scenarios/{scid}/trace")
def get_qa_scenario_trace(scid: str, request: Request):
    with db_cursor(readonly=True) as (_, cur):
        row = _read(cur, request, scid)
        return {"traces": parity.traces(cur, row)}


@app.delete("/api/qa/scenarios/{scid}/trace")
def forget_qa_scenario_trace(scid: str, request: Request, target_kind: Optional[str] = Query(default=None),
                             actor_agent_id: Optional[str] = Query(default=None)):
    """The scenario forgets its walk on that platform; the walk stays in its session. A person only."""
    if target_kind is not None:
        qs.require_platform(target_kind)
    with db_cursor() as (conn, cur):
        row, cid = _scenario(cur, request, scid)
        qs.human(cur, request, cid, actor_agent_id, "forget a recorded path")
        parity.forget_path(cur, row, target_kind)
        conn.commit()
    return {"ok": True}


# ---------------------------------------------------------------- files, sealed cells

@app.get("/api/qa/scenarios/{scid}/files")
def list_qa_scenario_files(scid: str, request: Request):
    with db_cursor(readonly=True) as (_, cur):
        _read(cur, request, scid)
        return {"files": parity.files(cur, scid)}


@app.post("/api/qa/scenarios/{scid}/files", status_code=201)
async def add_qa_scenario_file(scid: str, request: Request, name: str = Query(..., min_length=1, max_length=200),
                               actor_agent_id: Optional[str] = Query(default=None)):
    """The raw file as the body. A person only."""
    data = await request.body()
    with db_cursor() as (conn, cur):
        row, cid = _scenario(cur, request, scid)
        qs.human(cur, request, cid, actor_agent_id, "attach a file")
        out = parity.add_file(cur, row, name, data)
        conn.commit()
    return {"file": out}


@app.delete("/api/qa/scenario-files/{fid}")
def delete_qa_scenario_file(fid: str, request: Request, actor_agent_id: Optional[str] = Query(default=None)):
    with db_cursor() as (conn, cur):
        qs.require_uuid(fid, "file")
        cur.execute("SELECT container_id FROM qa_scenario_files WHERE id=%s", (fid,))
        got = cur.fetchone()
        if got is None:
            raise HTTPException(404, "no such file")
        qs.human(cur, request, str(got["container_id"]), actor_agent_id, "remove a file")
        parity.delete_file(cur, fid)
        conn.commit()
    return {"ok": True}


@app.get("/api/qa/scenarios/{scid}/rows")
def qa_scenario_rows(scid: str, request: Request):
    """The newest result of each Examples row."""
    with db_cursor(readonly=True) as (_, cur):
        row = _read(cur, request, scid)
        return {"rows": parity.example_rows(cur, row)}


@app.post("/api/qa/scenarios/{scid}/examples/reveal")
def reveal_qa_example_cell(scid: str, body: RevealBody, request: Request):
    """One sealed cell of this scenario's own table: the person holding the eye on it, or a check
    run's `type_secret`. Never stored in a response cache."""
    with db_cursor(readonly=True) as (_, cur):
        row, cid = _scenario(cur, request, scid)
        qs.actor(cur, request, cid, body.actor_agent_id)
        value = parity.reveal(cur, row, body.ref)
    return JSONResponse({"value": value}, headers=NO_STORE)


# ---------------------------------------------------------------- health

@app.get("/api/containers/{cid}/qa/scenario-health")
def qa_scenario_audit(cid: str, request: Request):
    """The audit, computed now and stored: every flag with its reason and recommended action."""
    with db_cursor() as (conn, cur):
        qs.container_read(cur, request, cid)
        out = qa_scenario_health.audit(cur, cid)
        conn.commit()
    return out


@app.get("/api/containers/{cid}/qa/scenario-health/flags")
def qa_scenario_flags(cid: str, request: Request, ids: str = Query(default="")):
    """The stored flags of these scenarios for the badge (dismissed ones included, marked). An
    audit older than ten minutes runs first, so a badge does not need the board to be opened."""
    wanted = {i.strip() for i in ids.split(",") if i.strip()}
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
        stale = qa_scenario_health.stale_audit(cur, cid)
    if stale:
        with db_cursor() as (conn, cur):
            qa_scenario_health.audit(cur, cid)
            conn.commit()
    with db_cursor(readonly=True) as (_, cur):
        rows = [r for k, r in qa_scenario_health.stored_flags(cur, cid).items() if k[0] in wanted]
    return {"flags": rows}


@app.post("/api/containers/{cid}/qa/scenario-health/actions")
def qa_scenario_health_action(cid: str, body: HealthActionBody, request: Request):
    """The Health board's one-click actions. A person only."""
    for i in body.ids:
        qs.require_uuid(i, "scenario")
    with db_cursor() as (conn, cur):
        qs.container_read(cur, request, cid)
        who = qs.human(cur, request, cid, body.actor_agent_id, "act on a scenario's health")
        changed = qa_scenario_health.apply_action(cur, cid, who, body.action, body.ids, kind=body.kind, name=body.name, into=body.into)
        log_event(cur, cid, "human", who["id"], "container", cid, "qa_scenario_health_action",
                  {"action": body.action, "ids": body.ids})
        conn.commit()
    return {"ok": True, "changed": changed}


# ---------------------------------------------------------------- coverage growth

@app.get("/api/containers/{cid}/qa/coverage/growth")
def qa_coverage_growth(cid: str, request: Request):
    """Coverage now, the baseline, what was added since, the chart's points, the data variations
    waiting. Records today's point."""
    with db_cursor() as (conn, cur):
        qs.container_read(cur, request, cid)
        out = qa_growth.report(cur, cid)
        conn.commit()
    return out


@app.post("/api/containers/{cid}/qa/coverage/growth")
def qa_coverage_baseline(cid: str, body: GrowthBody, request: Request):
    """Freeze coverage as the baseline, or re-baseline with a reason. A person only."""
    with db_cursor() as (conn, cur):
        qs.container_read(cur, request, cid)
        who = qs.human(cur, request, cid, body.actor_agent_id, "take a coverage baseline")
        try:
            row = qa_growth.rebaseline(cur, cid, who, body.reason) if body.action == "rebaseline" else qa_growth.capture(cur, cid, who, trigger="manual")
        except qa_growth.GrowthError as e:
            raise HTTPException(400, str(e)) from e
        log_event(cur, cid, "human", who["id"], "container", cid, "qa_coverage_baseline", {"action": body.action, "reason": body.reason})
        conn.commit()
    return {"ok": True, "baseline": {"id": row.get("id"), "day": row.get("day")}}


@app.post("/api/containers/{cid}/qa/coverage/growth/variations")
def qa_coverage_variations(cid: str, body: VariationBody, request: Request):
    """`suggest` stores rows for a scenario's table (an agent may); `apply` adds approved rows to the
    table and `dismiss` drops them (a person only)."""
    with db_cursor() as (conn, cur):
        qs.container_read(cur, request, cid)
        try:
            if body.action == "suggest":
                qs.actor(cur, request, cid, body.actor_agent_id)
                out = qa_growth_variations.suggest(cur, cid, body.scenario or "", body.rows)
            else:
                who = qs.human(cur, request, cid, body.actor_agent_id, "decide on data variations")
                ids = body.ids or []
                if body.action == "dismiss":
                    out = {"dismissed": qa_growth_variations.decide(cur, cid, ids, "dismissed")}
                else:
                    plan = qa_growth_variations.plan_apply(cur, cid, ids)
                    row = dict(qs.load_scenario(cur, plan["scenario_id"]))
                    qa_scenarios.revise(cur, row, who, {"examples": plan["examples"]}, None, None, None)
                    qa_growth_variations.decide(cur, cid, ids, "applied")
                    out = {"added": plan["added"], "scenario_name": plan["scenario_name"]}
        except qa_growth_variations.VariationError as e:
            raise HTTPException(400, str(e)) from e
        conn.commit()
    return out


# ---------------------------------------------------------------- coverage links

@app.get("/api/containers/{cid}/qa/coverage/links")
def qa_coverage_links(cid: str, request: Request):
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
        cur.execute("SELECT scenario_id, feature_key, state, decided_at FROM qa_coverage_links WHERE container_id=%s", (cid,))
        return {"links": [qs.public(r) for r in cur.fetchall()]}


@app.post("/api/containers/{cid}/qa/coverage/links")
def qa_set_coverage_link(cid: str, body: LinkBody, request: Request):
    """A person's decision about which scenario tests which feature area: it survives every
    recompute. `unlink` forgets the decision."""
    qs.require_uuid(body.scenario_id, "scenario_id")
    with db_cursor() as (conn, cur):
        qs.container_read(cur, request, cid)
        who = qs.human(cur, request, cid, body.actor_agent_id, "decide what a scenario covers")
        if str(qs.load_scenario(cur, body.scenario_id)["container_id"]) != cid:
            raise HTTPException(404, "no such scenario in this project")
        cur.execute("DELETE FROM qa_coverage_links WHERE scenario_id=%s AND feature_key=%s", (body.scenario_id, body.feature_key))
        if body.action != "unlink":
            state = {"link": "linked", "confirm": "confirmed", "reject": "rejected"}[body.action]
            cur.execute("""INSERT INTO qa_coverage_links (container_id, scenario_id, feature_key, state, decided_by_agent_id, decided_at)
                           VALUES (%s,%s,%s,%s,%s,%s)""", (cid, body.scenario_id, body.feature_key, state, who["id"], qs.now()))
        conn.commit()
    return {"ok": True}
