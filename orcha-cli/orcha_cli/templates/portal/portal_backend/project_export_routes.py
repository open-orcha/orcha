"""Portable project templates — export / preview / import routes.

    POST /api/containers/{cid}/template/export    build a scrubbed bundle (download)
    POST /api/containers/{cid}/template/preview   what importing a bundle here would do
    POST /api/containers/{cid}/template/import    apply it (human-confirmed)

Authority: all three are owner-or-``manage_agents`` with a HUMAN actor, viewers refused
(identity_routes.require_grant — the same two lanes as routines / agent management).
Inside an import, the parts that need ``manage_autonomy`` elsewhere (per-agent autonomy
override, auto-wake, budgets) are only applied when the actor also holds it; otherwise
the preview says they will be skipped and they are.

Human confirmation: the preview returns ``preview_digest`` (a hash of the bundle AND the
computed plan, which includes the target's current state). Import recomputes the plan
under a project lock and refuses (409) unless ``confirm`` is true and the digest still
matches — so what gets applied is exactly what the human reviewed.

Audit: ``template_exported`` / ``template_imported`` events on the container, plus the
normal per-object events (agent ``created`` with ``via: template_import``,
``agent_reports_to_changed``, ``routine_created``, ``budget_updated``,
``dod_preset_created``, ``skill_created``).

Pure bundle logic (format, scrubbing, plan) lives in project_export_bundle.py.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import HTTPException, Request
from pydantic import BaseModel, Field, ValidationError

from portal_backend import sql
from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container, valid_uuid
from portal_backend.identity_routes import has_grant, proxy_login, require_grant
from portal_backend import project_export_bundle as pb
from portal_backend import routine_schedule as sched

MANAGE_GRANT = "manage_agents"
AUTONOMY_GRANT = "manage_autonomy"
MAX_BUNDLE_CHARS = 2_000_000


class TemplateExport(BaseModel):
    actor_agent_id: Optional[str] = Field(
        default=None, description="Acting human (trust-off lane); the proxy identity wins when trusted")
    include_budgets: bool = Field(default=False, description="also carry budget limits (never spend or overrides)")


class TemplateImport(BaseModel):
    actor_agent_id: Optional[str] = None
    bundle: dict[str, Any] = Field(..., description="an orcha.project-template bundle (from export)")
    options: pb.ImportOptions = Field(default_factory=pb.ImportOptions)
    confirm: bool = Field(default=False, description="import only: the human confirmed the preview")
    preview_digest: Optional[str] = Field(
        default=None, max_length=100, description="import only: preview_digest the human reviewed")


def _require_cid(cid: str):
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")


def _authorize(cur, request: Request, cid: str, actor) -> dict:
    require_container(cur, cid)
    member = require_grant(cur, request, cid, actor, MANAGE_GRANT)
    return member


# --------------------------------------------------------------------------- export
def _export_rows(cur, cid: str, include_budgets: bool) -> dict:
    cur.execute("SELECT name FROM containers WHERE id=%s", (cid,))
    name = cur.fetchone()["name"]
    cur.execute(
        """SELECT id, alias, role, system_prompt, model, reasoning_effort,
                  auto_wake_interval_secs, autonomy_override, reports_to_agent_id
             FROM agents
            WHERE container_id=%s AND kind='ai' AND terminated_at IS NULL
            ORDER BY created_at, alias""",
        (cid,),
    )
    ai = cur.fetchall()
    cur.execute(
        "SELECT id, alias, github_login, git_email FROM agents WHERE container_id=%s AND kind='human'",
        (cid,),
    )
    humans = cur.fetchall()
    cur.execute(
        """SELECT title, description, definition_of_done, assignee_agent_id, priority, cron,
                  timezone, enabled, skip_if_open
             FROM routines WHERE container_id=%s AND archived_at IS NULL
            ORDER BY created_at, title""",
        (cid,),
    )
    routines = cur.fetchall()
    cur.execute(
        "SELECT name, body FROM project_dod_presets WHERE container_id=%s AND archived_at IS NULL "
        "ORDER BY lower(name)",
        (cid,),
    )
    presets = cur.fetchall()
    cur.execute(
        "SELECT name, description, body FROM project_skills WHERE container_id=%s AND archived_at IS NULL "
        "ORDER BY name",
        (cid,),
    )
    skills = cur.fetchall()
    project_budget, agent_budgets = None, []
    if include_budgets:
        cur.execute(
            "SELECT monthly_limit_usd, monthly_limit_tokens FROM container_budgets WHERE container_id=%s",
            (cid,),
        )
        project_budget = cur.fetchone()
        cur.execute(
            "SELECT agent_id, monthly_limit_usd, monthly_limit_tokens FROM agent_budgets WHERE container_id=%s",
            (cid,),
        )
        agent_budgets = cur.fetchall()
    return {
        "project_name": name, "ai_agents": ai, "humans": humans, "routines": routines,
        "presets": presets, "skills": skills, "include_budgets": include_budgets,
        "project_budget": project_budget, "agent_budgets": agent_budgets,
    }


@app.post("/api/containers/{cid}/template/export")
def export_project_template(cid: str, body: TemplateExport, request: Request):
    """Export this project's reusable setup as a versioned, scrubbed JSON bundle
    (orcha.project-template v1): AI roster (role, prompt, model, effort, auto-wake,
    autonomy override, reporting lines), routines, DoD presets, skills and — when
    `include_budgets` — budget limits. Never: keys, tokens, PATs, member identities or
    any history. Owner-or-manage_agents; audited as `template_exported`."""
    _require_cid(cid)
    with db_cursor() as (conn, cur):
        member = _authorize(cur, request, cid, body.actor_agent_id)
        bundle = pb.build_bundle(**_export_rows(cur, cid, body.include_budgets))
        log_event(cur, cid, "human", str(member["id"]), "container", cid, "template_exported", {
            "digest": bundle["digest"],
            "include_budgets": body.include_budgets,
            "counts": {k: len(bundle.get(k) or []) for k in ("roster", "routines", "dod_presets", "skills")},
            "redacted_fields": len(bundle["scrub"]["redactions"]),
        })
        conn.commit()
    return bundle


# --------------------------------------------------------------------------- import
_SECTION_NOUN = {"roster": "agent", "routines": "routine", "dod_presets": "DoD preset",
                 "skills": "skill", "human_seats": "human seat", "agents": "agent budget"}


def validation_text(first: dict) -> str:
    """One pydantic error as plain words for the import dialog: no "Value error, "
    prefix, no dotted `roster.0.system_prompt` path (→ "agent 1 › system prompt")."""
    msg = str(first.get("msg") or "invalid value")
    if msg.startswith("Value error, "):
        msg = msg[len("Value error, "):]
    loc = tuple(first.get("loc") or ())
    if loc == ("version",):
        return msg if msg.startswith("this template") else f"the template's version isn't usable: {msg}"
    parts: list[str] = []
    for i, p in enumerate(loc):
        if isinstance(p, int):
            prev = loc[i - 1] if i else None
            noun = _SECTION_NOUN.get(prev) if isinstance(prev, str) else None
            if noun and parts:
                parts[-1] = f"{noun} {p + 1}"
            else:
                parts.append(f"item {p + 1}")
        else:
            parts.append(str(p).replace("_", " "))
    where = " › ".join(parts)
    return f"the template isn't valid: {where}: {msg}" if where else f"the template isn't valid: {msg}"


def _parse_bundle(raw: dict) -> pb.ProjectTemplateBundle:
    if len(pb.canonical(raw)) > MAX_BUNDLE_CHARS:
        raise HTTPException(413, "this template is too large to import")
    if raw.get("format") != pb.FORMAT:
        raise HTTPException(422, "this file isn't a Embodent project template")
    try:
        bundle = pb.ProjectTemplateBundle.model_validate(raw)
        pb.check_bundle(bundle)
    except ValidationError as err:
        raise HTTPException(422, validation_text(err.errors()[0])) from None
    except pb.BundleProblem as err:
        raise HTTPException(422, str(err)) from None
    return bundle


def _target_state(cur, cid: str, member: dict) -> dict:
    cur.execute(
        "SELECT id, alias, kind, terminated_at IS NULL AS live FROM agents WHERE container_id=%s",
        (cid,),
    )
    agents = [{"id": str(r["id"]), "alias": r["alias"], "kind": r["kind"], "live": r["live"]}
              for r in cur.fetchall()]
    cur.execute(
        "SELECT title FROM routines WHERE container_id=%s AND archived_at IS NULL", (cid,)
    )
    titles = [r["title"] for r in cur.fetchall()]
    cur.execute(
        "SELECT name, body FROM project_dod_presets WHERE container_id=%s AND archived_at IS NULL",
        (cid,),
    )
    presets = {r["name"].lower(): r["body"] for r in cur.fetchall()}
    cur.execute(
        "SELECT name, body FROM project_skills WHERE container_id=%s AND archived_at IS NULL",
        (cid,),
    )
    skills = {r["name"]: r["body"] for r in cur.fetchall()}
    cur.execute(
        "SELECT 1 FROM container_budgets WHERE container_id=%s AND "
        "(monthly_limit_usd IS NOT NULL OR monthly_limit_tokens IS NOT NULL)",
        (cid,),
    )
    return {
        "actor": {"id": str(member["id"]), "alias": member["alias"]},
        "can_autonomy": has_grant(member, AUTONOMY_GRANT),
        "agents": agents,
        "routine_titles": titles,
        "presets": presets,
        "skills": skills,
        "project_budget_set": cur.fetchone() is not None,
    }


def _summary(raw: dict, bundle: pb.ProjectTemplateBundle) -> dict:
    digest = raw.get("digest")
    return {
        "format": bundle.format,
        "version": bundle.version,
        "project_name": bundle.source.project_name,
        "exported_at": bundle.exported_at,
        "digest_ok": (digest == pb.bundle_digest(raw)) if digest else None,
        "counts": {
            "roster": len(bundle.roster),
            "routines": len(bundle.routines),
            "dod_presets": len(bundle.dod_presets),
            "skills": len(bundle.skills),
            "budgets": (
                (1 if bundle.budgets.project else 0) + len(bundle.budgets.agents)
                if bundle.budgets else 0
            ),
        },
        "has_budgets": bundle.budgets is not None,
    }


def _flag_tampering(out: dict) -> None:
    if out["bundle"]["digest_ok"] is False:
        out["warnings"] = [
            "this file was changed after it was exported — review the prompts before importing",
            *out["warnings"],
        ]


def _preview(cur, cid, member, raw, bundle, opts) -> dict:
    plan = pb.plan_import(bundle, opts, _target_state(cur, cid, member))
    out = {"bundle": _summary(raw, bundle), **plan}
    _flag_tampering(out)
    out["preview_digest"] = pb.plan_digest(raw, plan)
    return out


@app.post("/api/containers/{cid}/template/preview")
def preview_project_template(cid: str, body: TemplateImport, request: Request):
    """What importing `bundle` into this project would do, item by item (create / rename
    / skip + why), with alias collisions and the `preview_digest` the import must echo.
    Writes nothing. Owner-or-manage_agents."""
    _require_cid(cid)
    bundle = _parse_bundle(body.bundle)
    with db_cursor() as (_, cur):
        member = _authorize(cur, request, cid, body.actor_agent_id)
        return _preview(cur, cid, member, body.bundle, bundle, body.options)


@app.post("/api/template/preview-new")
def preview_project_template_new(body: TemplateImport, request: Request):
    """What importing `bundle` into a brand-NEW project would do (the portal's "Import
    into a new project" flow shows this before it creates anything). A new project holds
    only its founding human (you, its owner), so nothing collides and every part applies.
    Writes nothing and returns no `preview_digest`: after creating the project the client
    previews it for real and imports with THAT digest — if the real plan differs from
    this one, the client shows it for another confirmation."""
    bundle = _parse_bundle(body.bundle)
    founder = proxy_login(request) or "operator"
    target = {
        "actor": {"id": None, "alias": founder},
        "can_autonomy": True,
        "agents": [{"id": None, "alias": founder, "kind": "human", "live": True}],
        "routine_titles": [], "presets": {}, "skills": {}, "project_budget_set": False,
    }
    plan = pb.plan_import(bundle, body.options, target)
    out = {"bundle": _summary(body.bundle, bundle), **plan, "target": "new", "preview_digest": None}
    _flag_tampering(out)
    return out


@app.post("/api/containers/{cid}/template/import")
def import_project_template(cid: str, body: TemplateImport, request: Request):
    """Apply a reviewed template import. Requires `confirm: true` and the
    `preview_digest` from the preview; if the project changed since (or the options
    differ) the plan differs and this is a 409 — preview again. All-or-nothing: one
    transaction under a project lock. Owner-or-manage_agents (+ manage_autonomy for the
    autonomy / auto-wake / budget parts, which the plan otherwise skips)."""
    _require_cid(cid)
    if not body.confirm:
        raise HTTPException(400, "an import must be confirmed after reviewing its preview (confirm: true)")
    bundle = _parse_bundle(body.bundle)
    with db_cursor() as (conn, cur):
        member = _authorize(cur, request, cid, body.actor_agent_id)
        actor = str(member["id"])
        # serialize imports and org edits in this project (same key as PUT reports-to)
        cur.execute("SELECT id FROM containers WHERE id=%s " + sql.for_update(), (cid,))
        cur.execute(sql.xact_lock("'orcha-org:' || %s"), (cid,))
        preview = _preview(cur, cid, member, body.bundle, bundle, body.options)
        if not body.preview_digest or body.preview_digest != preview["preview_digest"]:
            raise HTTPException(409, {
                "message": "the project or the choices changed since this preview — review it again",
                "preview": preview,
            })
        if preview["errors"]:
            raise HTTPException(422, {
                "message": "fix the highlighted items before importing: "
                + "; ".join(e["message"] for e in preview["errors"]),
                "errors": preview["errors"],
            })
        try:
            result = _apply(cur, cid, actor, bundle, preview)
        except Exception as exc:  # noqa: BLE001 — re-raised unless a unique violation
            if not sql.is_unique_violation(exc):
                raise
            raise HTTPException(409, "something with the same name was just added — preview again") from None
        log_event(cur, cid, "human", actor, "container", cid, "template_imported", {
            "source_project": bundle.source.project_name,
            "bundle_digest": body.bundle.get("digest"),
            "preview_digest": preview["preview_digest"],
            "counts": preview["counts"],
            "created_agents": [a["alias"] for a in result["agents"]],
            "options": preview["options"],
        })
        conn.commit()
    return {"applied": preview["counts"], **result}


def _apply(cur, cid: str, actor: str, bundle: pb.ProjectTemplateBundle, preview: dict) -> dict:
    sec = preview["sections"]
    src = {a.alias.lower(): a for a in bundle.roster}
    new_ids: dict[str, str] = {}
    agents_out = []
    for item in sec["roster"]:
        if item["action"] == "skip":
            continue
        a = src[item["alias"].lower()]
        cur.execute(
            # clock_timestamp(), not the transaction's now(): every row of one import
            # would otherwise share a created_at, and export (ORDER BY created_at, alias)
            # would come back alphabetised instead of in the template's order.
            """INSERT INTO agents (container_id, alias, role, kind, system_prompt, model,
                                   reasoning_effort, auto_wake_interval_secs,
                                   autonomy_override, member_role, created_at)
               VALUES (%s, %s, %s, 'ai', %s, %s, %s, %s, %s, 'member', clock_timestamp())
               RETURNING id""",
            (cid, item["final_alias"], a.role, a.system_prompt, item["model"],
             item["reasoning_effort"], item["auto_wake_interval_secs"], item["autonomy_override"]),
        )
        aid = str(cur.fetchone()["id"])
        new_ids[item["final_alias"].lower()] = aid
        log_event(cur, cid, "human", actor, "agent", aid, "created", {
            "alias": item["final_alias"], "role": a.role, "kind": "ai", "via": "template_import",
            **({"renamed_from": a.alias} if item["action"] == "rename" else {}),
        })
        agents_out.append({"alias": item["final_alias"], "agent_id": aid, "from_alias": a.alias})

    lines_out = []
    for line in sec["reporting_lines"]:
        if line["action"] != "set":
            continue
        mgr = line["manager"]
        mid = new_ids[mgr["alias"].lower()] if mgr["kind"] == "new" else mgr["id"]
        aid = new_ids[line["alias"].lower()]
        cur.execute("UPDATE agents SET reports_to_agent_id=%s WHERE id=%s", (mid, aid))
        cur.execute("SELECT alias FROM agents WHERE id=%s", (mid,))
        mgr_alias = cur.fetchone()["alias"]
        log_event(cur, cid, "human", actor, "agent", aid, "agent_reports_to_changed", {
            "alias": line["alias"], "from_agent_id": None, "from_alias": None,
            "to_agent_id": mid, "to_alias": mgr_alias, "via": "template_import",
        })
        lines_out.append({"alias": line["alias"], "reports_to": mgr_alias})

    routines_out = []
    now = datetime.now(timezone.utc)
    for item, r in zip(sec["routines"], bundle.routines):
        if item["action"] != "create":
            continue
        cron, tz = sched.validate(r.cron, r.timezone)
        asg = item["assignee"]
        assignee = (new_ids[asg["alias"].lower()] if asg["kind"] == "new" else asg["id"]) if asg else None
        enabled = item["enabled"]
        cur.execute(
            """INSERT INTO routines
                 (container_id, title, description, definition_of_done, assignee_agent_id,
                  priority, cron, timezone, enabled, skip_if_open, next_run_at,
                  created_by_agent_id, updated_by_agent_id, created_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s, clock_timestamp()) RETURNING id""",
            (cid, r.title.strip(), r.description, r.definition_of_done, assignee, r.priority,
             cron.expr, r.timezone, enabled, r.skip_if_open,
             sched.next_after(cron, tz, now) if enabled else None, actor, actor),
        )
        rid = str(cur.fetchone()["id"])
        log_event(cur, cid, "human", actor, "routine", rid, "routine_created", {
            "title": r.title, "cron": cron.expr, "timezone": r.timezone, "enabled": enabled,
            "assignee_agent_id": assignee, "via": "template_import",
        })
        routines_out.append({"routine_id": rid, "title": r.title, "enabled": enabled})

    presets_out = []
    by_name = {p.name.strip(): p for p in bundle.dod_presets}
    for item in sec["dod_presets"]:
        if item["action"] == "skip":
            continue
        p = by_name[item["name"]]
        cur.execute(
            """INSERT INTO project_dod_presets (container_id, name, body, source,
                                                created_by_agent_id, updated_by_agent_id)
               VALUES (%s, %s, %s, 'template_import', %s, %s) RETURNING id""",
            (cid, item["final_name"], p.body, actor, actor),
        )
        pid = str(cur.fetchone()["id"])
        log_event(cur, cid, "human", actor, "dod_preset", pid, "dod_preset_created",
                  {"name": item["final_name"], "via": "template_import"})
        presets_out.append({"id": pid, "name": item["final_name"]})

    skills_out = []
    by_skill = {s.name: s for s in bundle.skills}
    for item in sec["skills"]:
        if item["action"] == "skip":
            continue
        s = by_skill[item["name"]]
        cur.execute(
            """INSERT INTO project_skills (container_id, name, description, body, source,
                                           created_by_agent_id, updated_by_agent_id)
               VALUES (%s, %s, %s, %s, 'template_import', %s, %s) RETURNING id""",
            (cid, item["final_name"], s.description, s.body, actor, actor),
        )
        sid = str(cur.fetchone()["id"])
        log_event(cur, cid, "human", actor, "skill", sid, "skill_created",
                  {"name": item["final_name"], "via": "template_import"})
        skills_out.append({"id": sid, "name": item["final_name"]})

    budgets_out = []
    for item in sec["budgets"]:
        if item["action"] != "set":
            continue
        changes = {c: {"from": None, "to": item[c]}
                   for c in ("monthly_limit_usd", "monthly_limit_tokens") if item[c] is not None}
        if item["scope"] == "project":
            cur.execute(
                """INSERT INTO container_budgets (container_id, monthly_limit_usd, monthly_limit_tokens, updated_by)
                   VALUES (%s, %s, %s, %s)
                   ON CONFLICT (container_id) DO UPDATE
                      SET monthly_limit_usd=EXCLUDED.monthly_limit_usd,
                          monthly_limit_tokens=EXCLUDED.monthly_limit_tokens,
                          warned_period=NULL, paused_period=NULL,
                          updated_by=EXCLUDED.updated_by, updated_at=now()""",
                (cid, item["monthly_limit_usd"], item["monthly_limit_tokens"], actor),
            )
            log_event(cur, cid, "human", actor, "container", cid, "budget_updated",
                      {"changes": changes, "via": "template_import"})
        else:
            aid = new_ids[item["alias"].lower()]
            cur.execute(
                """INSERT INTO agent_budgets (agent_id, container_id, monthly_limit_usd,
                                              monthly_limit_tokens, updated_by)
                   VALUES (%s, %s, %s, %s, %s)""",
                (aid, cid, item["monthly_limit_usd"], item["monthly_limit_tokens"], actor),
            )
            log_event(cur, cid, "human", actor, "agent", aid, "budget_updated",
                      {"changes": changes, "via": "template_import"})
        budgets_out.append({"scope": item["scope"], "alias": item.get("alias")})

    return {
        "agents": agents_out,
        "reporting_lines": lines_out,
        "routines": routines_out,
        "dod_presets": presets_out,
        "skills": skills_out,
        "budgets": budgets_out,
    }
