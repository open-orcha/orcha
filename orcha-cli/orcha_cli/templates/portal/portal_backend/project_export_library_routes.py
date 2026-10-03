"""A project's template library: definition-of-done presets and skills (mig 059).

These are the two template sections that had no store before portable templates:

    GET    /api/containers/{cid}/dod-presets        member read (viewers included)
    POST   /api/containers/{cid}/dod-presets        owner-or-manage_agents, human actor
    PATCH  /api/dod-presets/{pid}                    "
    DELETE /api/dod-presets/{pid}?actor_agent_id=    " (archives; history kept)

    GET    /api/containers/{cid}/skills             member read
    POST   /api/containers/{cid}/skills             owner-or-manage_agents
    PATCH  /api/skills/{sid}                         "
    DELETE /api/skills/{sid}?actor_agent_id=         " (archives)

A DoD preset is plain text a human copies into a task's definition of done; a skill is a
named markdown playbook. Both are exported / imported by project_export_routes.py.
Every write is audited in `events` (entity_type 'dod_preset' / 'skill').
"""

from __future__ import annotations

from typing import Optional

import psycopg
from fastapi import HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator
from pydantic_core import PydanticCustomError

from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container, valid_uuid
from portal_backend.identity_routes import require_grant, require_member_read
from portal_backend import project_export_bundle as pb

MANAGE_GRANT = "manage_agents"


def _uuid(value, what):
    if not valid_uuid(value):
        raise HTTPException(400, f"{what} is not a valid UUID")


def _clean(v: Optional[str], what: str) -> Optional[str]:
    if v is None:
        return None
    v = v.strip()
    if not v:
        raise PydanticCustomError("value_error", "{what} can't be empty", {"what": what})
    return v


class PresetCreate(BaseModel):
    actor_agent_id: Optional[str] = None
    name: str = Field(..., min_length=1, max_length=pb.PRESET_NAME_MAX)
    body: str = Field(..., min_length=1, max_length=pb.PRESET_BODY_MAX)

    @field_validator("name", "body")
    @classmethod
    def _nonblank(cls, v, info):
        return _clean(v, info.field_name)


class PresetUpdate(BaseModel):
    actor_agent_id: Optional[str] = None
    name: Optional[str] = Field(default=None, min_length=1, max_length=pb.PRESET_NAME_MAX)
    body: Optional[str] = Field(default=None, min_length=1, max_length=pb.PRESET_BODY_MAX)

    @field_validator("name", "body")
    @classmethod
    def _nonblank(cls, v, info):
        return _clean(v, info.field_name)


class SkillCreate(BaseModel):
    actor_agent_id: Optional[str] = None
    name: str = Field(..., min_length=1, max_length=63, description="lowercase letters, digits and dashes")
    description: Optional[str] = Field(default=None, max_length=pb.SKILL_DESC_MAX)
    body: str = Field(..., min_length=1, max_length=pb.SKILL_BODY_MAX)

    @field_validator("name")
    @classmethod
    def _name(cls, v):
        v = v.strip()
        if not pb.SKILL_NAME_RE.match(v):
            raise PydanticCustomError(
                "value_error", "skill names are lowercase letters, digits and dashes (e.g. release-checklist)")
        return v

    @field_validator("body")
    @classmethod
    def _body(cls, v):
        return _clean(v, "body")


class SkillUpdate(BaseModel):
    actor_agent_id: Optional[str] = None
    name: Optional[str] = Field(default=None, min_length=1, max_length=63)
    description: Optional[str] = Field(default=None, max_length=pb.SKILL_DESC_MAX)
    body: Optional[str] = Field(default=None, min_length=1, max_length=pb.SKILL_BODY_MAX)

    @field_validator("name")
    @classmethod
    def _name(cls, v):
        if v is None:
            return v
        v = v.strip()
        if not pb.SKILL_NAME_RE.match(v):
            raise PydanticCustomError(
                "value_error", "skill names are lowercase letters, digits and dashes (e.g. release-checklist)")
        return v

    @field_validator("body")
    @classmethod
    def _body(cls, v):
        return _clean(v, "body")


# table-driven: both resources share one shape
_KINDS = {
    "dod_preset": {
        "table": "project_dod_presets",
        "cols": ("name", "body"),
        "label": "DoD preset",
    },
    "skill": {
        "table": "project_skills",
        "cols": ("name", "description", "body"),
        "label": "skill",
    },
}


def _serialize(row) -> dict:
    out = {k: row[k] for k in row.keys() if k not in ("container_id", "archived_at")}
    for k in ("id", "created_by_agent_id", "updated_by_agent_id"):
        if out.get(k) is not None:
            out[k] = str(out[k])
    for k in ("created_at", "updated_at"):
        if out.get(k) is not None:
            out[k] = out[k].isoformat()
    return out


def _select(kind: str) -> str:
    t = _KINDS[kind]["table"]
    return (
        f"SELECT x.*, cb.alias AS created_by_alias, ub.alias AS updated_by_alias FROM {t} x "
        "LEFT JOIN agents cb ON cb.id = x.created_by_agent_id "
        "LEFT JOIN agents ub ON ub.id = x.updated_by_agent_id "
    )


def _list(kind: str, cid: str, request: Request):
    _uuid(cid, "container_id")
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        require_member_read(cur, request, cid)
        order = "lower(x.name)" if kind == "dod_preset" else "x.name"
        cur.execute(_select(kind) + f"WHERE x.container_id=%s AND x.archived_at IS NULL ORDER BY {order}", (cid,))
        return {"items": [_serialize(r) for r in cur.fetchall()]}


def _create(kind: str, cid: str, body, request: Request):
    _uuid(cid, "container_id")
    k = _KINDS[kind]
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        actor = str(require_grant(cur, request, cid, body.actor_agent_id, MANAGE_GRANT)["id"])
        vals = [getattr(body, c) for c in k["cols"]]
        try:
            cur.execute(
                f"INSERT INTO {k['table']} (container_id, {', '.join(k['cols'])}, "
                "created_by_agent_id, updated_by_agent_id) VALUES "
                f"(%s, {', '.join(['%s'] * len(vals))}, %s, %s) RETURNING id",
                (cid, *vals, actor, actor),
            )
        except psycopg.errors.UniqueViolation:
            raise HTTPException(409, f"a {k['label']} named '{body.name}' already exists here") from None
        xid = str(cur.fetchone()["id"])
        log_event(cur, cid, "human", actor, kind, xid, f"{kind}_created", {"name": body.name})
        conn.commit()
        cur.execute(_select(kind) + "WHERE x.id=%s", (xid,))
        return _serialize(cur.fetchone())


def _load(cur, kind: str, xid: str):
    _uuid(xid, "id")
    k = _KINDS[kind]
    cur.execute(f"SELECT * FROM {k['table']} WHERE id=%s AND archived_at IS NULL FOR UPDATE", (xid,))
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, f"{k['label']} {xid} not found")
    return row


def _update(kind: str, xid: str, body, request: Request):
    k = _KINDS[kind]
    with db_cursor() as (conn, cur):
        row = _load(cur, kind, xid)
        cid = str(row["container_id"])
        actor = str(require_grant(cur, request, cid, body.actor_agent_id, MANAGE_GRANT)["id"])
        fields = [c for c in k["cols"] if c in body.model_fields_set and c != "actor_agent_id"]
        changed = {c: getattr(body, c) for c in fields if getattr(body, c) != row[c]}
        if any(c in changed and changed[c] is None for c in ("name", "body")):
            raise HTTPException(422, "name and body can't be cleared")
        if changed:
            sets = ", ".join(f"{c}=%s" for c in changed)
            try:
                cur.execute(
                    f"UPDATE {k['table']} SET {sets}, updated_by_agent_id=%s, updated_at=now() WHERE id=%s",
                    (*changed.values(), actor, xid),
                )
            except psycopg.errors.UniqueViolation:
                raise HTTPException(409, f"a {k['label']} named '{changed.get('name')}' already exists here") from None
            log_event(cur, cid, "human", actor, kind, xid, f"{kind}_updated", {"fields": sorted(changed)})
            conn.commit()
        cur.execute(_select(kind) + "WHERE x.id=%s", (xid,))
        return _serialize(cur.fetchone())


def _delete(kind: str, xid: str, actor_agent_id: Optional[str], request: Request):
    with db_cursor() as (conn, cur):
        row = _load(cur, kind, xid)
        cid = str(row["container_id"])
        actor = str(require_grant(cur, request, cid, actor_agent_id, MANAGE_GRANT)["id"])
        cur.execute(
            f"UPDATE {_KINDS[kind]['table']} SET archived_at=now(), updated_by_agent_id=%s WHERE id=%s",
            (actor, xid),
        )
        log_event(cur, cid, "human", actor, kind, xid, f"{kind}_deleted", {"name": row["name"]})
        conn.commit()
    return {"id": xid, "deleted": True}


# --------------------------------------------------------------------------- DoD presets
@app.get("/api/containers/{cid}/dod-presets")
def list_dod_presets(cid: str, request: Request):
    """This project's definition-of-done presets (live, by name). Member read."""
    return _list("dod_preset", cid, request)


@app.post("/api/containers/{cid}/dod-presets", status_code=201)
def create_dod_preset(cid: str, body: PresetCreate, request: Request):
    """Add a named definition-of-done preset. Owner-or-manage_agents, human actor."""
    return _create("dod_preset", cid, body, request)


@app.patch("/api/dod-presets/{pid}")
def update_dod_preset(pid: str, body: PresetUpdate, request: Request):
    """Rename / re-word a preset (tasks that already copied it are unaffected)."""
    return _update("dod_preset", pid, body, request)


@app.delete("/api/dod-presets/{pid}")
def delete_dod_preset(pid: str, request: Request, actor_agent_id: Optional[str] = Query(None)):
    """Archive a preset (kept for the audit trail; its name becomes free again)."""
    return _delete("dod_preset", pid, actor_agent_id, request)


# --------------------------------------------------------------------------- skills
@app.get("/api/containers/{cid}/skills")
def list_project_skills(cid: str, request: Request):
    """This project's skills (named markdown playbooks). Member read."""
    return _list("skill", cid, request)


@app.post("/api/containers/{cid}/skills", status_code=201)
def create_project_skill(cid: str, body: SkillCreate, request: Request):
    """Add a skill. Owner-or-manage_agents, human actor."""
    return _create("skill", cid, body, request)


@app.patch("/api/skills/{sid}")
def update_project_skill(sid: str, body: SkillUpdate, request: Request):
    """Edit a skill's name / description / body."""
    return _update("skill", sid, body, request)


@app.delete("/api/skills/{sid}")
def delete_project_skill(sid: str, request: Request, actor_agent_id: Optional[str] = Query(None)):
    """Archive a skill."""
    return _delete("skill", sid, actor_agent_id, request)
