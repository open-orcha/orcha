"""Proof-of-work evidence routes (read side of the verification gate).

  GET  /api/tasks/{tid}/evidence                 — the task's evidence pack (built/rebuilt on
                                                   demand; Verdikt's latest run merged in)
  POST /api/tasks/{tid}/evidence/rebuild         — force a rebuild now
  GET  /api/containers/{cid}/evidence-summaries  — one-line summaries for the project's tasks
                                                   awaiting verification (Needs-you rows)

Authorization: project members read (viewers included — reading is what the role is for);
trusted non-members 403; trust off unchanged (require_member_read). The pack is evidence
for the human verifier and never changes task state.
"""

from __future__ import annotations

from fastapi import HTTPException, Query, Request

from portal_backend import evidence_pack, verdikt_autofix as vaf, verdikt_integration as vi
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container, valid_uuid
from portal_backend.identity_routes import require_member_read

MAX_SUMMARIES = 50


def _task(cur, tid: str) -> dict:
    t = evidence_pack._load_task(cur, tid)
    if not t:
        raise HTTPException(404, f"task {tid} not found")
    return t


def _pack_response(cur, task: dict, *, force: bool = False, reason: str = "read", poll: bool = True):
    pack, rebuilt = evidence_pack.ensure_pack(cur, task, reason=reason, force=force)
    vrun = vi.refresh_latest(cur, task) if poll else vi.latest_run(cur, str(task["id"]))
    # the DoD checklist rests on the round's latest REAL verdict — a later retry that was
    # cancelled / unavailable / still running must not erase (or hide) it
    verdict_run = vrun if vrun and vrun["status"] == "completed" else \
        vi.latest_completed_run(cur, str(task["id"]), pack.get("round_started_at"))
    out = evidence_pack.with_verdikt(pack, vi.run_public(vrun), vi.run_public(verdict_run))
    # mig 068: the auto-fix loop's state (attempt N of M / why it stopped) for the gate and Needs-you
    out["autofix"] = vaf.summary(cur, str(task["id"]))
    out["summary"]["autofix"] = out["autofix"]
    out["rebuilt"] = rebuilt
    return out, pack, rebuilt


@app.get("/api/tasks/{tid}/evidence")
def get_task_evidence(tid: str, request: Request):
    """The evidence pack: {task_id, task_status, built_at, round_started_at, runs[], tests{status,
    passed, failed, skipped, errors, suites, latest[{framework, command, exit_code, counts, outcome,
    run_id}], earlier}, changes{files, additions, deletions, categories, summary, ui_touching,
    flags[], list[], unavailable_runs[]}, flags[], dod{items[{index, text, status:
    proven|not_proven|needs_human, basis, evidence, related?, claim?, verdikt?}], total, proven,
    not_proven, needs_human}, claim{text}|null, links[{kind, label, href}], branch, pr_urls[],
    preview_urls[], verdikt (latest Verdikt run)|null, summary{dod, tests, risk_flags, verdikt,
    line, autofix}, autofix (the Verdikt auto-fix loop: {status, attempts_made, max_attempts,
    current_attempt, stop_kind, stop_label, stop_reason})|null, rebuilt}."""
    if not valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        task = _task(cur, tid)
        require_member_read(cur, request, str(task["container_id"]))
        out, pack, rebuilt = _pack_response(cur, task)
        conn.commit()
    if out.get("verdikt") and out["verdikt"].get("autofix") and vaf.process_task(tid):
        # the poll above finished an auto-fix run: the loop just acted — answer with that state
        with db_cursor() as (conn, cur):
            task = _task(cur, tid)
            out, pack, rebuilt = _pack_response(cur, task, poll=False)
            conn.commit()
    if rebuilt and task["status"] == "needs_verification":
        vi.maybe_auto_trigger(tid, pack, background=True)
    return out


@app.post("/api/tasks/{tid}/evidence/rebuild")
def rebuild_task_evidence(tid: str, request: Request):
    """Rebuild the pack now (e.g. after a run's diff was captured). Same shape as GET."""
    if not valid_uuid(tid):
        raise HTTPException(400, "task_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        task = _task(cur, tid)
        require_member_read(cur, request, str(task["container_id"]))
        out, _pack, _ = _pack_response(cur, task, force=True, reason="rebuild")
        conn.commit()
    return out


@app.get("/api/containers/{cid}/evidence-summaries")
def get_evidence_summaries(cid: str, request: Request,
                           status: str = Query(default="needs_verification")):
    """{summaries: {task_id: {dod, tests, risk_flags, verdikt, line}}} for the project's tasks in
    `status` (default needs_verification; at most 50, highest priority first). Verdikt state is
    read as last polled (the detail view polls)."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    if status not in ("needs_verification", "in_progress", "completed"):
        raise HTTPException(400, "status must be needs_verification, in_progress or completed")
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        require_member_read(cur, request, cid)
        cur.execute(
            """SELECT id, container_id, title, description, definition_of_done, status, result
                 FROM tasks WHERE container_id=%s AND status=%s AND NOT is_root
                ORDER BY priority ASC, created_at ASC LIMIT %s""",
            (cid, status, MAX_SUMMARIES),
        )
        tasks = [dict(r) for r in cur.fetchall()]
        out = {}
        for t in tasks:
            full, _pack, _ = _pack_response(cur, t, poll=False)
            out[str(t["id"])] = full["summary"]
        conn.commit()
    return {"container_id": cid, "status": status, "summaries": out}
