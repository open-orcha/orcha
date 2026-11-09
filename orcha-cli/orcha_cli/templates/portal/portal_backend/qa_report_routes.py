"""Quality reports (`qa_report.py`).

  GET  /api/tasks/{tid}/qa/report.md              the task's report, for a Jira ticket
  GET  /api/tasks/{tid}/qa/report.zip             the same with its screenshots: what Import reads best
  POST /api/containers/{cid}/qa/reports           import a report (`.md` or `.zip`, the raw body)
  GET  /api/containers/{cid}/qa/reports           the imported reports, newest first
  GET  /api/qa/reports/{rid}                      one imported report, with each scenario's match here
  GET  /api/qa/reports/{rid}/frames/{fid}         a screenshot that came in its bundle
  POST /api/qa/reports/{rid}/drafts               the scenarios this project lacks, as drafts to approve
  DELETE /api/qa/reports/{rid}                    remove an imported report (a person)

An imported report is someone's account of a run: it is shown as reported and proves nothing here.
"""

import shutil
from typing import Optional
from urllib.parse import quote

from fastapi import HTTPException, Query, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from portal_backend import qa_report
from portal_backend import qa_store as qs
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.identity_routes import require_member_read


class ReportActor(BaseModel):
    actor_agent_id: Optional[str] = None


def _download(body: bytes, name: str, media: str) -> Response:
    return Response(body, media_type=media, headers={
        "Content-Disposition": f"attachment; filename=\"{name}\"; filename*=UTF-8''{quote(name)}", "X-Content-Type-Options": "nosniff"})


def _task(cur, request: Request, tid: str) -> dict:
    qs.require_uuid(tid, "task_id")
    cur.execute("SELECT id, container_id FROM tasks WHERE id=%s", (tid,))
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, f"task {tid} not found")
    require_member_read(cur, request, str(row["container_id"]))
    return dict(row)


@app.get("/api/tasks/{tid}/qa/report.md")
def get_task_qa_report_md(tid: str, request: Request):
    """The task's Quality report as Markdown: readable on a Jira ticket, and importable."""
    with db_cursor(readonly=True) as (_, cur):
        _task(cur, request, tid)
        data = qa_report.collect(cur, tid)
    return _download(qa_report.markdown(data).encode(), qa_report.file_stem(data) + ".md", "text/markdown; charset=utf-8")


@app.get("/api/tasks/{tid}/qa/report.zip")
def get_task_qa_report_zip(tid: str, request: Request):
    """The report with the screenshots it points at: report.md, report.json, frames/."""
    with db_cursor(readonly=True) as (_, cur):
        task = _task(cur, request, tid)
        data = qa_report.collect(cur, tid)
        body = qa_report.bundle(cur, data, str(task["container_id"]))
    return _download(body, qa_report.file_stem(data) + ".zip", "application/zip")


@app.post("/api/containers/{cid}/qa/reports", status_code=201)
async def import_qa_report(cid: str, request: Request, actor_agent_id: Optional[str] = Query(default=None),
                           file_name: Optional[str] = Query(default=None, max_length=300)):
    """Import a report: the raw `.md` or `.zip` as the body. Returns the report as `GET` does."""
    raw = await request.body()
    data, frames = qa_report.parse(raw)
    with db_cursor() as (conn, cur):
        qs.container_read(cur, request, cid)
        who = qs.actor(cur, request, cid, actor_agent_id)
        out = qa_report.save(cur, cid, who, data, frames, file_name)
        conn.commit()
    return out


@app.get("/api/containers/{cid}/qa/reports")
def list_qa_reports(cid: str, request: Request):
    with db_cursor(readonly=True) as (_, cur):
        qs.container_read(cur, request, cid)
        cur.execute("""SELECT r.id, r.title, r.file_name, r.created_at, r.data, a.alias AS imported_by FROM qa_reports r
                         LEFT JOIN agents a ON a.id=r.imported_by_agent_id WHERE r.container_id=%s ORDER BY r.created_at DESC LIMIT 200""", (cid,))
        rows = cur.fetchall()
    out = []
    for r in rows:
        data = qa_report.json.loads(r["data"])
        out.append({"id": str(r["id"]), "title": r["title"], "file_name": r["file_name"], "imported_by": r["imported_by"],
                    "created_at": qs.iso(r["created_at"]), "result": data.get("result"), "tally": data.get("tally"),
                    "platforms": (data.get("setup") or {}).get("platforms") or [], "project": (data.get("task") or {}).get("project"),
                    "generated_at": data.get("generated_at")})
    return {"reports": out}


def _report(cur, request: Request, rid: str) -> dict:
    qs.require_uuid(rid, "report_id")
    report = qa_report.load(cur, rid)
    require_member_read(cur, request, report["container_id"])
    return report


@app.get("/api/qa/reports/{rid}")
def get_qa_report(rid: str, request: Request):
    with db_cursor(readonly=True) as (_, cur):
        return _report(cur, request, rid)


@app.get("/api/qa/reports/{rid}/frames/{fid}")
def get_qa_report_frame(rid: str, fid: str, request: Request):
    qs.require_uuid(fid, "frame_id")
    with db_cursor(readonly=True) as (_, cur):
        report = _report(cur, request, rid)
    path = qa_report.report_dir(report["container_id"], rid) / f"{fid}.jpg"
    if not path.is_file():
        raise HTTPException(404, "This screenshot was not in the bundle.")
    return FileResponse(path, media_type="image/jpeg", headers={"X-Content-Type-Options": "nosniff", "Content-Disposition": "inline"})


@app.post("/api/qa/reports/{rid}/drafts", status_code=201)
def add_qa_report_drafts(rid: str, body: ReportActor, request: Request):
    """Add the reported scenarios this project lacks as drafts. A person approves them later."""
    with db_cursor() as (conn, cur):
        report = _report(cur, request, rid)
        who = qs.actor(cur, request, report["container_id"], body.actor_agent_id)
        made = qa_report.add_drafts(cur, report["container_id"], who, rid)
        conn.commit()
    return {"created": made}


@app.delete("/api/qa/reports/{rid}")
def delete_qa_report(rid: str, request: Request, actor_agent_id: Optional[str] = Query(default=None)):
    with db_cursor() as (conn, cur):
        report = _report(cur, request, rid)
        qs.human(cur, request, report["container_id"], actor_agent_id, "remove an imported report")
        cur.execute("DELETE FROM qa_reports WHERE id=%s", (rid,))
        conn.commit()
    shutil.rmtree(qa_report.report_dir(report["container_id"], rid), ignore_errors=True)
    return {"deleted": rid}
