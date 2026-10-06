"""Project mode (Code | General) + industry templates — the API.

Endpoints (contract in /openapi.json):

  GET  /api/project-templates                         catalog summaries (no auth: static data)
  GET  /api/project-templates/{key}                   one template in full (prompts included)
  GET  /api/containers/{cid}/project-profile          mode, live DoD presets (mig 059 store), last
                                                      template (member read)
  PUT  /api/containers/{cid}/project-profile          switch the mode (human; owner or
                                                      manage_autonomy — the same grant as other
                                                      project execution settings)
  POST /api/containers/{cid}/templates/{key}/preview  EXACTLY what applying would create/skip/change,
                                                      plus a plan fingerprint (member read)
  POST /api/containers/{cid}/templates/{key}/apply    apply a previewed plan (human; owner or
                                                      manage_agents; confirm=true + the preview's
                                                      fingerprint — a changed project is a 409)
  GET  /api/containers/{cid}/template-applications    the audit trail of past applications

Human authority: nothing here runs on its own. A template only becomes agents, routines and
settings when a human with the right grant confirms the previewed plan, and every object is
created through its EXISTING creation handler, in-process — agents via register_agent,
reporting lines via set_reports_to, routines via create_routine — so each keeps its own
validation, authorization and audit events. Existing agents are never modified: a template
role whose alias is already a live AI agent is reused (as a manager / routine assignee),
anything else with that alias is skipped and says why.

Project mode is a presentation/intent flag (see migration 060): General hides the Code and
GitHub tabs and words work as deliverables. It never changes plan approval, verification,
autonomy or wakes, and it does not remove a project's GitHub binding.
"""

from __future__ import annotations

import hashlib
import json
from typing import Literal, Optional

from fastapi import HTTPException, Request, Response
from pydantic import BaseModel, Field
from psycopg.types.json import Jsonb

from portal_backend import routine_schedule as sched
from portal_backend.agent_registration_routes import register_agent
from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container, valid_uuid
from portal_backend.identity_routes import has_grant, require_grant, require_member_read
from portal_backend.limits import MAX_DESC_LEN
from portal_backend.org_chart_routes import set_reports_to
from portal_backend.routine_routes import RoutineCreate, create_routine
from portal_backend.schemas.agents import AgentCreate
from portal_backend.schemas.org_chart import ReportsToUpdate
from portal_backend.templates_catalog import CATALOG, PROJECT_MODES, get_template, summary

MODE_GRANT = "manage_autonomy"
APPLY_GRANT = "manage_agents"


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class ProjectProfileUpdate(BaseModel):
    actor_agent_id: Optional[str] = Field(
        default=None, description="Acting human (trust-off lane); the proxy identity wins when trusted")
    mode: Literal["code", "general"] = Field(..., description="'code' or 'general'")


class TemplateSelection(BaseModel):
    actor_agent_id: Optional[str] = Field(
        default=None, description="Acting human (trust-off lane); the proxy identity wins when trusted")
    roles: Optional[list[str]] = Field(
        default=None, max_length=24, description="template role keys to create; null = all")
    routines: Optional[list[str]] = Field(
        default=None, max_length=24, description="template routine keys to create; null = all")
    enable_routines: bool = Field(
        default=False, description="create the routines enabled (default: paused until a human turns them on)")
    timezone: str = Field(default="UTC", max_length=64, description="IANA zone for the routines' schedules")
    set_mode: bool = Field(default=True, description="switch the project to the template's mode")
    dod_presets: bool = Field(
        default=True, description="add the template's DoD presets to the project's preset list "
        "(project_dod_presets, source='template_import'); names already present are skipped")
    objective: Optional[str] = Field(
        default=None, max_length=MAX_DESC_LEN,
        description="set the project objective (container description + root task description)")


class TemplateApply(TemplateSelection):
    confirm: bool = Field(..., description="must be true — the human confirmed the previewed plan")
    plan_fingerprint: str = Field(..., min_length=16, max_length=128,
                                  description="the fingerprint returned by .../preview for this selection")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _require_cid(cid):
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")


def _template_or_404(key: str) -> dict:
    t = get_template(key)
    if t is None:
        raise HTTPException(404, f"no template '{key}'")
    return t


def _live_presets(cur, cid) -> list[dict]:
    cur.execute(
        """SELECT id, name, body, source FROM project_dod_presets
            WHERE container_id=%s AND archived_at IS NULL ORDER BY lower(name)""",
        (cid,),
    )
    return [{"id": str(r["id"]), "name": r["name"], "body": r["body"], "source": r["source"]}
            for r in cur.fetchall()]


def _profile(cur, cid) -> dict:
    cur.execute(
        """SELECT c.project_mode, c.template_key,
                  (SELECT a.created_at FROM project_template_applications a
                    WHERE a.container_id=c.id ORDER BY a.created_at DESC LIMIT 1) AS last_applied_at
             FROM containers c WHERE c.id=%s""",
        (cid,),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, f"container {cid} not found")
    t = get_template(row["template_key"]) if row["template_key"] else None
    return {
        "container_id": cid,
        "mode": row["project_mode"],
        "dod_presets": _live_presets(cur, cid),
        "template_key": row["template_key"],
        "template_name": t["name"] if t else None,
        "last_applied_at": row["last_applied_at"].isoformat() if row["last_applied_at"] else None,
    }


def _pick(items: list[dict], keys: Optional[list[str]], what: str) -> list[dict]:
    if keys is None:
        return list(items)
    known = {i["key"] for i in items}
    unknown = [k for k in keys if k not in known]
    if unknown:
        raise HTTPException(422, f"unknown {what}: {', '.join(sorted(set(unknown)))}")
    wanted = set(keys)
    return [i for i in items if i["key"] in wanted]


def _why(err: Exception) -> str:
    if isinstance(err, HTTPException):
        return str(err.detail)
    return f"unexpected error ({type(err).__name__})"


def _fingerprint(plan: dict) -> str:
    core = {k: plan[k] for k in ("template", "agents", "reporting", "routines", "mode", "dod_presets", "objective")}
    return hashlib.sha256(json.dumps(core, sort_keys=True, default=str).encode()).hexdigest()


def build_plan(cur, cid: str, t: dict, sel: TemplateSelection, actor_id: Optional[str]) -> dict:
    """Compute EXACTLY what applying ``sel`` of template ``t`` to ``cid`` would do.

    Read-only. The same function runs at preview and at apply, and apply refuses when the
    fingerprints differ, so what the human saw is what gets created.
    """
    try:
        sched.validate("0 9 * * *", sel.timezone)
    except sched.ScheduleError as err:
        raise HTTPException(422, str(err)) from None
    roles = _pick(t["roles"], sel.roles, "roles")
    routines = _pick(t["routines"], sel.routines, "routines")

    cur.execute(
        """SELECT id, alias, kind, terminated_at FROM agents WHERE container_id=%s""", (cid,))
    by_alias = {r["alias"]: r for r in cur.fetchall()}
    actor_alias = None
    if actor_id:
        cur.execute("SELECT alias FROM agents WHERE id=%s", (actor_id,))
        a = cur.fetchone()
        actor_alias = a["alias"] if a else None

    agents, alias_of_role = [], {}
    for r in roles:
        ex = by_alias.get(r["alias"])
        if ex is None:
            action, reason = "create", None
            alias_of_role[r["key"]] = r["alias"]
        elif ex["kind"] == "ai" and ex["terminated_at"] is None:
            action, reason = "reuse", "already on the roster — kept as is"
            alias_of_role[r["key"]] = r["alias"]
        elif ex["terminated_at"] is not None:
            action, reason = "skip", "a retired agent already uses this name"
        else:
            action, reason = "skip", "a human member already uses this name"
        agents.append({"key": r["key"], "alias": r["alias"], "role": r["role"],
                       "action": action, "reason": reason})
    # roles not selected but whose alias is a live AI agent still count as managers/assignees
    for r in t["roles"]:
        ex = by_alias.get(r["alias"])
        if r["key"] not in alias_of_role and ex is not None and ex["kind"] == "ai" and ex["terminated_at"] is None:
            alias_of_role[r["key"]] = r["alias"]

    reporting = []
    for a in agents:
        if a["action"] != "create":
            continue  # existing agents are never rewired by a template
        mgr_key = next(r["reports_to"] for r in t["roles"] if r["key"] == a["key"])
        mgr_alias = alias_of_role.get(mgr_key) if mgr_key else None
        if mgr_alias is None:
            mgr_alias = actor_alias  # top of the template's tree reports to the confirming human
        if mgr_alias:
            reporting.append({"alias": a["alias"], "reports_to": mgr_alias})

    cur.execute(
        "SELECT lower(title) AS t FROM routines WHERE container_id=%s AND archived_at IS NULL", (cid,))
    live_titles = {r["t"] for r in cur.fetchall()}
    planned_routines = []
    for r in routines:
        assignee = alias_of_role.get(r["assignee"]) if r["assignee"] else None
        exists = r["title"].lower() in live_titles
        planned_routines.append({
            "key": r["key"],
            "title": r["title"],
            "definition_of_done": r["definition_of_done"],
            "cron": r["cron"],
            "timezone": sel.timezone,
            "schedule_text": sched.describe(r["cron"], sel.timezone),
            "assignee_alias": assignee,
            "assignee_note": None if assignee or not r["assignee"] else
                "its role isn't on the roster — tasks will be assigned normally",
            "enabled": sel.enable_routines,
            "action": "skip" if exists else "create",
            "reason": "a routine with this title already exists" if exists else None,
        })

    cur.execute("SELECT project_mode, description FROM containers WHERE id=%s", (cid,))
    c = cur.fetchone()
    mode = {"from": c["project_mode"], "to": t["mode"] if sel.set_mode else c["project_mode"]}
    mode["change"] = mode["from"] != mode["to"]
    have = {p["name"].strip().lower() for p in _live_presets(cur, cid)}
    presets = []
    if sel.dod_presets:
        for p in t["dod_presets"]:
            exists = p["label"].strip().lower() in have
            presets.append({"key": p["key"], "name": p["label"], "body": p["text"],
                            "action": "skip" if exists else "create",
                            "reason": "a preset with this name already exists" if exists else None})
    objective = None
    if sel.objective is not None and sel.objective.strip():
        objective = {"from": c["description"], "to": sel.objective.strip()}

    plan = {
        "template": {"key": t["key"], "version": t["version"], "name": t["name"], "mode": t["mode"]},
        "agents": agents,
        "reporting": reporting,
        "routines": planned_routines,
        "mode": mode,
        "dod_presets": presets,
        "objective": objective,
    }
    plan["counts"] = {
        "agents_to_create": sum(1 for a in agents if a["action"] == "create"),
        "routines_to_create": sum(1 for r in planned_routines if r["action"] == "create"),
        "dod_presets_to_add": sum(1 for p in presets if p["action"] == "create"),
        "skipped": sum(1 for a in agents if a["action"] == "skip")
        + sum(1 for r in planned_routines if r["action"] == "skip")
        + sum(1 for p in presets if p["action"] == "skip"),
    }
    plan["plan_fingerprint"] = _fingerprint(plan)
    return plan


# ---------------------------------------------------------------------------
# Catalog reads
# ---------------------------------------------------------------------------

@app.get("/api/project-templates")
def list_project_templates():
    """The built-in industry templates (static catalog data; nothing project-specific)."""
    return {"templates": [summary(t) for t in CATALOG], "modes": list(PROJECT_MODES)}


@app.get("/api/project-templates/{key}")
def get_project_template(key: str):
    """One template in full: roles with their system prompts, routines, DoD presets."""
    return _template_or_404(key)


# ---------------------------------------------------------------------------
# Project profile (mode + DoD presets)
# ---------------------------------------------------------------------------

@app.get("/api/containers/{cid}/project-profile")
def get_project_profile(cid: str, request: Request):
    """The project's mode ('code' | 'general'), DoD presets and last applied template."""
    _require_cid(cid)
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        require_member_read(cur, request, cid)
        return _profile(cur, cid)


@app.put("/api/containers/{cid}/project-profile")
def update_project_profile(cid: str, body: ProjectProfileUpdate, request: Request):
    """Switch the project's mode between 'code' and 'general'.

    Human-only; owner or ``manage_autonomy`` (the grant that governs the project's other
    execution settings). Viewers and AI agents are refused. Audit-logged. Switching to
    General does not unbind GitHub or delete anything — the Code/GitHub tabs are hidden,
    and switching back shows them again with everything intact. (DoD presets are managed
    through the project_dod_presets API.)
    """
    _require_cid(cid)
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        member = require_grant(cur, request, cid, body.actor_agent_id, MODE_GRANT)
        actor = str(member["id"])
        cur.execute("SELECT project_mode FROM containers WHERE id=%s FOR UPDATE", (cid,))
        before = cur.fetchone()["project_mode"]
        if body.mode != before:
            cur.execute("UPDATE containers SET project_mode=%s WHERE id=%s", (body.mode, cid))
            log_event(cur, cid, "human", actor, "container", cid, "project_mode_changed",
                      {"from": before, "to": body.mode})
        conn.commit()
        return _profile(cur, cid)


# ---------------------------------------------------------------------------
# Templates: preview + apply
# ---------------------------------------------------------------------------

def _preview_actor(cur, request, cid, claimed):
    """The human the plan's reporting lines would point at (never trusted for authority)."""
    member = require_member_read(cur, request, cid)
    if member is not None:
        return str(member["id"])
    if claimed and valid_uuid(claimed):
        cur.execute(
            "SELECT id FROM agents WHERE id=%s AND container_id=%s AND kind='human' AND terminated_at IS NULL",
            (claimed, cid),
        )
        row = cur.fetchone()
        return str(row["id"]) if row else None
    return None


def _noop_last_application(cur, cid: str, t: dict, plan: dict):
    """``False`` when applying ``plan`` would change something; otherwise the id of the
    project's latest application (``None`` if there is none) — a no-op re-apply (A16b)."""
    c = plan["counts"]
    if c["agents_to_create"] or c["routines_to_create"] or c["dod_presets_to_add"] or plan["mode"]["change"]:
        return False
    obj = plan["objective"]
    if obj and (obj["from"] or "").strip() != obj["to"]:
        return False
    cur.execute("SELECT template_key FROM containers WHERE id=%s", (cid,))
    if cur.fetchone()["template_key"] != t["key"]:
        return False  # recording a different template on the project is itself a change
    cur.execute(
        """SELECT id FROM project_template_applications WHERE container_id=%s
            ORDER BY created_at DESC LIMIT 1""", (cid,))
    row = cur.fetchone()
    return str(row["id"]) if row else None


@app.post("/api/containers/{cid}/templates/{key}/preview")
def preview_template(cid: str, key: str, body: TemplateSelection, request: Request):
    """Exactly what applying this selection would create, reuse, skip and change.

    Read-only (member read). Returns ``plan_fingerprint``; apply must echo it.
    """
    _require_cid(cid)
    t = _template_or_404(key)
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        actor = _preview_actor(cur, request, cid, body.actor_agent_id)
        return build_plan(cur, cid, t, body, actor)


@app.post("/api/containers/{cid}/templates/{key}/apply", status_code=201, responses={
    200: {"description": "No-op re-apply: nothing would change, so nothing was recorded "
                         "(``noop: true``; ``application_id`` is the latest existing application)"}})
def apply_template(cid: str, key: str, body: TemplateApply, request: Request, response: Response):
    """Apply a previewed template plan. Human-confirmed; owner or ``manage_agents``.

    Idempotent (A16b): re-applying a plan that would change nothing — no agent, routine or
    preset to create, no mode switch, no new objective, and this template already recorded
    on the project — writes NO application row and no event. It answers 200 (not 201) with
    ``noop: true`` and the project's latest application id, so the audit trail only ever
    lists applications that did something.

    Refuses (409) when the project changed since the preview (fingerprint mismatch) and
    returns the fresh plan so the UI can show it again. Items are created through their
    normal handlers one by one; a failure on one item is reported, never hidden, and never
    rolls back items already created (each is a complete, valid object on its own).
    """
    _require_cid(cid)
    t = _template_or_404(key)
    if not body.confirm:
        raise HTTPException(400, "confirm must be true — review the preview, then confirm")

    with db_cursor() as (lock_conn, lock_cur):
        # one application per project at a time (session lock; released when this
        # dedicated connection closes, even on error)
        lock_cur.execute("SELECT pg_try_advisory_lock(hashtext('orcha-template:' || %s)) AS ok", (cid,))
        if not lock_cur.fetchone()["ok"]:
            raise HTTPException(409, "a template is already being applied to this project — try again shortly")
        lock_conn.commit()

        with db_cursor() as (conn, cur):
            require_container(cur, cid)
            member = require_grant(cur, request, cid, body.actor_agent_id, APPLY_GRANT)
            actor = str(member["id"])
            plan = build_plan(cur, cid, t, body, actor)
            if plan["mode"]["change"] and not has_grant(member, MODE_GRANT):
                raise HTTPException(
                    403, "switching the project mode requires the owner role or the "
                    f"'{MODE_GRANT}' permission — untick 'Switch mode' or ask an owner")
            if plan["plan_fingerprint"] != body.plan_fingerprint:
                raise HTTPException(409, {
                    "message": "the project changed since this preview — review the updated plan",
                    "plan": plan,
                })
            noop_last = _noop_last_application(cur, cid, t, plan)
            conn.rollback()

        if noop_last is not False:
            lock_cur.execute("SELECT pg_advisory_unlock(hashtext('orcha-template:' || %s))", (cid,))
            lock_conn.commit()
            response.status_code = 200
            return {
                "application_id": noop_last,
                "template": plan["template"],
                "noop": True,
                "ok": True,
                "result": {
                    "agents": [{"alias": a["alias"], "status": a["action"], "reason": a["reason"]}
                               for a in plan["agents"]],
                    "reporting": [],
                    "routines": [{"title": r["title"], "status": "skip", "reason": r["reason"]}
                                 for r in plan["routines"]],
                    "mode": None,
                    "dod_presets": [{"name": p["name"], "status": "skip", "reason": p["reason"]}
                                    for p in plan["dod_presets"]],
                    "objective": None,
                    "failures": [],
                },
            }

        result = {"agents": [], "reporting": [], "routines": [], "mode": None,
                  "dod_presets": [], "objective": None, "failures": []}
        role_by_key = {r["key"]: r for r in t["roles"]}
        # 1) agents — through register_agent (its own validation, grants, audit)
        for a in plan["agents"]:
            if a["action"] != "create":
                result["agents"].append({"alias": a["alias"], "status": a["action"], "reason": a["reason"]})
                continue
            spec = role_by_key[a["key"]]
            try:
                made = register_agent(cid, AgentCreate(
                    alias=spec["alias"], role=spec["role"], prompt=spec["prompt"], kind="ai"), request)
                result["agents"].append({"alias": a["alias"], "status": "created", "agent_id": made.agent_id})
            except Exception as err:  # noqa: BLE001 — reported per item, never hidden
                why = _why(err)
                result["agents"].append({"alias": a["alias"], "status": "failed", "reason": why})
                result["failures"].append(f"agent {a['alias']}: {why}")

        with db_cursor() as (_, cur):
            cur.execute("SELECT id, alias FROM agents WHERE container_id=%s AND terminated_at IS NULL", (cid,))
            id_of = {r["alias"]: str(r["id"]) for r in cur.fetchall()}
        created_aliases = {x["alias"] for x in result["agents"] if x["status"] == "created"}

        # 2) reporting lines for the NEW agents — through set_reports_to (cycle checks, audit)
        for line in plan["reporting"]:
            if line["alias"] not in created_aliases or line["reports_to"] not in id_of:
                continue
            try:
                set_reports_to(id_of[line["alias"]], ReportsToUpdate(
                    reports_to_agent_id=id_of[line["reports_to"]], actor_agent_id=actor), request)
                result["reporting"].append({**line, "status": "set"})
            except Exception as err:  # noqa: BLE001
                why = _why(err)
                result["reporting"].append({**line, "status": "failed", "reason": why})
                result["failures"].append(f"reporting line {line['alias']}: {why}")

        # 3) routines — through create_routine (schedule validation, grants, audit)
        rt_by_key = {r["key"]: r for r in t["routines"]}
        for r in plan["routines"]:
            if r["action"] != "create":
                result["routines"].append({"title": r["title"], "status": "skip", "reason": r["reason"]})
                continue
            spec = rt_by_key[r["key"]]
            assignee_id = id_of.get(r["assignee_alias"]) if r["assignee_alias"] else None
            try:
                made = create_routine(cid, RoutineCreate(
                    actor_agent_id=actor, title=spec["title"], description=spec["description"],
                    definition_of_done=spec["definition_of_done"], assignee_agent_id=assignee_id,
                    priority=spec.get("priority", 100), cron=spec["cron"], timezone=body.timezone,
                    enabled=body.enable_routines, skip_if_open=True), request)
                result["routines"].append({"title": r["title"], "status": "created", "routine_id": made["id"],
                                           "enabled": made["enabled"], "assignee_alias": made["assignee_alias"]})
            except Exception as err:  # noqa: BLE001
                why = _why(err)
                result["routines"].append({"title": r["title"], "status": "failed", "reason": why})
                result["failures"].append(f"routine {r['title']}: {why}")

        # 4) project settings + the audit row, in one transaction
        with db_cursor() as (conn, cur):
            if plan["mode"]["change"]:
                cur.execute("UPDATE containers SET project_mode=%s WHERE id=%s", (plan["mode"]["to"], cid))
                result["mode"] = plan["mode"]
            for p in plan["dod_presets"]:
                if p["action"] != "create":
                    result["dod_presets"].append({"name": p["name"], "status": "skip", "reason": p["reason"]})
                    continue
                # the shared preset store (mig 059); a name taken meanwhile is a clean skip
                cur.execute(
                    """INSERT INTO project_dod_presets
                         (container_id, name, body, source, created_by_agent_id, updated_by_agent_id)
                       VALUES (%s,%s,%s,'template_import',%s,%s)
                       ON CONFLICT DO NOTHING RETURNING id""",
                    (cid, p["name"], p["body"], actor, actor),
                )
                row = cur.fetchone()
                result["dod_presets"].append(
                    {"name": p["name"], "status": "created", "id": str(row["id"])} if row else
                    {"name": p["name"], "status": "skip", "reason": "a preset with this name already exists"})
            if plan["objective"]:
                text = plan["objective"]["to"]
                cur.execute("UPDATE containers SET description=%s WHERE id=%s RETURNING root_task_id", (text, cid))
                root = cur.fetchone()["root_task_id"]
                if root:
                    cur.execute("UPDATE tasks SET description=%s WHERE id=%s AND is_root", (text, root))
                result["objective"] = text
            cur.execute("UPDATE containers SET template_key=%s WHERE id=%s", (t["key"], cid))
            public_plan = {k: v for k, v in plan.items() if k != "plan_fingerprint"}
            cur.execute(
                """INSERT INTO project_template_applications
                     (container_id, template_key, template_version, applied_by_agent_id, plan, result)
                   VALUES (%s,%s,%s,%s,%s,%s) RETURNING id, created_at""",
                (cid, t["key"], t["version"], actor, Jsonb(public_plan), Jsonb(result)),
            )
            app_row = cur.fetchone()
            log_event(cur, cid, "human", actor, "container", cid, "template_applied", {
                "template": t["key"], "version": t["version"], "application_id": str(app_row["id"]),
                "agents_created": sum(1 for a in result["agents"] if a["status"] == "created"),
                "routines_created": sum(1 for r in result["routines"] if r["status"] == "created"),
                "mode": result["mode"], "failures": len(result["failures"]),
            })
            conn.commit()

        lock_cur.execute("SELECT pg_advisory_unlock(hashtext('orcha-template:' || %s))", (cid,))
        lock_conn.commit()

    return {
        "application_id": str(app_row["id"]),
        "template": plan["template"],
        "noop": False,
        "result": result,
        "ok": not result["failures"],
    }


@app.get("/api/containers/{cid}/template-applications")
def list_template_applications(cid: str, request: Request):
    """Every template application on this project (newest first): what was confirmed and created."""
    _require_cid(cid)
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        require_member_read(cur, request, cid)
        cur.execute(
            """SELECT p.id, p.template_key, p.template_version, p.plan, p.result, p.created_at,
                      a.alias AS applied_by_alias
                 FROM project_template_applications p
                 LEFT JOIN agents a ON a.id = p.applied_by_agent_id
                WHERE p.container_id=%s ORDER BY p.created_at DESC LIMIT 50""",
            (cid,),
        )
        return {"applications": [
            {"id": str(r["id"]), "template_key": r["template_key"], "template_version": r["template_version"],
             "applied_by_alias": r["applied_by_alias"], "plan": r["plan"], "result": r["result"],
             "created_at": r["created_at"].isoformat()}
            for r in cur.fetchall()
        ]}
