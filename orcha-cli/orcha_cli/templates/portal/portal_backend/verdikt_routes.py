"""Verdikt integration routes (see verdikt_integration for the handoff contract).

  GET  /api/containers/{cid}/verdikt                    — per-project settings (members read)
  PUT  /api/containers/{cid}/verdikt                    — save settings (owner or manage_repo)
  POST /api/containers/{cid}/verdikt/test               — connection check (owner or manage_repo)
  GET  /api/tasks/{tid}/verdikt/runs                    — the task's Verdikt runs (open one polled)
  POST /api/tasks/{tid}/verdikt/runs                    — trigger a run (a human member)
  POST /api/tasks/{tid}/verdikt/runs/{rid}/refresh      — poll Verdikt now (members read)
  POST /api/tasks/{tid}/verdikt/runs/{rid}/cancel       — cancel an open run (a human member)
  GET  /api/tasks/{tid}/verdikt/runs/{rid}/artifact?path= — stream a screenshot / recording of
                                                           the run from Verdikt (members read)
  GET  /api/tasks/{tid}/verdikt/runs/{rid}/report       — 302 to the run's Verdikt report at a
                                                           browser-reachable host (members read)
  GET  /api/tasks/{tid}/verdikt/open?run=               — 302 "Open in Verdikt": the run's page, else
                                                           the project, in Verdikt's own web UI
  GET  /api/containers/{cid}/verdikt/open               — 302 to the project in Verdikt (members read)
  Preview environments (mig 064): verdikt_preview_routes. Auto-fix loop (mig 068):
  verdikt_autofix_routes.

Truthful states: `unavailable` (Verdikt did not answer), `failed` (it answered with an error or
no verdict), `timeout`, `cancelled`, `queued`/`running`, `completed` (+ verdict). A Verdikt
result never verifies or rejects the task — the human verification gate is unchanged.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Literal, Optional
from urllib.parse import quote, urlsplit

from fastapi import HTTPException, Query, Request
from fastapi.responses import JSONResponse, RedirectResponse, StreamingResponse
from pydantic import BaseModel, Field

from portal_backend import evidence_pack, verdikt_autofix as vaf, verdikt_integration as vi, verdikt_preview as vp
from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container, require_kind, valid_uuid
from portal_backend.identity_routes import require_grant, require_member_read, trusted_actor
from portal_backend.verdikt_client import (VerdiktError, artifact_content_type, browser_base, normalize_base,
                                           safe_artifact_path)


class VerdiktSettingsBody(BaseModel):
    actor_agent_id: Optional[str] = None
    enabled: bool = False
    base_url: Optional[str] = Field(default=None, max_length=500)
    verdikt_project: Optional[str] = Field(default=None, max_length=200)
    target_kind: Literal["web", "ios", "android"] = "web"
    target_locator: Optional[str] = Field(default=None, max_length=1000)
    trigger_mode: Literal["manual", "ui_changes", "always"] = "manual"
    timeout_minutes: int = Field(default=30, ge=1, le=240)
    # Preview environments (mig 064). Omitted fields keep their saved value (older clients
    # that don't know them never wipe a preview command); null / "" clears the command.
    preview_command: Optional[str] = Field(
        default=None, max_length=2000,
        description="Shell command the host notifier runs in the task's worktree to build and serve it, "
                    "e.g. `npm ci && npm run build && npx serve -l {port} dist`. Placeholders: {port}, "
                    "{worktree}, {branch}. Web targets only. Empty = no preview (Verdikt tests the URL).")
    preview_ready_path: Optional[str] = Field(default=None, max_length=200,
                                              description="Path polled on the preview until it answers (default /)")
    preview_timeout_seconds: Optional[int] = Field(default=None, ge=5, le=900,
                                                   description="How long the preview may take to become ready")
    preview_ttl_minutes: Optional[int] = Field(default=None, ge=5, le=480,
                                               description="The notifier stops a preview after this long regardless")
    # Auto-fix loop (mig 068). Omitted = keep the saved value (older clients never reset it).
    autofix_enabled: Optional[bool] = Field(
        default=None,
        description="When Verdikt fails, send the task back to its agent automatically (default off). Takes "
                    "effect only when trigger_mode is ui_changes or always; a pass always leaves the task for "
                    "a human to verify.")
    autofix_max_attempts: Optional[int] = Field(
        default=None, ge=1, le=10,
        description="How many Verdikt checks one auto-fix loop may make, the first included (default 3)")


class VerdiktTestBody(BaseModel):
    actor_agent_id: Optional[str] = None
    base_url: Optional[str] = Field(default=None, max_length=500)
    verdikt_project: Optional[str] = Field(default=None, max_length=200)


class VerdiktTriggerBody(BaseModel):
    actor_agent_id: Optional[str] = None
    locator: Optional[str] = Field(default=None, max_length=1000)


class VerdiktActorBody(BaseModel):
    actor_agent_id: Optional[str] = None


def _cid(cid: str):
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")


def _human(cur, request: Request, container_id: str, actor: Optional[str]) -> str:
    actor = trusted_actor(cur, request, container_id, actor)
    require_kind(cur, actor, ("human",))
    return str(actor)


@app.get("/api/containers/{cid}/verdikt")
def get_verdikt_settings(cid: str, request: Request):
    _cid(cid)
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        require_member_read(cur, request, cid)
        return vi.settings_public(vi.settings_row(cur, cid))


@app.put("/api/containers/{cid}/verdikt")
def put_verdikt_settings(cid: str, body: VerdiktSettingsBody, request: Request):
    _cid(cid)
    base = None
    if body.base_url and body.base_url.strip():
        try:
            base = normalize_base(body.base_url)
        except VerdiktError as e:
            raise HTTPException(400, str(e)) from e
    project = (body.verdikt_project or "").strip() or None
    if project and not all(c.isalnum() or c in "-_." for c in project):
        raise HTTPException(400, "the Verdikt project is its slug (letters, digits, - _ .)")
    try:
        locator = vi.validate_locator(body.target_kind, body.target_locator)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    if body.enabled and (not base or not project):
        raise HTTPException(400, "to enable Verdikt, set its URL and the Verdikt project slug")
    sent = body.model_fields_set
    try:
        pv_cmd = vp.validate_command(body.preview_command) if "preview_command" in sent else None
        pv_path = vp.validate_ready_path(body.preview_ready_path) if "preview_ready_path" in sent else None
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    if pv_cmd and body.target_kind != "web":
        raise HTTPException(400, "a preview command only applies to a web target")
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        member = require_grant(cur, request, cid, body.actor_agent_id, "manage_repo")
        actor = str(member["id"])
        prev_row = vi.settings_row(cur, cid)
        prev = vp.settings_fields(prev_row)
        pv = {
            "preview_command": pv_cmd if "preview_command" in sent else prev["preview_command"],
            "preview_ready_path": (pv_path or "/") if "preview_ready_path" in sent else prev["preview_ready_path"],
            "preview_timeout_seconds": body.preview_timeout_seconds or prev["preview_timeout_seconds"],
            "preview_ttl_minutes": body.preview_ttl_minutes or prev["preview_ttl_minutes"],
        }
        if body.target_kind != "web":
            pv["preview_command"] = None  # a kept command never outlives a switch away from web
        cur.execute(
            """INSERT INTO container_verdikt_settings
                 (container_id, enabled, base_url, verdikt_project, target_kind, target_locator,
                  trigger_mode, timeout_minutes, updated_by, updated_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s, now())
               ON CONFLICT (container_id) DO UPDATE SET
                 enabled=EXCLUDED.enabled, base_url=EXCLUDED.base_url,
                 verdikt_project=EXCLUDED.verdikt_project, target_kind=EXCLUDED.target_kind,
                 target_locator=EXCLUDED.target_locator, trigger_mode=EXCLUDED.trigger_mode,
                 timeout_minutes=EXCLUDED.timeout_minutes, updated_by=EXCLUDED.updated_by,
                 updated_at=now()""",
            (cid, body.enabled, base, project, body.target_kind, locator, body.trigger_mode,
             body.timeout_minutes, actor),
        )
        cur.execute(
            """UPDATE container_verdikt_settings SET preview_command=%s, preview_ready_path=%s,
                      preview_timeout_seconds=%s, preview_ttl_minutes=%s WHERE container_id=%s""",
            (pv["preview_command"], pv["preview_ready_path"], pv["preview_timeout_seconds"],
             pv["preview_ttl_minutes"], cid),
        )
        af_prev = vaf.settings_fields(prev_row)
        af = {
            "autofix_enabled": body.autofix_enabled if body.autofix_enabled is not None else af_prev["autofix_enabled"],
            "autofix_max_attempts": body.autofix_max_attempts or af_prev["autofix_max_attempts"],
        }
        cur.execute(
            "UPDATE container_verdikt_settings SET autofix_enabled=%s, autofix_max_attempts=%s WHERE container_id=%s",
            (af["autofix_enabled"], af["autofix_max_attempts"], cid),
        )
        vaf.stop_where_off(cur, cid, actor)  # turned off (or Verdikt made manual): running loops end
        log_event(cur, cid, "human", actor, "container", cid, "verdikt_settings_changed",
                  {"enabled": body.enabled, "base_url": base, "verdikt_project": project,
                   "target_kind": body.target_kind, "trigger_mode": body.trigger_mode,
                   "preview_command": pv["preview_command"], **af})
        row = vi.settings_row(cur, cid)
        conn.commit()
    return vi.settings_public(row)


@app.post("/api/containers/{cid}/verdikt/test")
def check_verdikt_connection(cid: str, body: VerdiktTestBody, request: Request):
    """{reachable, ok, worker_online, project_found, project, projects[], error}. Uses the body's
    URL/project when given (test before saving), else the saved settings."""
    _cid(cid)
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        require_grant(cur, request, cid, body.actor_agent_id, "manage_repo")
        saved = vi.settings_row(cur, cid) or {}
    base = (body.base_url or "").strip() or saved.get("base_url")
    slug = (body.verdikt_project or "").strip() or saved.get("verdikt_project")
    out = {"reachable": False, "ok": False, "worker_online": None, "project_found": None,
           "project": None, "projects": [], "error": None, "base_url": base}
    if not base:
        # nothing was contacted — never report "reachable" for a check that did not happen
        out["error"] = "no Verdikt URL configured"
        return out
    try:
        client = vi.client_factory(base or "")
        h = client.health()
        out["reachable"] = True
        out["worker_online"] = bool((h.get("worker") or {}).get("online"))
        projects = client.projects()
        out["projects"] = [{"slug": p.get("slug"), "name": p.get("name"), "archived": bool(p.get("archived_at"))}
                           for p in projects]
        if slug:
            p = next((p for p in projects if p.get("slug") == slug), None)
            out["project_found"] = p is not None
            out["project"] = {"slug": p.get("slug"), "name": p.get("name"), "id": p.get("id")} if p else None
        out["ok"] = bool(out["reachable"] and (out["project_found"] is not False))
        if slug and not out["project_found"]:
            out["error"] = f"Verdikt has no project '{slug}'"
    except VerdiktError as e:
        out["error"] = str(e)
        out["reachable"] = not e.unreachable
    return out


def _load_task(cur, tid: str) -> dict:
    if not valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    t = evidence_pack._load_task(cur, tid)
    if not t:
        raise HTTPException(404, f"task {tid} not found")
    return t


@app.get("/api/tasks/{tid}/verdikt/runs")
def list_verdikt_runs(tid: str, request: Request):
    with db_cursor() as (conn, cur):
        task = _load_task(cur, tid)
        require_member_read(cur, request, str(task["container_id"]))
        vi.refresh_latest(cur, task)
        conn.commit()
    vaf.process_task(tid)  # a run that just finished may move the auto-fix loop (idempotent)
    with db_cursor() as (_, cur):
        rows = vi.runs_for_task(cur, tid)
        settings = vi.settings_public(vi.settings_row(cur, str(task["container_id"])))
        autofix = vaf.state(cur, task)
    return {"task_id": tid, "settings": settings, "runs": [vi.run_public(r) for r in rows], "autofix": autofix}


@app.post("/api/tasks/{tid}/verdikt/runs", status_code=201)
def trigger_verdikt_run(tid: str, body: VerdiktTriggerBody, request: Request):
    """Hand the task to Verdikt now. 201 with the run — whose status may already be
    `unavailable`/`failed` (recorded honestly, with Retry). 409 when Verdikt is not set up or a
    run is already open; 400 when there is no target."""
    with db_cursor() as (_, cur):
        task = _load_task(cur, tid)
        actor = _human(cur, request, str(task["container_id"]), body.actor_agent_id)
    if task["status"] == "cancelled":
        raise HTTPException(409, "the task is cancelled")
    try:
        run = vi.trigger(task, trigger_kind="manual", actor_id=actor, locator_override=body.locator)
    except vi.TriggerRefused as e:
        raise HTTPException(e.status, e.detail) from e
    return JSONResponse(run, status_code=201)


def _load_run(cur, tid: str, rid: str) -> dict:
    if not valid_uuid(rid):
        raise HTTPException(400, "run id is not a valid UUID")
    cur.execute("SELECT * FROM verdikt_runs WHERE id=%s AND task_id=%s", (rid, tid))
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, "Verdikt run not found for this task")
    return dict(row)


@app.post("/api/tasks/{tid}/verdikt/runs/{rid}/refresh")
def refresh_verdikt_run(tid: str, rid: str, request: Request):
    with db_cursor() as (conn, cur):
        task = _load_task(cur, tid)
        require_member_read(cur, request, str(task["container_id"]))
        run = _load_run(cur, tid, rid)
        s = vi.settings_row(cur, str(task["container_id"])) or {}
        run = vi.refresh_run(cur, run, timeout_minutes=int(s.get("timeout_minutes") or 30), force=True)
        vi.with_preview(cur, run)
        conn.commit()
    if run.get("autofix") and run["status"] not in vi.OPEN_STATUSES:
        vaf.process_task(tid)
    return vi.run_public(run)


_RANGE = re.compile(r"^bytes=\d*-\d*$")
_ARTIFACT_CHUNK = 64 * 1024


@app.get("/api/tasks/{tid}/verdikt/runs/{rid}/artifact")
def get_verdikt_artifact(tid: str, rid: str, request: Request, path: str = Query(..., max_length=400)):
    """Stream one screenshot / step frame / recording of this Verdikt run from the Verdikt site
    (the browser can't reach Verdikt's server-side URL, e.g. host.docker.internal). Same
    permission as reading the task's evidence (members read). Strict allow-list: `path` must
    be one of the artifacts THIS run recorded, inside its own Verdikt run folder, with an
    image/video extension — so no SSRF (the host is the run's stored Verdikt base, the path is
    a known one), no traversal, and no other run's files. Range requests (video seeking) are
    passed through. 404 for anything outside the allow-list; 502 when Verdikt doesn't answer."""
    with db_cursor() as (_, cur):
        task = _load_task(cur, tid)
        require_member_read(cur, request, str(task["container_id"]))
        run = _load_run(cur, tid, rid)
    safe = safe_artifact_path(path, run.get("verdikt_run_id"))
    if not safe or safe not in vi.artifact_paths(run) or not run.get("base_url"):
        raise HTTPException(404, "no such artifact for this Verdikt run")
    rng = request.headers.get("range")
    rng = rng.strip() if rng and _RANGE.match(rng.strip()) else None
    try:
        upstream = vi.client_factory(run["base_url"]).open_artifact(safe, range_header=rng, timeout=15.0)
    except VerdiktError as e:
        if e.status in (404, 416):
            raise HTTPException(e.status, "Verdikt no longer has this artifact" if e.status == 404
                                else "requested range not satisfiable") from e
        raise HTTPException(502, f"could not fetch the artifact from Verdikt: {e}") from e
    status = getattr(upstream, "status", None) or upstream.getcode()
    uh = upstream.headers
    headers = {
        "Content-Type": artifact_content_type(safe),  # ours, never Verdikt's
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; img-src 'self'; media-src 'self'; sandbox",
        "Content-Disposition": "inline",
    }
    for h in ("Content-Length", "Content-Range", "Accept-Ranges"):
        if uh.get(h):
            headers[h] = uh.get(h)

    def _body():
        try:
            while True:
                chunk = upstream.read(_ARTIFACT_CHUNK)
                if not chunk:
                    break
                yield chunk
        finally:
            upstream.close()

    return StreamingResponse(_body(), status_code=206 if status == 206 else 200, headers=headers)


def browser_host(request: Request) -> str | None:
    """The host the browser used to reach the portal (X-Forwarded-Host first), IPv6 bracketed."""
    fwd = (request.headers.get("x-forwarded-host") or "").split(",")[0].strip()
    host = urlsplit("//" + fwd).hostname if fwd else request.url.hostname
    if host and ":" in host:  # IPv6 literal
        host = f"[{host}]"
    return host


def _redirect(url: str) -> RedirectResponse:
    return RedirectResponse(url, status_code=302, headers={"Cache-Control": "no-store"})


def verdikt_page(base_url: str, request: Request, path: str) -> RedirectResponse:
    """302 to `path` on the Verdikt site at a browser-reachable host (see open_verdikt_report)."""
    try:
        base = browser_base(base_url, browser_host(request))
    except VerdiktError as e:
        raise HTTPException(404, str(e)) from e
    return _redirect(base + path)


def _project_path(slug: str | None) -> str:
    return f"/projects/{quote(slug, safe='')}" if slug else "/"


@app.get("/api/tasks/{tid}/verdikt/open")
def open_task_in_verdikt(tid: str, request: Request, run: Optional[str] = Query(default=None, max_length=64)):
    """"Open in Verdikt": 302 to Verdikt's own web UI at a browser-reachable host (a container-only
    Verdikt host is swapped for the host the portal was opened on, like the report link).

    * a run (`?run=<Orcha Verdikt-run id>`, else the task's latest) that Verdikt started →
      `/runs/{verdikt run id}?scenario={scenario id}` (the run page, on the task's scenario);
    * no Verdikt run yet (queued, previewing, never run) → the project page `/projects/{slug}`;
    * no project slug known → Verdikt's home page.
    Members read (like the evidence). 404 when Verdikt isn't set up and nothing ever ran."""
    with db_cursor() as (_, cur):
        task = _load_task(cur, tid)
        require_member_read(cur, request, str(task["container_id"]))
        row = _load_run(cur, tid, run) if run else vi.latest_run(cur, tid)
        settings = vi.settings_row(cur, str(task["container_id"])) or {}
    base = (row or {}).get("base_url") or settings.get("base_url")
    if not base:
        raise HTTPException(404, "Verdikt isn't set up for this project")
    if row and row.get("verdikt_run_id"):
        path = f"/runs/{quote(str(row['verdikt_run_id']), safe='')}"
        if row.get("verdikt_scenario_id"):
            path += f"?scenario={quote(str(row['verdikt_scenario_id']), safe='')}"
        return verdikt_page(base, request, path)
    handed = ((row or {}).get("handoff") or {}).get("verdikt_project")
    slug = handed.get("slug") if isinstance(handed, dict) else None
    return verdikt_page(base, request, _project_path(slug or settings.get("verdikt_project")))


@app.get("/api/containers/{cid}/verdikt/open")
def open_project_in_verdikt(cid: str, request: Request):
    """302 to the project's page in Verdikt (its home page when no slug is set) at a
    browser-reachable host. Members read. 404 when no Verdikt URL is configured."""
    _cid(cid)
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        require_member_read(cur, request, cid)
        settings = vi.settings_row(cur, cid) or {}
    if not settings.get("base_url"):
        raise HTTPException(404, "no Verdikt URL is configured for this project")
    return verdikt_page(settings["base_url"], request, _project_path(settings.get("verdikt_project")))


@app.get("/api/tasks/{tid}/verdikt/runs/{rid}/report")
def open_verdikt_report(tid: str, rid: str, request: Request):
    """302 to this run's report page on the Verdikt site, at an address the BROWSER can open:
    a container-only Verdikt host (host.docker.internal …) is replaced by the host the portal
    was opened on (Verdikt's port kept). The report is Verdikt's own interactive page, so it is
    linked, not proxied. Members read. 404 when the run has no Verdikt run yet."""
    with db_cursor() as (_, cur):
        task = _load_task(cur, tid)
        require_member_read(cur, request, str(task["container_id"]))
        run = _load_run(cur, tid, rid)
    vrid = run.get("verdikt_run_id")
    if not vrid or not run.get("base_url"):
        raise HTTPException(404, "this Verdikt run has no report yet")
    try:
        base = browser_base(run["base_url"], browser_host(request))
    except VerdiktError as e:
        raise HTTPException(404, str(e)) from e
    return RedirectResponse(f"{base}/runs/{quote(str(vrid))}", status_code=302,
                            headers={"Cache-Control": "no-store"})


@app.post("/api/tasks/{tid}/verdikt/runs/{rid}/cancel")
def cancel_verdikt_run(tid: str, rid: str, body: VerdiktActorBody, request: Request):
    with db_cursor() as (conn, cur):
        task = _load_task(cur, tid)
        actor = _human(cur, request, str(task["container_id"]), body.actor_agent_id)
        run = _load_run(cur, tid, rid)
        if run["status"] not in vi.OPEN_STATUSES:
            raise HTTPException(409, f"the Verdikt run is already {run['status']}")
    note = "cancelled from Orcha"
    if run.get("verdikt_request_id"):
        try:
            vi.client_factory(run["base_url"]).cancel_request(run["verdikt_request_id"])
        except VerdiktError as e:
            note = f"cancelled in Orcha; Verdikt did not confirm ({e})"
    with db_cursor() as (conn, cur):
        vi._update(cur, rid, status="cancelled", error=note, finished_at=datetime.now(timezone.utc))
        vp.stop_for_run(cur, rid, "the Verdikt run was cancelled")
        log_event(cur, str(task["container_id"]), "human", actor, "task", tid, "verdikt_cancelled",
                  {"verdikt_run": rid})
        cur.execute("SELECT * FROM verdikt_runs WHERE id=%s", (rid,))
        row = vi.with_preview(cur, dict(cur.fetchone()))
        conn.commit()
    if row.get("autofix"):
        vaf.process_task(tid)  # a cancelled run is not a test fail: the loop hands over
    return vi.run_public(row)


# Preview environments (mig 064): registered with the Verdikt routes they extend.
from portal_backend import verdikt_preview_routes  # noqa: E402,F401
# Auto-fix loop (mig 068).
from portal_backend import verdikt_autofix_routes  # noqa: E402,F401
