"""Agent worktree clean-up (mig 067) — Settings › Agent worktrees.

Worktrees live on the host, so the portal only keeps the settings, the latest inventory the
host notifier reported, and the requests people make; the notifier
(orcha_cli/notifier_worktree_gc.py, worktree_gc.py) classifies, saves output and removes.

Browser (read = any member; writes = a human owner or manage_autonomy, like the other
execution controls):
  GET  /api/containers/{cid}/agent-worktrees                 settings + inventory + recent requests
  PUT  /api/containers/{cid}/agent-worktrees/settings        auto clean-up on/off, grace days
  POST /api/containers/{cid}/agent-worktrees/actions         remove / save_output / clean_up / refresh
  GET  /api/containers/{cid}/agent-worktrees/actions/{aid}   one request (poll until done)

Notifier (the machine lane: header-less daemon passes; a trusted human needs manage_repo):
  POST /api/containers/{cid}/agent-worktrees/claim           settings, busy worktrees, pending requests
  POST /api/agent-worktrees/actions/{aid}/result             a request's outcome
  POST /api/containers/{cid}/agent-worktrees/inventory       the host's current inventory
  POST /api/containers/{cid}/agent-worktrees/context         task / run facts for worktree paths
  POST /api/containers/{cid}/agent-worktrees/events          log one removal as a project event
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Literal, Optional

from fastapi import HTTPException, Request
from pydantic import BaseModel, Field

from portal_backend import sql
from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container, require_kind, valid_uuid
from portal_backend.identity_routes import (
    enforce_grant,
    require_machine_lane_member,
    require_member_read,
    trusted_actor,
)

SETTINGS_GRANT = "manage_autonomy"
LANE_GRANT = "manage_repo"
STATES = ("clean", "has-output", "unmerged", "in-use", "not-quorate")
CLAIM_STALE_AFTER = timedelta(minutes=15)
MAX_ITEMS = 500


# ------------------------------------------------------------------ models

class WorktreeSettings(BaseModel):
    auto_cleanup: bool = Field(description="Remove clean agent worktrees automatically, and ones "
                                           "with output after the grace period (output is saved first)")
    grace_days: int = Field(ge=0, le=90, description="Days a worktree with output is kept after its "
                                                     "task is completed or cancelled")


class WorktreeSettingsUpdate(BaseModel):
    auto_cleanup: Optional[bool] = Field(default=None, description="Omit to keep the current value")
    grace_days: Optional[int] = Field(default=None, ge=0, le=90, description="Omit to keep the current value")
    actor_agent_id: Optional[str] = Field(default=None, description="The human making the change")


class WorktreeActionCreate(BaseModel):
    action: Literal["remove", "save_output", "clean_up", "refresh"] = Field(
        description="remove one worktree, save one worktree's output to its task, clean up every "
                    "eligible worktree, or ask the host for a fresh inventory")
    path: Optional[str] = Field(default=None, max_length=4096,
                                description="The worktree (remove / save_output) — from the inventory")
    keep_branch: bool = Field(default=False, description="remove: keep the git branch")
    confirm_branch: Optional[str] = Field(
        default=None, max_length=300,
        description="remove of a worktree with unmerged commits: the branch name, typed to confirm")
    include_output: bool = Field(default=True, description="clean_up: also remove worktrees with "
                                                           "output (after saving it)")
    unmerged_paths: list[str] = Field(default_factory=list, max_length=MAX_ITEMS,
                                      description="clean_up: unmerged worktrees to remove anyway — "
                                                  "their branches are kept")
    actor_agent_id: Optional[str] = Field(default=None, description="The human asking")


class WorktreeClaimBody(BaseModel):
    claimed_by: Optional[str] = Field(default=None, max_length=200)
    peek: bool = Field(default=False, description="Only read settings / busy worktrees; claim nothing")


class WorktreeActionResult(BaseModel):
    status: Literal["done", "failed"]
    result: Optional[dict[str, Any]] = None
    error: Optional[str] = Field(default=None, max_length=2000)


class WorktreeInventoryReport(BaseModel):
    host: Optional[str] = Field(default=None, max_length=300)
    base_cwd: Optional[str] = Field(default=None, max_length=4096)
    items: list[dict[str, Any]] = Field(default_factory=list, max_length=MAX_ITEMS)


class WorktreeContextBody(BaseModel):
    paths: list[str] = Field(default_factory=list, max_length=MAX_ITEMS)
    task_refs: dict[str, str] = Field(default_factory=dict,
                                      description="path → the task id prefix in its branch name")


class WorktreeEventBody(BaseModel):
    kind: Literal["removed", "kept"]
    trigger: str = Field(max_length=40, description="after_run | sweep | manual | cli")
    path: Optional[str] = Field(default=None, max_length=4096)
    branch: Optional[str] = Field(default=None, max_length=300)
    state: Optional[str] = Field(default=None, max_length=40)
    reason: Optional[str] = Field(default=None, max_length=500)
    freed_bytes: int = Field(default=0, ge=0)
    branch_deleted: bool = False
    attached: int = Field(default=0, ge=0)
    saved: int = Field(default=0, ge=0)
    saved_to: Optional[str] = Field(default=None, max_length=4096)


# ------------------------------------------------------------------ helpers

def _cid(cid: str) -> str:
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    return cid


def _iso(v):
    return v.isoformat() if isinstance(v, datetime) else v


def _settings(cur, cid) -> dict:
    cur.execute("SELECT worktree_auto_cleanup, worktree_grace_days FROM containers WHERE id=%s", (cid,))
    row = cur.fetchone()
    return {"auto_cleanup": bool(row["worktree_auto_cleanup"]), "grace_days": int(row["worktree_grace_days"])}


def _action_out(row) -> dict:
    r = dict(row)
    return {"id": str(r["id"]), "action": r["action"], "path": r.get("path"), "branch": r.get("branch"),
            "keep_branch": r["keep_branch"], "confirm_unmerged": r["confirm_unmerged"],
            "include_output": r["include_output"], "unmerged_paths": r.get("unmerged_paths") or [],
            "status": r["status"], "result": r.get("result"), "error": r.get("error"),
            "requested_by": str(r["requested_by"]) if r.get("requested_by") else None,
            "claimed_by": r.get("claimed_by"), "created_at": _iso(r["created_at"]),
            "claimed_at": _iso(r.get("claimed_at")), "finished_at": _iso(r.get("finished_at"))}


def _inventory(cur, cid) -> Optional[dict]:
    cur.execute("SELECT * FROM agent_worktree_inventory WHERE container_id=%s", (cid,))
    row = cur.fetchone()
    if not row:
        return None
    items = list(row["items"] or [])
    counts = {s: 0 for s in STATES}
    for it in items:
        if it.get("state") in counts:
            counts[it["state"]] += 1
    reclaimable = sum(int(it.get("size_bytes") or 0) for it in items
                      if it.get("state") in ("clean", "has-output"))
    return {"host": row["host"], "base_cwd": row["base_cwd"], "scanned_at": _iso(row["scanned_at"]),
            "items": items, "counts": counts, "reclaimable_bytes": reclaimable,
            "total_bytes": sum(int(it.get("size_bytes") or 0) for it in items)}


def _human_actor(cur, request, cid, actor):
    member = enforce_grant(cur, request, cid, SETTINGS_GRANT)
    actor = trusted_actor(cur, request, cid, actor)
    require_kind(cur, actor, ("human",))
    return actor, member


# ------------------------------------------------------------------ browser

@app.get("/api/containers/{cid}/agent-worktrees")
def get_agent_worktrees(cid: str, request: Request):
    """Settings, the latest inventory the host notifier reported (null until it has), and the
    20 most recent clean-up requests."""
    _cid(cid)
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        require_member_read(cur, request, cid)
        settings = _settings(cur, cid)
        inventory = _inventory(cur, cid)
        cur.execute("SELECT * FROM agent_worktree_actions WHERE container_id=%s "
                    "ORDER BY created_at DESC LIMIT 20", (cid,))
        actions = [_action_out(r) for r in cur.fetchall()]
    return {"container_id": cid, "settings": settings, "inventory": inventory, "actions": actions}


@app.put("/api/containers/{cid}/agent-worktrees/settings", response_model=WorktreeSettings)
def put_agent_worktree_settings(cid: str, body: WorktreeSettingsUpdate, request: Request):
    """Turn automatic clean-up on/off and set the grace period (owner or manage_autonomy)."""
    _cid(cid)
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        actor, _ = _human_actor(cur, request, cid, body.actor_agent_id)
        before = _settings(cur, cid)
        after = {"auto_cleanup": before["auto_cleanup"] if body.auto_cleanup is None else body.auto_cleanup,
                 "grace_days": before["grace_days"] if body.grace_days is None else body.grace_days}
        cur.execute("UPDATE containers SET worktree_auto_cleanup=%s, worktree_grace_days=%s WHERE id=%s",
                    (after["auto_cleanup"], after["grace_days"], cid))
        if after != before:
            log_event(cur, cid, "human", actor, "container", cid, "agent_worktree_settings_changed",
                      {"before": before, "after": after})
        conn.commit()
    return after


@app.post("/api/containers/{cid}/agent-worktrees/actions", status_code=201)
def create_agent_worktree_action(cid: str, body: WorktreeActionCreate, request: Request):
    """Ask the host notifier to remove a worktree, save its output to its task, clean up every
    eligible worktree, or refresh the inventory. A worktree with unmerged commits is only
    removed when its branch name is typed into ``confirm_branch``; one in use never is."""
    _cid(cid)
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        actor, _ = _human_actor(cur, request, cid, body.actor_agent_id)
        inv = _inventory(cur, cid) or {"items": []}
        by_path = {it.get("path"): it for it in inv["items"]}
        branch = None
        confirm_unmerged = False
        if body.action in ("remove", "save_output"):
            item = by_path.get(body.path or "")
            if not item:
                raise HTTPException(404, "that worktree isn't in the latest inventory — refresh first")
            branch = item.get("branch")
            state = item.get("state")
            if state in ("in-use", "not-quorate"):
                raise HTTPException(409, f"that worktree is {state} — it can't be changed from here")
            if body.action == "remove" and state == "unmerged":
                if (body.confirm_branch or "").strip() != (branch or ""):
                    raise HTTPException(400, "it has unmerged commits — type the branch name "
                                             f"({branch}) to confirm")
                confirm_unmerged = True
            if body.action == "save_output" and state != "has-output":
                raise HTTPException(409, "that worktree has no output to save")
        unmerged = []
        if body.action == "clean_up":
            for p in body.unmerged_paths:
                it = by_path.get(p)
                if not it or it.get("state") != "unmerged":
                    raise HTTPException(400, f"{p} isn't an unmerged worktree in the inventory")
                unmerged.append(p)
        cur.execute("SELECT 1 FROM agent_worktree_actions WHERE container_id=%s AND status IN "
                    "('requested','claimed') AND action=%s AND path IS NOT DISTINCT FROM %s",
                    (cid, body.action, body.path if body.action in ("remove", "save_output") else None))
        if cur.fetchone():
            raise HTTPException(409, "the same request is already waiting for the notifier")
        cur.execute(
            """INSERT INTO agent_worktree_actions
                 (container_id, action, path, branch, keep_branch, confirm_unmerged, include_output,
                  unmerged_paths, requested_by)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
            (cid, body.action, body.path if body.action in ("remove", "save_output") else None, branch,
             body.keep_branch, confirm_unmerged, body.include_output, sql.json_param(unmerged), actor))
        row = cur.fetchone()
        log_event(cur, cid, "human", actor, "container", cid, "agent_worktree_action_requested",
                  {"action": body.action, "path": body.path, "branch": branch,
                   "keep_branch": body.keep_branch, "unmerged_paths": unmerged})
        conn.commit()
    return _action_out(row)


@app.get("/api/containers/{cid}/agent-worktrees/actions/{aid}")
def get_agent_worktree_action(cid: str, aid: str, request: Request):
    """One request and, once the notifier finished it, its result."""
    _cid(cid)
    if not valid_uuid(aid):
        raise HTTPException(400, "action id is not a valid UUID")
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        require_member_read(cur, request, cid)
        cur.execute("SELECT * FROM agent_worktree_actions WHERE id=%s AND container_id=%s", (aid, cid))
        row = cur.fetchone()
    if not row:
        raise HTTPException(404, "request not found")
    return _action_out(row)


# ------------------------------------------------------------------ notifier lane

def _busy_worktrees(cur, cid) -> list[str]:
    cur.execute(
        """SELECT DISTINCT wr.worktree FROM worker_runs wr JOIN agents a ON a.id = wr.agent_id
            WHERE a.container_id=%s AND wr.status='running' AND wr.worktree IS NOT NULL""", (cid,))
    busy = [r["worktree"] for r in cur.fetchall()]
    cur.execute("""SELECT DISTINCT worktree FROM verdikt_previews WHERE container_id=%s
                    AND status IN ('requested','starting','ready') AND worktree IS NOT NULL""", (cid,))
    busy += [r["worktree"] for r in cur.fetchall()]
    return sorted(set(busy))


@app.post("/api/containers/{cid}/agent-worktrees/claim")
def claim_agent_worktree_actions(cid: str, body: WorktreeClaimBody, request: Request):
    """→ {settings, busy_worktrees, actions}: claims every waiting request (unless ``peek``).
    A request a notifier claimed but never finished is failed after 15 minutes."""
    _cid(cid)
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        require_machine_lane_member(cur, request, cid, LANE_GRANT)
        now = datetime.now(timezone.utc)
        cur.execute("""UPDATE agent_worktree_actions SET status='failed', finished_at=%s,
                         error='the notifier stopped before finishing this — try again'
                        WHERE container_id=%s AND status='claimed' AND claimed_at < %s""",
                    (now, cid, now - CLAIM_STALE_AFTER))
        actions = []
        if not body.peek:
            cur.execute(
                """UPDATE agent_worktree_actions SET status='claimed', claimed_at=%s, claimed_by=%s
                    WHERE id IN (SELECT id FROM agent_worktree_actions
                                  WHERE container_id=%s AND status='requested'
                                  ORDER BY created_at ASC LIMIT 20"""
                + sql.for_update(skip_locked=True) + """)
                    RETURNING *""",
                (now, (body.claimed_by or "notifier")[:200], cid))
            actions = sorted((_action_out(r) for r in cur.fetchall()), key=lambda a: a["created_at"])
        out = {"settings": _settings(cur, cid), "busy_worktrees": _busy_worktrees(cur, cid),
               "actions": actions}
        conn.commit()
    return out


@app.post("/api/agent-worktrees/actions/{aid}/result")
def finish_agent_worktree_action(aid: str, body: WorktreeActionResult, request: Request):
    """The notifier reports what happened to one request."""
    if not valid_uuid(aid):
        raise HTTPException(400, "action id is not a valid UUID")
    with db_cursor() as (conn, cur):
        cur.execute("SELECT * FROM agent_worktree_actions WHERE id=%s " + sql.for_update(), (aid,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "request not found")
        cid = str(row["container_id"])
        require_machine_lane_member(cur, request, cid, LANE_GRANT)
        if row["status"] in ("done", "failed"):
            conn.commit()
            return _action_out(row)
        cur.execute("""UPDATE agent_worktree_actions SET status=%s, result=%s, error=%s, finished_at=now()
                        WHERE id=%s RETURNING *""",
                    (body.status, sql.json_param(body.result) if body.result is not None else None,
                     body.error, aid))
        row = cur.fetchone()
        conn.commit()
    return _action_out(row)


@app.post("/api/containers/{cid}/agent-worktrees/inventory")
def report_agent_worktree_inventory(cid: str, body: WorktreeInventoryReport, request: Request):
    """The host's current inventory (replaces the previous one)."""
    _cid(cid)
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        require_machine_lane_member(cur, request, cid, LANE_GRANT)
        items = []
        for it in body.items:
            it = dict(it)
            for key in ("output", "modified"):
                if isinstance(it.get(key), list):
                    it[key] = [str(p)[:500] for p in it[key][:200]]
            items.append(it)
        cur.execute(
            """INSERT INTO agent_worktree_inventory (container_id, host, base_cwd, items, scanned_at)
               VALUES (%s,%s,%s,%s,now())
               ON CONFLICT (container_id) DO UPDATE SET host=EXCLUDED.host, base_cwd=EXCLUDED.base_cwd,
                 items=EXCLUDED.items, scanned_at=EXCLUDED.scanned_at""",
            (cid, body.host, body.base_cwd, sql.json_param(items)))
        conn.commit()
    return {"ok": True, "count": len(items)}


@app.post("/api/containers/{cid}/agent-worktrees/context")
def agent_worktree_context(cid: str, body: WorktreeContextBody, request: Request):
    """→ {items: {path: {task_id, task_status, task_title, task_ended_at, run_id, run_task_id,
    running, agent}}} for the given worktree paths, from the runs recorded in them (a task
    worktree with no recorded run is matched by the task id prefix in its branch name)."""
    _cid(cid)
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        require_machine_lane_member(cur, request, cid, LANE_GRANT)
        items: dict[str, dict] = {}
        if body.paths:
            cur.execute(
                f"""SELECT d.worktree, d.run_id, d.task_id, d.alias,
                          d.task_status, d.task_title, d.completed_at,
                          EXISTS (SELECT 1 FROM worker_runs r2 WHERE r2.worktree = d.worktree
                                     AND r2.status = 'running') AS running
                     FROM (
                       SELECT wr.worktree, wr.run_id, wr.task_id, a.alias,
                              t.status AS task_status, t.title AS task_title, t.completed_at,
                              ROW_NUMBER() OVER (PARTITION BY wr.worktree
                                                 ORDER BY (wr.task_id IS NULL), wr.started_at DESC) AS rn
                         FROM worker_runs wr JOIN agents a ON a.id = wr.agent_id
                         LEFT JOIN tasks t ON t.id = wr.task_id
                        WHERE a.container_id=%s AND {sql.in_list('wr.worktree')}
                     ) d
                    WHERE d.rn = 1
                    ORDER BY d.worktree""",
                (cid, sql.list_param(body.paths)))
            for r in cur.fetchall():
                items[r["worktree"]] = {
                    "task_id": str(r["task_id"]) if r["task_id"] else None,
                    "task_status": r["task_status"], "task_title": r["task_title"],
                    "task_ended_at": _iso(r["completed_at"]) if r["task_status"] in ("completed", "cancelled") else None,
                    "run_id": str(r["run_id"]), "run_task_id": str(r["task_id"]) if r["task_id"] else None,
                    "running": bool(r["running"]), "agent": r["alias"]}
        for path, ref in body.task_refs.items():
            if path in items and items[path].get("task_id"):
                continue
            ref = (ref or "").strip().lower()
            if len(ref) < 8 or not all(c in "0123456789abcdef-" for c in ref):
                continue
            cur.execute("""SELECT id, status, title, completed_at FROM tasks
                            WHERE container_id=%s AND CAST(id AS TEXT) LIKE %s LIMIT 2""", (cid, ref + "%"))
            rows = cur.fetchall()
            if len(rows) == 1:
                t = rows[0]
                items[path] = {"task_id": str(t["id"]), "task_status": t["status"], "task_title": t["title"],
                               "task_ended_at": _iso(t["completed_at"]) if t["status"] in ("completed", "cancelled") else None,
                               "run_id": None, "run_task_id": None, "running": False, "agent": None}
    return {"items": items}


@app.post("/api/containers/{cid}/agent-worktrees/events", status_code=201)
def log_agent_worktree_event(cid: str, body: WorktreeEventBody, request: Request):
    """Log one removal (``kind=removed``) or a removal that was refused (``kept``)."""
    _cid(cid)
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        require_machine_lane_member(cur, request, cid, LANE_GRANT)
        log_event(cur, cid, "system", None, "container", cid,
                  "agent_worktree_removed" if body.kind == "removed" else "agent_worktree_kept",
                  body.model_dump())
        conn.commit()
    return {"ok": True}
