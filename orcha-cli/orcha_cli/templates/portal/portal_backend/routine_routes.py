"""Routines — recurring scheduled work (idea adapted from Paperclip's "routines",
github.com/paperclipai/paperclip, MIT; no code copied).

A routine is a template (title, description, definition of done, optional assignee,
priority) plus a schedule (5-field cron on a local wall clock + IANA timezone). When a
slot comes due the scheduler creates a NORMAL task by calling the existing
POST /api/containers/{cid}/tasks handler (task_creation_routes.create_task) — so plan
approval, verification, autonomy and any budget gates apply exactly as for a
human-created task. Routines never bypass human authority:

  * only an owner or a member holding `manage_agents` may create / edit / delete / run
    one; viewers read (require_grant — the same two lanes as every management write);
  * the task is created AS the human who last saved the routine (or who clicked
    "Run now"); if that human is gone or became a viewer, the run fails and says so.

Scheduler placement: the host notifier daemon's wake tick calls
POST /api/containers/{cid}/routines/tick (see orcha_cli/notifier_routines.py). All
decisions and DB writes happen here, server-side ("only the API touches the DB"):

  * a slot fires at most once (row lock with SKIP LOCKED + a unique (routine, slot) index);
  * "skip if previous still open" records a `skipped` run instead of a second task;
  * missed slots while Orcha was down collapse into AT MOST ONE catch-up task whose
    description says how many runs were missed.

Every write is audited in `events` (entity_type='routine').
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container, valid_uuid
from portal_backend.identity_routes import require_grant, require_member_read
from portal_backend.limits import MAX_DESC_LEN, MAX_DOD_LEN, MAX_NAME_LEN
from portal_backend import routine_schedule as sched

UTC = timezone.utc
MANAGE_GRANT = "manage_agents"
# A slot fired later than this (scheduler down / stack stopped) is a catch-up run.
CATCH_UP_GRACE = timedelta(minutes=5)
# A run stuck in 'pending' this long was interrupted between claim and task creation.
PENDING_STALE = timedelta(minutes=10)
OPEN_TASK_TERMINAL = ("completed", "cancelled")
RUNS_LIMIT_DEFAULT = 25


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class RoutineCreate(BaseModel):
    actor_agent_id: Optional[str] = Field(
        default=None, description="Acting human (trust-off lane); the proxy identity wins when trusted")
    title: str = Field(..., min_length=1, max_length=MAX_NAME_LEN)
    description: Optional[str] = Field(default=None, max_length=MAX_DESC_LEN)
    definition_of_done: str = Field(..., min_length=1, max_length=MAX_DOD_LEN)
    assignee_agent_id: Optional[str] = Field(
        default=None, description="AI agent to assign each created task to; null = normal assignment")
    priority: int = Field(default=100, ge=0, le=100000)
    cron: str = Field(..., max_length=200, description="5-field cron on the routine's local wall clock")
    timezone: str = Field(default="UTC", max_length=64, description="IANA timezone, e.g. Africa/Nairobi")
    enabled: bool = True
    skip_if_open: bool = True
    origin_task_id: Optional[str] = Field(
        default=None,
        description="The task this routine was copied from (\"Make recurring…\"): provenance only — "
                    "the task itself is never changed. Must be a task of the same project.")


class RoutineRead(BaseModel):
    """Documentation model for a routine as the API returns it (the handlers return the
    serialized dict; this only describes its shape in /openapi.json)."""

    model_config = ConfigDict(extra="allow")

    id: str
    container_id: str
    title: str
    title_preview: Optional[str] = None
    description: Optional[str] = None
    definition_of_done: str
    assignee_agent_id: Optional[str] = None
    assignee_alias: Optional[str] = None
    priority: int
    cron: str
    timezone: str
    schedule_text: str
    enabled: bool
    skip_if_open: bool
    next_run_at: Optional[str] = None
    origin_task_id: Optional[str] = Field(
        default=None, description="The task this routine was created from, if any (\"Created from task #…\")")
    origin_task_title: Optional[str] = Field(
        default=None, description="That task's current title (null when there is no origin or it was removed)")


class RoutineList(BaseModel):
    """Documentation model for GET /api/containers/{cid}/routines."""

    model_config = ConfigDict(extra="allow")

    routines: list[RoutineRead]
    scheduler: dict


class RoutineUpdate(BaseModel):
    actor_agent_id: Optional[str] = None
    title: Optional[str] = Field(default=None, min_length=1, max_length=MAX_NAME_LEN)
    description: Optional[str] = Field(default=None, max_length=MAX_DESC_LEN)
    definition_of_done: Optional[str] = Field(default=None, min_length=1, max_length=MAX_DOD_LEN)
    assignee_agent_id: Optional[str] = None
    priority: Optional[int] = Field(default=None, ge=0, le=100000)
    cron: Optional[str] = Field(default=None, max_length=200)
    timezone: Optional[str] = Field(default=None, max_length=64)
    enabled: Optional[bool] = None
    skip_if_open: Optional[bool] = None


class RoutineActor(BaseModel):
    actor_agent_id: Optional[str] = None


class SchedulePreview(BaseModel):
    cron: str = Field(..., max_length=200)
    timezone: str = Field(default="UTC", max_length=64)
    count: int = Field(default=3, ge=1, le=10)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> datetime:
    return datetime.now(UTC)


def _iso(v):
    return v.isoformat() if isinstance(v, datetime) else v


def _require_uuid(value, what):
    if not valid_uuid(value):
        raise HTTPException(400, f"{what} is not a valid UUID")


def _validate_schedule(cron: str, tz: str):
    try:
        return sched.validate(cron, tz)
    except sched.ScheduleError as err:
        raise HTTPException(422, str(err)) from None


def _validate_assignee(cur, cid, assignee_id):
    if assignee_id is None:
        return None
    _require_uuid(assignee_id, "assignee_agent_id")
    cur.execute(
        "SELECT id, kind, terminated_at FROM agents WHERE id=%s AND container_id=%s",
        (assignee_id, cid),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, "assignee is not an agent of this project")
    if row["terminated_at"] is not None:
        raise HTTPException(409, "assignee is retired")
    if row["kind"] != "ai":
        raise HTTPException(422, "a routine's assignee must be an AI agent")
    return str(row["id"])


def _validate_origin_task(cur, cid, task_id):
    """"Make recurring…" provenance: the task must exist in THIS project. Read-only — the
    task is only referenced, never changed."""
    if task_id is None:
        return None
    _require_uuid(task_id, "origin_task_id")
    cur.execute("SELECT id, container_id FROM tasks WHERE id=%s", (task_id,))
    row = cur.fetchone()
    if not row or str(row["container_id"]) != cid:
        raise HTTPException(404, "origin task is not a task of this project")
    return str(row["id"])


_ROUTINE_SELECT = """
    SELECT r.*,
           asg.alias AS assignee_alias,
           asg.terminated_at AS assignee_terminated_at,
           cb.alias  AS created_by_alias,
           ub.alias  AS updated_by_alias,
           lr.id AS last_run_id, lr.outcome AS last_outcome, lr.trigger AS last_trigger,
           lr.detail AS last_detail, lr.created_at AS last_run_created_at,
           lr.task_id AS last_task_id, lr.missed_count AS last_missed_count,
           lt.status AS last_task_status, lt.title AS last_task_title,
           ot.title AS origin_task_title
      FROM routines r
      LEFT JOIN agents asg ON asg.id = r.assignee_agent_id
      LEFT JOIN agents cb  ON cb.id  = r.created_by_agent_id
      LEFT JOIN agents ub  ON ub.id  = r.updated_by_agent_id
      LEFT JOIN LATERAL (
            SELECT * FROM routine_runs rr WHERE rr.routine_id = r.id
             ORDER BY rr.created_at DESC LIMIT 1) lr ON true
      LEFT JOIN tasks lt ON lt.id = lr.task_id
      LEFT JOIN tasks ot ON ot.id = r.origin_task_id
"""


def _serialize(row) -> dict:
    last = None
    if row.get("last_run_id"):
        last = {
            "run_id": str(row["last_run_id"]),
            "outcome": row["last_outcome"],
            "trigger": row["last_trigger"],
            "detail": row["last_detail"],
            "created_at": _iso(row["last_run_created_at"]),
            "task_id": str(row["last_task_id"]) if row["last_task_id"] else None,
            "task_status": row["last_task_status"],
            "task_title": row["last_task_title"],
            "missed_count": row["last_missed_count"],
        }
    return {
        "id": str(row["id"]),
        "container_id": str(row["container_id"]),
        "title": row["title"],
        "title_preview": _title_preview(row),
        "description": row["description"],
        "definition_of_done": row["definition_of_done"],
        "assignee_agent_id": str(row["assignee_agent_id"]) if row["assignee_agent_id"] else None,
        "assignee_alias": row.get("assignee_alias"),
        "assignee_retired": row.get("assignee_terminated_at") is not None,
        "priority": row["priority"],
        "cron": row["cron"],
        "timezone": row["timezone"],
        "schedule_text": sched.describe(row["cron"], row["timezone"]),
        "enabled": row["enabled"],
        "skip_if_open": row["skip_if_open"],
        "next_run_at": _iso(row["next_run_at"]),
        "last_run_at": _iso(row["last_run_at"]),
        "created_by_agent_id": str(row["created_by_agent_id"]) if row["created_by_agent_id"] else None,
        "created_by_alias": row.get("created_by_alias"),
        "updated_by_agent_id": str(row["updated_by_agent_id"]) if row["updated_by_agent_id"] else None,
        "updated_by_alias": row.get("updated_by_alias"),
        "created_at": _iso(row["created_at"]),
        "updated_at": _iso(row["updated_at"]),
        "last_run": last,
        "origin_task_id": str(row["origin_task_id"]) if row.get("origin_task_id") else None,
        "origin_task_title": row.get("origin_task_title") if row.get("origin_task_id") else None,
    }


def _serialize_run(row) -> dict:
    return {
        "run_id": str(row["id"]),
        "routine_id": str(row["routine_id"]),
        "trigger": row["trigger"],
        "scheduled_for": _iso(row["scheduled_for"]),
        "missed_count": row["missed_count"],
        "outcome": row["outcome"],
        "task_id": str(row["task_id"]) if row["task_id"] else None,
        "task_title": row.get("task_title"),
        "task_status": row.get("task_status"),
        "detail": row["detail"],
        "actor_agent_id": str(row["actor_agent_id"]) if row["actor_agent_id"] else None,
        "actor_alias": row.get("actor_alias"),
        "created_at": _iso(row["created_at"]),
        "finished_at": _iso(row["finished_at"]),
    }


def _load_routine(cur, rid, *, lock=False):
    _require_uuid(rid, "routine_id")
    cur.execute(
        "SELECT * FROM routines WHERE id=%s AND archived_at IS NULL" + (" FOR UPDATE" if lock else ""),
        (rid,),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, f"routine {rid} not found")
    return row


def _fetch_serialized(cur, rid) -> dict:
    cur.execute(_ROUTINE_SELECT + " WHERE r.id=%s", (rid,))
    return _serialize(cur.fetchone())


def _scheduler_state(cur, cid) -> dict:
    cur.execute("SELECT last_tick_at FROM routine_scheduler_state WHERE container_id=%s", (cid,))
    row = cur.fetchone()
    return {"last_tick_at": _iso(row["last_tick_at"]) if row else None}


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------

@app.get("/api/containers/{cid}/routines", responses={200: {"model": RoutineList}})
def list_routines(
    cid: str,
    request: Request,
    origin_task_id: Optional[str] = Query(
        None, description="Only routines created from this task (the task's \"Recurring\" link)"),
):
    """Every live routine of the project (+ its latest run) and the scheduler's last check-in."""
    _require_uuid(cid, "container_id")
    if origin_task_id is not None:
        _require_uuid(origin_task_id, "origin_task_id")
    with db_cursor() as (_conn, cur):
        require_container(cur, cid)
        require_member_read(cur, request, cid)
        origin_clause = " AND r.origin_task_id=%s" if origin_task_id else ""
        cur.execute(
            _ROUTINE_SELECT + " WHERE r.container_id=%s AND r.archived_at IS NULL" + origin_clause +
            " ORDER BY r.enabled DESC, r.next_run_at ASC NULLS LAST, r.created_at ASC",
            (cid, origin_task_id) if origin_task_id else (cid,),
        )
        rows = cur.fetchall()
        return {"routines": [_serialize(r) for r in rows], "scheduler": _scheduler_state(cur, cid)}


@app.get("/api/routines/{rid}", responses={200: {"model": RoutineRead}})
def get_routine(rid: str, request: Request):
    with db_cursor() as (_conn, cur):
        row = _load_routine(cur, rid)
        require_member_read(cur, request, str(row["container_id"]))
        return _fetch_serialized(cur, rid)


@app.get("/api/routines/{rid}/runs")
def list_routine_runs(rid: str, request: Request, limit: int = Query(RUNS_LIMIT_DEFAULT, ge=1, le=200)):
    """Run history, newest first: which task each run created (and its status now), or why not."""
    with db_cursor() as (_conn, cur):
        row = _load_routine(cur, rid)
        require_member_read(cur, request, str(row["container_id"]))
        cur.execute(
            """SELECT rr.*, t.title AS task_title, t.status AS task_status, a.alias AS actor_alias
                 FROM routine_runs rr
                 LEFT JOIN tasks t ON t.id = rr.task_id
                 LEFT JOIN agents a ON a.id = rr.actor_agent_id
                WHERE rr.routine_id=%s
                ORDER BY rr.created_at DESC LIMIT %s""",
            (rid, limit),
        )
        return {"runs": [_serialize_run(r) for r in cur.fetchall()]}


@app.post("/api/containers/{cid}/routines/preview")
def preview_schedule(cid: str, body: SchedulePreview, request: Request):
    """Validate a schedule and describe it: plain English + the next few fire times.
    Read-only (the create/edit dialog calls it as the user types)."""
    _require_uuid(cid, "container_id")
    with db_cursor() as (_conn, cur):
        require_container(cur, cid)
        require_member_read(cur, request, cid)
    try:
        cron, tz = sched.validate(body.cron, body.timezone)
    except sched.ScheduleError as err:
        return {"valid": False, "error": str(err), "schedule_text": None, "next_runs": []}
    runs, cur_t = [], _now()
    for _ in range(body.count):
        cur_t = sched.next_after(cron, tz, cur_t)
        if cur_t is None:
            break
        runs.append(cur_t.isoformat())
    return {
        "valid": True,
        "error": None,
        "schedule_text": sched.describe(body.cron, body.timezone),
        "next_runs": runs,
    }


# ---------------------------------------------------------------------------
# Writes (owner / manage_agents; viewers refused)
# ---------------------------------------------------------------------------

@app.post("/api/containers/{cid}/routines", status_code=201, responses={201: {"model": RoutineRead}})
def create_routine(cid: str, body: RoutineCreate, request: Request):
    _require_uuid(cid, "container_id")
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        member = require_grant(cur, request, cid, body.actor_agent_id, MANAGE_GRANT)
        actor = str(member["id"])
        cron, tz = _validate_schedule(body.cron, body.timezone)
        assignee = _validate_assignee(cur, cid, body.assignee_agent_id)
        origin = _validate_origin_task(cur, cid, body.origin_task_id)
        next_run = sched.next_after(cron, tz, _now()) if body.enabled else None
        cur.execute(
            """INSERT INTO routines
                 (container_id, title, description, definition_of_done, assignee_agent_id,
                  priority, cron, timezone, enabled, skip_if_open, next_run_at,
                  created_by_agent_id, updated_by_agent_id, origin_task_id)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
            (cid, body.title.strip(), body.description, body.definition_of_done, assignee,
             body.priority, cron.expr, body.timezone, body.enabled, body.skip_if_open,
             next_run, actor, actor, origin),
        )
        rid = str(cur.fetchone()["id"])
        log_event(cur, cid, "human", actor, "routine", rid, "routine_created", {
            "title": body.title, "cron": cron.expr, "timezone": body.timezone,
            "enabled": body.enabled, "assignee_agent_id": assignee,
            **({"origin_task_id": origin} if origin else {}),
        })
        conn.commit()
        return _fetch_serialized(cur, rid)


@app.patch("/api/routines/{rid}", responses={200: {"model": RoutineRead}})
def update_routine(rid: str, body: RoutineUpdate, request: Request):
    """Partial update. Saving makes the saver the human future tasks are created as.
    A schedule/timezone change or (re-)enable recomputes the next run from NOW — time spent
    disabled is never caught up."""
    fields = body.model_dump(exclude_unset=True)
    fields.pop("actor_agent_id", None)
    with db_cursor() as (conn, cur):
        row = _load_routine(cur, rid, lock=True)
        cid = str(row["container_id"])
        member = require_grant(cur, request, cid, body.actor_agent_id, MANAGE_GRANT)
        actor = str(member["id"])
        for required in ("title", "definition_of_done", "cron", "timezone", "enabled", "skip_if_open", "priority"):
            if required in fields and fields[required] is None:
                raise HTTPException(422, f"{required} cannot be null")
        if "assignee_agent_id" in fields:
            fields["assignee_agent_id"] = _validate_assignee(cur, cid, fields["assignee_agent_id"])
        cron_expr = fields.get("cron", row["cron"])
        tz_name = fields.get("timezone", row["timezone"])
        enabled = fields.get("enabled", row["enabled"])
        schedule_changed = "cron" in fields or "timezone" in fields
        if schedule_changed or enabled:
            cron, tz = _validate_schedule(cron_expr, tz_name)
            fields["cron"] = cron.expr
        if not enabled:
            fields["next_run_at"] = None
        elif schedule_changed or not row["enabled"] or row["next_run_at"] is None:
            fields["next_run_at"] = sched.next_after(cron, tz, _now())
        if "title" in fields:
            fields["title"] = fields["title"].strip()
        def _cur(k):
            v = row.get(k)
            return str(v) if k.endswith("_id") and v is not None else v
        changed = {k: v for k, v in fields.items() if k != "next_run_at" and _cur(k) != v}
        fields["updated_by_agent_id"] = actor
        sets = ", ".join(f"{k}=%s" for k in fields) + ", updated_at=now()"
        cur.execute(f"UPDATE routines SET {sets} WHERE id=%s", (*fields.values(), rid))
        action = "routine_updated"
        if set(changed) == {"enabled"}:
            action = "routine_enabled" if enabled else "routine_disabled"
        log_event(cur, cid, "human", actor, "routine", rid, action, {
            "changed": sorted(changed),
            **({"cron": cron_expr, "timezone": tz_name} if schedule_changed else {}),
        })
        conn.commit()
        return _fetch_serialized(cur, rid)


@app.delete("/api/routines/{rid}")
def delete_routine(rid: str, request: Request, actor_agent_id: Optional[str] = Query(None)):
    """Remove a routine from the project. Its run history (and every task it created) is kept."""
    with db_cursor() as (conn, cur):
        row = _load_routine(cur, rid, lock=True)
        cid = str(row["container_id"])
        member = require_grant(cur, request, cid, actor_agent_id, MANAGE_GRANT)
        actor = str(member["id"])
        cur.execute(
            "UPDATE routines SET archived_at=now(), enabled=false, next_run_at=NULL, "
            "updated_by_agent_id=%s, updated_at=now() WHERE id=%s",
            (actor, rid),
        )
        log_event(cur, cid, "human", actor, "routine", rid, "routine_deleted", {"title": row["title"]})
        conn.commit()
    return {"deleted": True, "routine_id": rid}


@app.post("/api/routines/{rid}/run")
def run_routine_now(rid: str, body: RoutineActor, request: Request):
    """Create this routine's task right now, as the clicking human. Doesn't move the schedule.
    Works on a disabled routine (e.g. to try it out) and does not apply skip-if-open — a
    human explicitly asked for it."""
    with db_cursor() as (conn, cur):
        row = _load_routine(cur, rid)
        cid = str(row["container_id"])
        member = require_grant(cur, request, cid, body.actor_agent_id, MANAGE_GRANT)
        actor = str(member["id"])
        cur.execute(
            """INSERT INTO routine_runs (routine_id, container_id, trigger, outcome, actor_agent_id)
               VALUES (%s, %s, 'manual', 'pending', %s) RETURNING id""",
            (rid, cid, actor),
        )
        run_id = str(cur.fetchone()["id"])
        log_event(cur, cid, "human", actor, "routine", rid, "routine_run_requested", {"run_id": run_id})
        conn.commit()
    result = _execute_run(row, run_id, actor_id=actor, trigger="manual", slots=[], now=_now(),
                          actor_alias=member.get("alias"))
    if result["outcome"] == "failed":
        raise HTTPException(result.get("status_code") or 409, result["detail"])
    return result


# ---------------------------------------------------------------------------
# Scheduler
# ---------------------------------------------------------------------------

@app.post("/api/containers/{cid}/routines/tick")
def routines_tick(cid: str, request: Request):
    """One scheduler pass for this project: fire every due routine. Idempotent and safe to
    call concurrently (called by the notifier daemon each wake tick; the schedule alone
    decides what fires, so the caller's identity grants nothing)."""
    _require_uuid(cid, "container_id")
    with db_cursor() as (_conn, cur):
        require_container(cur, cid)
        require_member_read(cur, request, cid)
    return run_due_routines(cid)


def run_due_routines(cid: str, now: Optional[datetime] = None) -> dict:
    """Fire every due routine of a container (the testable core of the tick)."""
    now = now or _now()
    with db_cursor() as (conn, cur):
        cont = require_container(cur, cid)
        cur.execute(
            """INSERT INTO routine_scheduler_state (container_id, last_tick_at) VALUES (%s, %s)
               ON CONFLICT (container_id) DO UPDATE SET last_tick_at = EXCLUDED.last_tick_at""",
            (cid, now),
        )
        cur.execute(
            """UPDATE routine_runs SET outcome='failed', finished_at=%s,
                      detail='Interrupted: the scheduler stopped before the task was created. '
                             'Check Tasks before running it again.'
                WHERE container_id=%s AND outcome='pending' AND created_at < %s""",
            (now, cid, now - PENDING_STALE),
        )
        conn.commit()
    if cont["status"] != "active":
        # Paused/stopped project: nothing fires; due routines stay due and collapse into one
        # catch-up task when the project is active again.
        return {"ok": True, "suppressed": cont["status"], "fired": []}
    fired = []
    while True:
        claim = _claim_next_due(cid, now)
        if claim is None:
            break
        if claim.get("run_id") and claim["outcome"] == "pending":
            fired.append(_execute_run(claim["routine"], claim["run_id"], actor_id=claim["actor_id"],
                                      trigger=claim["trigger"], slots=claim["slots"], now=now))
        else:
            fired.append({k: v for k, v in claim.items() if k not in ("routine", "slots", "actor_id")})
    return {"ok": True, "fired": fired}


def _author_problem(cur, cid, author_id) -> Optional[str]:
    """Why the routine's human can't create tasks any more (None when they can)."""
    if not author_id:
        return ("The human who set up this routine is no longer a member — "
                "edit and save it to create its tasks as you.")
    cur.execute(
        "SELECT kind, terminated_at, member_role, container_id FROM agents WHERE id=%s",
        (author_id,),
    )
    a = cur.fetchone()
    if not a or str(a["container_id"]) != cid or a["terminated_at"] is not None or a["kind"] != "human":
        return ("The human who set up this routine is no longer a member — "
                "edit and save it to create its tasks as you.")
    if a["member_role"] == "viewer":
        return ("The human who last saved this routine is now a viewer and can't create tasks — "
                "a member must edit and save it.")
    return None


def _open_previous_task(cur, rid):
    """The previous run's task if it is still open (or a run is still in flight)."""
    cur.execute(
        """SELECT rr.outcome, rr.task_id, t.status, t.title
             FROM routine_runs rr LEFT JOIN tasks t ON t.id = rr.task_id
            WHERE rr.routine_id=%s AND (rr.outcome='pending' OR
                  (rr.outcome='created' AND rr.task_id IS NOT NULL))
            ORDER BY rr.created_at DESC LIMIT 1""",
        (rid,),
    )
    prev = cur.fetchone()
    if not prev:
        return None
    if prev["outcome"] == "pending":
        return prev
    if prev["status"] is not None and prev["status"] not in OPEN_TASK_TERMINAL:
        return prev
    return None


def _claim_next_due(cid: str, now: datetime) -> Optional[dict]:
    """Lock ONE due routine, decide its run, record it and advance the schedule — one tx.
    Returns None when nothing (unlocked) is due."""
    with db_cursor() as (conn, cur):
        cur.execute(
            """SELECT * FROM routines
                WHERE container_id=%s AND enabled AND archived_at IS NULL
                  AND next_run_at IS NOT NULL AND next_run_at <= %s
                ORDER BY next_run_at ASC LIMIT 1
                FOR UPDATE SKIP LOCKED""",
            (cid, now),
        )
        r = cur.fetchone()
        if not r:
            return None
        rid = str(r["id"])
        try:
            cron = sched.parse_cron(r["cron"])
            tz = sched.load_zone(r["timezone"])
        except sched.ScheduleError as err:
            cur.execute("UPDATE routines SET next_run_at=NULL, updated_at=now() WHERE id=%s", (rid,))
            cur.execute(
                """INSERT INTO routine_runs (routine_id, container_id, trigger, scheduled_for, outcome,
                                             detail, finished_at)
                   VALUES (%s,%s,'schedule',%s,'failed',%s,%s)
                   ON CONFLICT (routine_id, scheduled_for) WHERE scheduled_for IS NOT NULL DO NOTHING""",
                (rid, cid, r["next_run_at"], f"Schedule can no longer be evaluated: {err}", now),
            )
            conn.commit()
            return {"routine_id": rid, "outcome": "failed", "detail": str(err)}

        slots = sched.occurrences(cron, tz, r["next_run_at"], now) or [r["next_run_at"]]
        missed = len(slots)
        late = now - slots[0]
        trigger = "catch_up" if (missed > 1 or late > CATCH_UP_GRACE) else "schedule"
        slot = slots[-1]
        next_run = sched.next_after(cron, tz, now)
        actor = str(r["updated_by_agent_id"] or r["created_by_agent_id"] or "") or None

        outcome, detail = "pending", None
        problem = _author_problem(cur, cid, actor)
        if problem:
            outcome, detail = "failed", problem
        elif r["skip_if_open"]:
            prev = _open_previous_task(cur, rid)
            if prev is not None:
                outcome = "skipped"
                detail = ("Skipped: the previous run is still being created."
                          if prev["outcome"] == "pending" else
                          f"Skipped: the previous task “{prev['title']}” is still {prev['status'].replace('_', ' ')}.")
                if trigger == "catch_up":
                    detail += f" ({missed} scheduled run{'s' if missed != 1 else ''} came due while Embodent was down.)"

        cur.execute(
            """INSERT INTO routine_runs (routine_id, container_id, trigger, scheduled_for, missed_count,
                                         outcome, detail, actor_agent_id, finished_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (routine_id, scheduled_for) WHERE scheduled_for IS NOT NULL DO NOTHING
               RETURNING id""",
            (rid, cid, trigger, slot, missed if trigger == "catch_up" else 0, outcome, detail, actor,
             None if outcome == "pending" else now),
        )
        ins = cur.fetchone()
        cur.execute(
            "UPDATE routines SET next_run_at=%s, last_run_at=%s WHERE id=%s",
            (next_run, now, rid),
        )
        if ins is None:
            # Slot already recorded (a concurrent pass fired it): just advance.
            conn.commit()
            return {"routine_id": rid, "outcome": "duplicate", "detail": "slot already fired"}
        run_id = str(ins["id"])
        if outcome != "pending":
            log_event(cur, cid, "system", None, "routine", rid, f"routine_{outcome}",
                      {"run_id": run_id, "trigger": trigger, "detail": detail})
        conn.commit()
        return {"routine_id": rid, "run_id": run_id, "outcome": outcome, "detail": detail,
                "trigger": trigger, "routine": r, "slots": slots, "actor_id": actor}


def _render(template: Optional[str], ctx: dict) -> Optional[str]:
    if template is None:
        return None
    out = template
    for key, val in ctx.items():
        out = out.replace("{{" + key + "}}", val).replace("{{ " + key + " }}", val)
    return out


def _local(dt: datetime, tz_name: str) -> datetime:
    try:
        return dt.astimezone(sched.load_zone(tz_name))
    except sched.ScheduleError:
        return dt


def _fmt_local(dt: datetime, tz_name: str) -> str:
    loc = _local(dt, tz_name)
    return loc.strftime("%a %d %b %Y %H:%M") + " " + sched.zone_label(tz_name)


def _template_ctx(r, at_utc: datetime) -> dict:
    """The {{token}} values a routine's texts render with for a run at `at_utc` (in the
    routine's own timezone). Shared by the run path and the list's title_preview so the
    preview is exactly what the next task will be called."""
    at = _local(at_utc, r["timezone"])
    return {
        "date": at.strftime("%Y-%m-%d"),
        "time": at.strftime("%H:%M"),
        "weekday": at.strftime("%A"),
        "routine": r["title"],
    }


def _title_preview(r) -> str:
    """KG-2 / R14: the routine's title as its NEXT task will read (tokens resolved at
    next_run_at, else now) — the list, inspector and dialogs show this, never the raw
    '{{date}}' template."""
    at = r.get("next_run_at") or _now()
    return (_render(r["title"], _template_ctx(r, at)) or r["title"])[:MAX_NAME_LEN]


def _task_texts(r, *, trigger, slots, now, actor_alias=None):
    """Rendered (title, description, dod) for one run, with the routine back-link trailer."""
    tz_name = r["timezone"]
    ctx = _template_ctx(r, slots[-1] if slots else now)
    title = (_render(r["title"], ctx) or r["title"])[:MAX_NAME_LEN]
    dod = (_render(r["definition_of_done"], ctx) or "")[:MAX_DOD_LEN]
    body = _render(r["description"], ctx) or ""
    schedule_text = sched.describe(r["cron"], tz_name)
    if trigger == "manual":
        trailer = f"Created by routine “{title}” ({schedule_text}) — run manually" + (
            f" by {actor_alias}." if actor_alias else ".")
    elif trigger == "catch_up":
        n = len(slots)
        span = (f"due {_fmt_local(slots[0], tz_name)}" if n == 1 else
                f"first due {_fmt_local(slots[0], tz_name)}, last due {_fmt_local(slots[-1], tz_name)}")
        trailer = (
            f"Created by routine “{title}” ({schedule_text}). Catch-up run: "
            f"{n} scheduled run{'s were' if n != 1 else ' was'} missed while Embodent's scheduler "
            f"wasn't running ({span}). Embodent creates at most one catch-up task, so this one "
            "task covers them."
        )
    else:
        trailer = (f"Created by routine “{title}” ({schedule_text}), "
                   f"scheduled for {_fmt_local(slots[-1], tz_name)}.")
    sep = "\n\n---\n" if body else ""
    room = MAX_DESC_LEN - len(sep) - len(trailer)
    description = (body[:max(room, 0)] + sep + trailer) if body else trailer
    return title, description[:MAX_DESC_LEN], dod


def _internal_request() -> Request:
    """A header-less request: the task-creation handler's trusted_actor then keeps the
    routine's (already authorized) human as the creator instead of any caller identity."""
    return Request({"type": "http", "method": "POST", "path": "/", "headers": [], "query_string": b""})


def _execute_run(r, run_id, *, actor_id, trigger, slots, now, actor_alias=None) -> dict:
    """Create the task through the normal task-creation handler, then finish the run row."""
    from portal_backend import task_creation_routes
    from portal_backend.schemas import TaskCreateBody

    rid, cid = str(r["id"]), str(r["container_id"])
    notes = []
    assignee_alias = None
    with db_cursor() as (_conn, cur):
        if r["assignee_agent_id"]:
            cur.execute("SELECT alias, terminated_at FROM agents WHERE id=%s", (r["assignee_agent_id"],))
            a = cur.fetchone()
            if a and a["terminated_at"] is None:
                assignee_alias = a["alias"]
            else:
                notes.append("The routine's assignee is retired — the task was left unassigned.")
        if actor_alias is None and actor_id:
            cur.execute("SELECT alias FROM agents WHERE id=%s", (actor_id,))
            got = cur.fetchone()
            actor_alias = got["alias"] if got else None
    title, description, dod = _task_texts(r, trigger=trigger, slots=slots, now=now, actor_alias=actor_alias)
    outcome, task_id, status_code = "created", None, None
    try:
        created = task_creation_routes.create_task(
            cid,
            TaskCreateBody(
                title=title, description=description, definition_of_done=dod,
                priority=r["priority"], created_by_agent_id=actor_id, assignee_alias=assignee_alias,
            ),
            _internal_request(),
        )
        task_id = str(created["task_id"])
        detail = " ".join(notes) or None
    except HTTPException as err:
        outcome, status_code = "failed", err.status_code
        detail = f"Task creation was refused: {err.detail}"
    except Exception as err:  # noqa: BLE001 - record the failure; never crash the tick
        outcome, status_code = "failed", 500
        detail = f"Task creation failed: {type(err).__name__}: {err}"
    with db_cursor() as (conn, cur):
        cur.execute(
            "UPDATE routine_runs SET outcome=%s, task_id=%s, detail=%s, finished_at=%s WHERE id=%s",
            (outcome, task_id, detail, _now(), run_id),
        )
        if trigger == "manual":
            cur.execute("UPDATE routines SET last_run_at=%s WHERE id=%s", (now, rid))
        log_event(cur, cid, "system" if trigger != "manual" else "human",
                  None if trigger != "manual" else actor_id, "routine", rid,
                  "routine_task_created" if outcome == "created" else "routine_failed",
                  {"run_id": run_id, "trigger": trigger, "task_id": task_id, "detail": detail,
                   **({"missed_count": len(slots)} if trigger == "catch_up" else {})})
        conn.commit()
    result = {"routine_id": rid, "run_id": run_id, "outcome": outcome, "trigger": trigger,
              "task_id": task_id, "detail": detail}
    if status_code:
        result["status_code"] = status_code
    return result
