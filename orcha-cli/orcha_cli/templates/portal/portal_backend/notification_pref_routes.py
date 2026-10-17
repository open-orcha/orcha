"""Notification preferences API (mig 063) — read/write YOUR OWN rules, per project + defaults.

  GET    /api/containers/{cid}/notification-prefs            → the acting member's view
  PUT    /api/containers/{cid}/notification-prefs            → this project's override
                                                               {rules?, muted?}
  DELETE /api/containers/{cid}/notification-prefs            → drop the override (inherit)
  GET    /api/containers/{cid}/notification-prefs/defaults   → same view (defaults focus)
  PUT    /api/containers/{cid}/notification-prefs/defaults   → the person's defaults
                                                               {rules?, pause?, quiet_hours?}
  POST   /api/containers/{cid}/notification-prefs/check      → resolved decisions for a
                                                               channel (the desktop host)

Identity (the per-member settings convention, identity_routes):
  * Trusted proxy header → the member IS the login resolved in this project. A
    client-supplied actor_agent_id naming anyone else is refused (403): you can only
    read or change your own notification settings. A non-member is 403.
  * Trust off / headerless break-glass lane → `actor_agent_id` (a live human of this
    project); without one, the project's first human (the local operator — what the
    desktop host, which carries no identity, gets).
  * VIEWERS may change their own notification settings: it is personal, read-scoped
    configuration, not a project mutation (like pairing a phone, write=False).

Every write is validated (notification_prefs.validate_*, plain-words 422s) and
audit-logged (`notification_prefs_changed` in the events table).
"""

import json
from typing import Any, Optional

from fastapi import HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from portal_backend import notification_prefs as np
from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container, valid_uuid
from portal_backend.identity_routes import _proxy_trusted, find_member_by_login, proxy_login


class ProjectPrefsBody(BaseModel):
    """Replace this project's override. Omitted fields are left as they are."""

    model_config = ConfigDict(extra="forbid")
    actor_agent_id: Optional[str] = None
    rules: Optional[dict[str, Any]] = Field(
        default=None,
        description="Category overrides for THIS project: {category: {scope?, channels?}}. "
        "Replaces the whole override map; {} = inherit every category.",
    )
    muted: Optional[bool] = Field(default=None, description="Mute this project (alerts only).")


class DefaultPrefsBody(BaseModel):
    """Change the person's defaults (apply to every project without an override)."""

    model_config = ConfigDict(extra="forbid")
    actor_agent_id: Optional[str] = None
    rules: Optional[dict[str, Any]] = Field(
        default=None, description="{category: {scope?, channels?}} merged over the shipped defaults."
    )
    pause: Optional[dict[str, Any]] = Field(
        default=None, description="null = not paused; {until: epoch seconds} or {until: null} (until turned back on)."
    )
    quiet_hours: Optional[dict[str, Any]] = Field(
        default=None, description="null = off; {start: 'HH:MM', end: 'HH:MM', tz: IANA zone}."
    )


class CheckItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: str = Field(max_length=64)
    ref_id: Optional[str] = None


class CheckBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    channel: str
    items: list[CheckItem] = Field(default_factory=list, max_length=100)
    actor_agent_id: Optional[str] = None


# ------------------------------------------------------------------------- identity

_MEMBER_COLS = "id, alias, github_login, member_role, grants, container_id"


def _acting_member(cur, request: Request, cid: str, actor_agent_id: Optional[str]):
    """The human whose notification settings this call reads/writes (see module doc)."""
    login = proxy_login(request)
    if login:
        member = find_member_by_login(cur, cid, login)
        if member is None:
            raise HTTPException(
                403,
                f"your GitHub account ('{login}') is not a member of this project "
                "— notification settings belong to members",
            )
        if actor_agent_id and str(actor_agent_id) != str(member["id"]):
            raise HTTPException(403, "you can only change your own notification settings")
        cur.execute(f"SELECT {_MEMBER_COLS} FROM agents WHERE id=%s", (str(member["id"]),))
        return cur.fetchone()
    if actor_agent_id:
        if not valid_uuid(actor_agent_id):
            raise HTTPException(400, "actor_agent_id must be a valid UUID")
        cur.execute(
            f"""SELECT {_MEMBER_COLS} FROM agents
                WHERE id=%s AND container_id=%s AND kind='human' AND terminated_at IS NULL""",
            (actor_agent_id, cid),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(403, "actor is not a live human member of this project")
        return row
    cur.execute(
        f"""SELECT {_MEMBER_COLS} FROM agents
            WHERE container_id=%s AND kind='human' AND terminated_at IS NULL
            ORDER BY created_at ASC, id ASC LIMIT 1""",
        (cid,),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(409, "this project has no human member yet")
    return row


def _check_cid(cur, cid: str):
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    require_container(cur, cid)


# --------------------------------------------------------------------------- payload


def _channels_available(cur, cid: str, member) -> dict:
    """Which channels can actually deliver for this person here (the UI hides the rest)."""
    out = {
        "in_app": {"available": True, "reason": None},
        "desktop": {"available": True, "reason": None},
        "push": {"available": False, "reason": "No phone is set up for push — pair one under Devices & pairing."},
        "slack": {"available": False, "reason": "Slack isn't connected to this project."},
    }
    if _proxy_trusted():
        out["desktop"] = {
            "available": False,
            "reason": "The desktop app alerts only for projects running on your computer.",
        }
    login = (member.get("github_login") or "").strip().lower()
    if login:
        cur.execute(
            "SELECT 1 FROM push_devices WHERE github_login=%s AND revoked_at IS NULL LIMIT 1",
            (login,),
        )
        if cur.fetchone():
            out["push"] = {"available": True, "reason": None}
    cur.execute("SELECT slack_webhook_url FROM containers WHERE id=%s", (cid,))
    c = cur.fetchone()
    if c and (c.get("slack_webhook_url") or "").strip():
        out["slack"] = {"available": True, "reason": None}
    return out


def _payload(cur, cid: str, member, request: Request) -> dict:
    defaults_doc, project_doc = np.load_docs(cur, member)
    effective = np.resolve(defaults_doc, project_doc)
    defaults_only = np.resolve(defaults_doc, None)
    return {
        "member": {
            "id": str(member["id"]),
            "alias": member["alias"],
            "member_role": member.get("member_role"),
        },
        "catalog": np.catalog(),
        "channels": _channels_available(cur, cid, member),
        "defaults": {
            "rules": defaults_only["rules"],
            "pause": defaults_only["pause"],
            "quiet_hours": defaults_only["quiet_hours"],
            "stored": defaults_doc is not None,
        },
        "project": {
            "rules": np._safe_rules((project_doc or {}).get("rules")),
            "muted": bool((project_doc or {}).get("muted")),
            "stored": project_doc is not None,
        },
        "effective": {
            **effective,
            "paused_now": np.is_paused(effective),
            "quiet_now": np.in_quiet_hours(effective["quiet_hours"]),
        },
        "editable": True,
    }


def _audit(cur, cid, member, scope: str, changed: dict):
    log_event(
        cur,
        cid,
        "human",
        str(member["id"]),
        "agent",
        str(member["id"]),
        "notification_prefs_changed",
        {"scope": scope, "fields": sorted(changed), "changes": changed},
    )


def _422(e: np.PrefsError):
    raise HTTPException(422, str(e))


# ---------------------------------------------------------------------------- routes


@app.get("/api/containers/{cid}/notification-prefs")
def get_notification_prefs(cid: str, request: Request, actor_agent_id: Optional[str] = None):
    """The acting member's notification settings for this project: the category ×
    channel catalog, which channels are available, the person's defaults, this
    project's override and the resolved (effective) rules."""
    with db_cursor() as (_, cur):
        _check_cid(cur, cid)
        member = _acting_member(cur, request, cid, actor_agent_id)
        return _payload(cur, cid, member, request)


@app.put("/api/containers/{cid}/notification-prefs")
def put_notification_prefs(cid: str, body: ProjectPrefsBody, request: Request):
    """Set THIS project's override (rules and/or mute) for the acting member."""
    with db_cursor() as (conn, cur):
        _check_cid(cur, cid)
        member = _acting_member(cur, request, cid, body.actor_agent_id)
        sent = body.model_fields_set - {"actor_agent_id"}
        if not sent:
            raise HTTPException(422, "nothing to change — send rules and/or muted")
        _, project_doc = np.load_docs(cur, member)
        doc = dict(project_doc or {})
        changed = {}
        if "rules" in sent:
            try:
                doc["rules"] = np.validate_rules(body.rules if body.rules is not None else {})
            except np.PrefsError as e:
                _422(e)
            changed["rules"] = doc["rules"]
        if "muted" in sent:
            if body.muted is None:
                raise HTTPException(422, "muted must be true or false")
            doc["muted"] = bool(body.muted)
            changed["muted"] = doc["muted"]
        cur.execute(
            """INSERT INTO notification_prefs (member_agent_id, container_id, prefs, updated_at)
               VALUES (%s, %s, %s, now())
               ON CONFLICT (member_agent_id)
               DO UPDATE SET prefs=EXCLUDED.prefs, updated_at=now()""",
            (str(member["id"]), cid, _json(doc)),
        )
        _audit(cur, cid, member, "project", changed)
        conn.commit()
        return _payload(cur, cid, member, request)


@app.delete("/api/containers/{cid}/notification-prefs")
def delete_notification_prefs(cid: str, request: Request, actor_agent_id: Optional[str] = None):
    """Drop this project's override — the project follows the defaults again."""
    with db_cursor() as (conn, cur):
        _check_cid(cur, cid)
        member = _acting_member(cur, request, cid, actor_agent_id)
        cur.execute("DELETE FROM notification_prefs WHERE member_agent_id=%s", (str(member["id"]),))
        _audit(cur, cid, member, "project", {"reset": True})
        conn.commit()
        return _payload(cur, cid, member, request)


@app.get("/api/containers/{cid}/notification-prefs/defaults")
def get_notification_pref_defaults(cid: str, request: Request, actor_agent_id: Optional[str] = None):
    """The acting person's defaults (every project without an override). Same payload
    as the project GET — `defaults` is the part this route's PUT edits."""
    return get_notification_prefs(cid, request, actor_agent_id)


@app.put("/api/containers/{cid}/notification-prefs/defaults")
def put_notification_pref_defaults(cid: str, body: DefaultPrefsBody, request: Request):
    """Change the person's defaults: rules, pause/snooze and quiet hours."""
    with db_cursor() as (conn, cur):
        _check_cid(cur, cid)
        member = _acting_member(cur, request, cid, body.actor_agent_id)
        sent = body.model_fields_set - {"actor_agent_id"}
        if not sent:
            raise HTTPException(422, "nothing to change — send rules, pause and/or quiet_hours")
        defaults_doc, _ = np.load_docs(cur, member)
        doc = dict(defaults_doc or {})
        changed = {}
        try:
            if "rules" in sent:
                doc["rules"] = np.validate_rules(body.rules or {}, require_complete=True)
                changed["rules"] = doc["rules"]
            if "pause" in sent:
                doc["pause"] = np.validate_pause(body.pause)
                changed["pause"] = doc["pause"]
            if "quiet_hours" in sent:
                doc["quiet_hours"] = np.validate_quiet_hours(body.quiet_hours)
                changed["quiet_hours"] = doc["quiet_hours"]
        except np.PrefsError as e:
            _422(e)
        cur.execute(
            """INSERT INTO notification_pref_defaults (identity_key, prefs, updated_at)
               VALUES (%s, %s, now())
               ON CONFLICT (identity_key)
               DO UPDATE SET prefs=EXCLUDED.prefs, updated_at=now()""",
            (np.identity_key(member), _json(doc)),
        )
        _audit(cur, cid, member, "defaults", changed)
        conn.commit()
        return _payload(cur, cid, member, request)


@app.post("/api/containers/{cid}/notification-prefs/check")
def check_notification_prefs(cid: str, body: CheckBody, request: Request):
    """Resolve should_notify for a batch of items on one channel — the desktop host
    calls this before showing an OS notification (it carries no identity of its own:
    the trust-off lane resolves the project's local operator).

    Items: {kind, ref_id?} — kinds are any taxonomy/outbox/desktop kind
    (task_plan, task_verify, request_answer, request_close, …). An open request that
    is ESCALATED is judged in the Escalations category."""
    if body.channel not in np.CHANNEL_KEYS:
        raise HTTPException(422, "channel must be one of: in_app, desktop, push, slack")
    with db_cursor() as (_, cur):
        _check_cid(cur, cid)
        member = _acting_member(cur, request, cid, body.actor_agent_id)
        prefs = np.effective_for_member(cur, member)
        decisions = []
        for it in body.items:
            kind = it.kind.strip().lower()
            ref_id = it.ref_id if it.ref_id and valid_uuid(it.ref_id) else None
            ref_kind = np.REF_KIND_BY_KIND.get(kind)
            eff_kind = kind
            if ref_kind == "request" and ref_id and kind == "request_answer":
                cur.execute("SELECT status FROM requests WHERE id=%s", (ref_id,))
                r = cur.fetchone()
                if r and r["status"] == "escalated":
                    eff_kind = "request_escalated"
            event = {
                "kind": eff_kind,
                "mine": np.is_mine(cur, member, kind, ref_id, ref_kind),
            }
            ok, reason = np.decide(prefs, event, body.channel)
            decisions.append({
                "kind": it.kind,
                "ref_id": it.ref_id,
                "category": np.category_for(eff_kind),
                "notify": ok,
                "reason": reason,
            })
    return {"channel": body.channel, "member_id": str(member["id"]), "decisions": decisions}


def _json(doc) -> str:
    return json.dumps(doc)
