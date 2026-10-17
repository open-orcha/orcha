"""Preview-environment routes for Verdikt runs (mig 064; the lifecycle is in verdikt_preview).

Browser (members read, like the evidence):
  GET  /api/tasks/{tid}/verdikt/runs/{rid}/preview        302 to the running preview, at the host
                                                          the portal was opened on
  GET  /api/tasks/{tid}/verdikt/runs/{rid}/preview/log    the preview's log tail + state

Notifier (the machine lane: header-less daemon passes; a trusted human needs a non-viewer
membership with manage_repo, since the lane reports what runs a project command):
  POST /api/containers/{cid}/verdikt/previews/claim       claim the oldest requested preview
  POST /api/verdikt/previews/{pid}/ready                  the preview answers on {port} → Verdikt
                                                          is handed its URL
  POST /api/verdikt/previews/{pid}/failed                 it didn't start: plain reason + log tail
  POST /api/verdikt/previews/{pid}/heartbeat              log tail; the answer says whether to stop
  POST /api/verdikt/previews/{pid}/stopped                the notifier stopped it (why)
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import HTTPException, Request
from pydantic import BaseModel, Field

from portal_backend import sql
from portal_backend import verdikt_integration as vi, verdikt_preview as vp
from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container, valid_uuid
from portal_backend.identity_routes import require_machine_lane_member, require_member_read
from portal_backend.verdikt_routes import _cid, _load_run, _load_task, _redirect, browser_host

LANE_GRANT = "manage_repo"


class PreviewClaimBody(BaseModel):
    claimed_by: Optional[str] = Field(default=None, max_length=200,
                                      description="Who claimed it (host + notifier pid), for the audit trail")


class PreviewReadyBody(BaseModel):
    port: int = Field(ge=1024, le=65535, description="The port the preview answers on (on the notifier's host)")
    log_tail: Optional[str] = Field(default=None, max_length=200_000)


class PreviewFailedBody(BaseModel):
    error: str = Field(min_length=1, max_length=2000, description="Plain words: why it didn't start")
    log_tail: Optional[str] = Field(default=None, max_length=200_000)


class PreviewHeartbeatBody(BaseModel):
    log_tail: Optional[str] = Field(default=None, max_length=200_000)


class PreviewStoppedBody(BaseModel):
    reason: str = Field(min_length=1, max_length=500)
    log_tail: Optional[str] = Field(default=None, max_length=200_000)
    exited: bool = Field(default=False, description="True when the process ended by itself")


def _now():
    return datetime.now(timezone.utc)


# ------------------------------------------------------------------ browser

def _preview_of(cur, request: Request, tid: str, rid: str) -> dict:
    task = _load_task(cur, tid)
    require_member_read(cur, request, str(task["container_id"]))
    _load_run(cur, tid, rid)
    p = vp.for_run(cur, rid)
    if not p:
        raise HTTPException(404, "this Verdikt run has no preview")
    return p


@app.get("/api/tasks/{tid}/verdikt/runs/{rid}/preview")
def open_verdikt_preview(tid: str, rid: str, request: Request):
    """302 to the running preview at `http://<host the portal was opened on>:<port><path>` — the
    preview listens on the notifier's machine, which is the portal's host in the local setup.
    409 while it isn't ready (or after it stopped); 404 when the run has no preview."""
    with db_cursor() as (_, cur):
        p = _preview_of(cur, request, tid, rid)
    if p["status"] != "ready" or not p.get("port"):
        raise HTTPException(409, f"the preview is {p['status']}" + (f": {p['error']}" if p.get("error") else ""))
    host = browser_host(request) or "localhost"
    path = "/"
    if p.get("verdikt_url"):
        tail = p["verdikt_url"].split("://", 1)[-1]
        path = "/" + tail.split("/", 1)[1] if "/" in tail else "/"
    return _redirect(f"http://{host}:{int(p['port'])}{path}")


@app.get("/api/tasks/{tid}/verdikt/runs/{rid}/preview/log")
def get_verdikt_preview_log(tid: str, rid: str, request: Request):
    """{status, lines[], error, updated_at} — the last lines the notifier captured from the
    preview command's output (it pushes the tail with every heartbeat)."""
    with db_cursor() as (_, cur):
        p = _preview_of(cur, request, tid, rid)
    tail = p.get("log_tail") or ""
    return {"preview_id": str(p["id"]), "status": p["status"], "error": p.get("error"),
            "lines": tail.split("\n") if tail else [],
            "updated_at": p["updated_at"].isoformat() if p.get("updated_at") else None}


# ------------------------------------------------------------------ notifier lane

def _lane_preview(cur, request: Request, pid: str) -> dict:
    if not valid_uuid(pid):
        raise HTTPException(400, "preview id is not a valid UUID")
    cur.execute("SELECT * FROM verdikt_previews WHERE id=%s " + sql.for_update(), (pid,))
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, "preview not found")
    require_machine_lane_member(cur, request, str(row["container_id"]), LANE_GRANT)
    return dict(row)


def _run_row(cur, p: dict) -> dict | None:
    if not p.get("verdikt_run_id"):
        return None
    cur.execute("SELECT * FROM verdikt_runs WHERE id=%s", (str(p["verdikt_run_id"]),))
    r = cur.fetchone()
    return dict(r) if r else None


def _claim_payload(p: dict) -> dict:
    return {"id": str(p["id"]), "task_id": str(p["task_id"]), "verdikt_run_id": str(p["verdikt_run_id"]),
            "command": p["command"], "ready_path": p["ready_path"], "timeout_seconds": p["timeout_seconds"],
            "ttl_minutes": p["ttl_minutes"], "worktree": p.get("worktree"), "branch": p.get("branch"),
            "base_cwd": p.get("base_cwd")}


@app.post("/api/containers/{cid}/verdikt/previews/claim")
def claim_verdikt_preview(cid: str, body: PreviewClaimBody, request: Request):
    """Atomically claim the oldest `requested` preview of the project → {preview: {...} | null}.
    A request whose Verdikt run already ended is closed instead of handed out."""
    _cid(cid)
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        require_machine_lane_member(cur, request, cid, LANE_GRANT)
        while True:
            cur.execute(
                """SELECT * FROM verdikt_previews WHERE container_id=%s AND status='requested'
                    ORDER BY created_at ASC LIMIT 1 """ + sql.for_update(skip_locked=True),
                (cid,),
            )
            row = cur.fetchone()
            if not row:
                conn.commit()
                return {"preview": None}
            p = dict(row)
            run = _run_row(cur, p)
            why = vp.stop_decision(p, run)
            if why:
                vp.update(cur, p["id"], status="stopped", stop_reason=why, stopped_at=_now())
                continue
            p = vp.update(cur, p["id"], status="starting", claimed_at=_now(), last_seen_at=_now(),
                          claimed_by=(body.claimed_by or "notifier")[:200])
            conn.commit()
            return {"preview": _claim_payload(p)}


@app.post("/api/verdikt/previews/{pid}/ready")
def verdikt_preview_ready(pid: str, body: PreviewReadyBody, request: Request):
    """The preview answers its ready check on `port`: record it, point the Verdikt run at the
    preview's URL and hand the task to Verdikt now. → {stop, reason, run_status}."""
    with db_cursor() as (conn, cur):
        p = _lane_preview(cur, request, pid)
        run = _run_row(cur, p)
        if p["status"] not in ("requested", "starting"):
            conn.commit()
            return {"stop": p["status"] != "ready", "reason": f"the preview is already {p['status']}",
                    "run_status": run and run["status"]}
        settings = vi.settings_row(cur, str(p["container_id"])) or {}
        url = vp.verdikt_url(settings, body.port)
        p = vp.update(cur, p["id"], status="ready", port=body.port, verdikt_url=url, ready_at=_now(),
                      last_seen_at=_now(), log_tail=vp.clean_tail(body.log_tail) or p.get("log_tail"))
        why = vp.stop_decision(p, run)
        if why:
            vp.request_stop(cur, p, why)
            conn.commit()
            return {"stop": True, "reason": why, "run_status": run and run["status"]}
        handoff = vp.retarget_handoff(run.get("handoff") or {}, url, p.get("branch"))
        vi._update(cur, str(run["id"]), locator=url, handoff=handoff)
        cur.execute("SELECT * FROM verdikt_runs WHERE id=%s", (str(run["id"]),))
        run = dict(cur.fetchone())
        log_event(cur, str(p["container_id"]), "system", None, "task", str(p["task_id"]), "verdikt_preview_ready",
                  {"verdikt_run": str(run["id"]), "preview": str(p["id"]), "url": url})
        conn.commit()
    # the Verdikt handoff (a few HTTP calls) happens outside the row lock
    if settings.get("base_url") and settings.get("verdikt_project"):
        fields = vi.send_to_verdikt(run, settings)
    else:
        fields = {"status": "failed", "error": "Verdikt settings are incomplete — a Verdikt URL and project are required",
                  "finished_at": _now()}
    with db_cursor() as (conn, cur):
        vi._update(cur, str(run["id"]), **fields)
        if fields.get("status") not in vi.OPEN_STATUSES:
            vp.stop_for_run(cur, run["id"], f"the Verdikt run is {fields.get('status')}")
        cur.execute("SELECT status FROM verdikt_runs WHERE id=%s", (str(run["id"]),))
        st = cur.fetchone()["status"]
        conn.commit()
    return {"stop": st not in vi.OPEN_STATUSES, "reason": None if st in vi.OPEN_STATUSES else f"the Verdikt run is {st}",
            "run_status": st, "verdikt_url": url}


@app.post("/api/verdikt/previews/{pid}/failed")
def verdikt_preview_failed(pid: str, body: PreviewFailedBody, request: Request):
    """The preview didn't start (command exited, ready check timed out, bad worktree …). The
    Verdikt run fails with "Preview failed: <reason>" — Verdikt is never handed a dead URL."""
    with db_cursor() as (conn, cur):
        p = _lane_preview(cur, request, pid)
        if p["status"] in ("failed", "stopped"):
            conn.commit()
            return {"ok": True, "status": p["status"]}
        err = body.error.strip()[:2000]
        p = vp.update(cur, p["id"], status="failed", error=err, stopped_at=_now(), last_seen_at=_now(),
                      log_tail=vp.clean_tail(body.log_tail) or p.get("log_tail"))
        run = _run_row(cur, p)
        if run:
            vp.fail_run(cur, run, "Preview failed: " + err)
        log_event(cur, str(p["container_id"]), "system", None, "task", str(p["task_id"]), "verdikt_preview_failed",
                  {"preview": str(p["id"]), "error": err[:300]})
        conn.commit()
    return {"ok": True, "status": "failed"}


@app.post("/api/verdikt/previews/{pid}/heartbeat")
def verdikt_preview_heartbeat(pid: str, body: PreviewHeartbeatBody, request: Request):
    """The notifier's periodic check-in for a running preview: stores the log tail, drives the
    Verdikt poll (so a finished run is noticed without anyone reading the task), and answers
    {stop, reason} — stop once the Verdikt run is over, was cancelled, or the TTL passed."""
    with db_cursor() as (conn, cur):
        p = _lane_preview(cur, request, pid)
        fields = {"last_seen_at": _now()}
        tail = vp.clean_tail(body.log_tail)
        if tail:
            fields["log_tail"] = tail
        p = vp.update(cur, p["id"], **fields)
        conn.commit()
    if p["status"] in ("failed", "stopped"):
        return {"stop": True, "reason": p.get("stop_reason") or f"the preview is {p['status']}"}
    with db_cursor() as (conn, cur):
        run = _run_row(cur, p)
        if run and run["status"] in vi.OPEN_STATUSES:
            s = vi.settings_row(cur, str(p["container_id"])) or {}
            run = vi.refresh_run(cur, run, timeout_minutes=int(s.get("timeout_minutes") or 30))
        cur.execute("SELECT * FROM verdikt_previews WHERE id=%s", (str(p["id"]),))
        p = dict(cur.fetchone())
        why = vp.stop_decision(p, run)
        if why:
            vp.request_stop(cur, p, why)
        conn.commit()
    return {"stop": bool(why), "reason": why}


@app.post("/api/verdikt/previews/{pid}/stopped")
def verdikt_preview_stopped(pid: str, body: PreviewStoppedBody, request: Request):
    """The notifier stopped the preview (after the run, on its TTL, or the process exited)."""
    with db_cursor() as (conn, cur):
        p = _lane_preview(cur, request, pid)
        if p["status"] in ("failed", "stopped"):
            conn.commit()
            return {"ok": True, "status": p["status"]}
        reason = body.reason.strip()[:500]
        before = p["status"]
        p = vp.update(cur, p["id"], status="stopped", stop_reason=p.get("stop_reason") or reason,
                      stopped_at=_now(), last_seen_at=_now(),
                      log_tail=vp.clean_tail(body.log_tail) or p.get("log_tail"))
        run = _run_row(cur, p)
        if run and before != "ready":
            vp.fail_run(cur, run, "Preview failed: " + reason)
        elif run and body.exited and run["status"] in vi.OPEN_STATUSES:
            # the server died while Verdikt was still testing it — say so on the run
            vi._update(cur, str(run["id"]), error=f"the preview stopped while Verdikt was testing: {reason}")
        conn.commit()
    return {"ok": True, "status": "stopped"}
