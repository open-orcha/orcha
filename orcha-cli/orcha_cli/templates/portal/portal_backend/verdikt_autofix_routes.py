"""Verdikt auto-fix loop routes (mig 068; the loop itself is verdikt_autofix).

  GET  /api/tasks/{tid}/verdikt/autofix        — the task's auto-fix state: whether it applies
                                                 (and why), the override, the latest loop with
                                                 its attempts (members read)
  PUT  /api/tasks/{tid}/verdikt/autofix        — per-task override on / off / inherit
                                                 (owner or manage_repo, like the Verdikt settings)
  POST /api/tasks/{tid}/verdikt/autofix/stop   — Stop auto-fix: end the running loop now
                                                 (a human member; the task stays where it is)
  POST /api/containers/{cid}/verdikt/sweep     — the background check: refresh the project's
                                                 in-flight Verdikt runs and apply the loop to
                                                 finished ones. Idempotent. Called by the host
                                                 notifier while runs are in flight (machine
                                                 lane: header-less, or a non-viewer member with
                                                 manage_repo); the portal also runs it on a timer.

The project settings (on/off, max attempts) live on PUT /api/containers/{cid}/verdikt.
"""

from __future__ import annotations

from typing import Literal, Optional

from fastapi import HTTPException, Request
from pydantic import BaseModel, Field

from portal_backend import verdikt_autofix as vaf
from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container
from portal_backend.identity_routes import require_grant, require_machine_lane_member, require_member_read
from portal_backend.verdikt_routes import _cid, _human, _load_task


class AutofixOverrideBody(BaseModel):
    actor_agent_id: Optional[str] = None
    mode: Literal["inherit", "on", "off"] = Field(
        description="'on' / 'off' override the project's auto-fix setting for this task; 'inherit' follows "
                    "it. Either way auto-fix only runs while Verdikt runs automatically (ui_changes / always).")


class AutofixActorBody(BaseModel):
    actor_agent_id: Optional[str] = None


@app.get("/api/tasks/{tid}/verdikt/autofix")
def get_verdikt_autofix(tid: str, request: Request):
    """{task_id, effective, why, override: inherit|on|off, project{enabled, max_attempts, applies},
    loop: {id, status: running|stopped, max_attempts, attempts_made, current_attempt, stop_kind,
    stop_label, stop_reason, stopped_by, started_at, stopped_at, attempts[{attempt, outcome, action:
    reworked|stopped|passed, verdikt_run, report_url, open_url, failed[{text, expected, actual}],
    changes{summary, files, href}, created_at}]} | null}."""
    with db_cursor() as (_, cur):
        task = _load_task(cur, tid)
        require_member_read(cur, request, str(task["container_id"]))
        return vaf.state(cur, task)


@app.put("/api/tasks/{tid}/verdikt/autofix")
def put_verdikt_autofix(tid: str, body: AutofixOverrideBody, request: Request):
    """Set the task's override. Turning it off ends a running loop (recorded as turned off)."""
    with db_cursor() as (conn, cur):
        task = _load_task(cur, tid)
        cid = str(task["container_id"])
        member = require_grant(cur, request, cid, body.actor_agent_id, "manage_repo")
        actor = str(member["id"])
        if body.mode == "inherit":
            cur.execute("DELETE FROM verdikt_task_autofix WHERE task_id=%s", (tid,))
        else:
            cur.execute(
                """INSERT INTO verdikt_task_autofix (task_id, container_id, mode, updated_by, updated_at)
                   VALUES (%s, %s, %s, %s, now())
                   ON CONFLICT (task_id) DO UPDATE SET mode=EXCLUDED.mode, updated_by=EXCLUDED.updated_by,
                                                       updated_at=now()""",
                (tid, cid, body.mode, actor),
            )
        log_event(cur, cid, "human", actor, "task", tid, "verdikt_autofix_override", {"mode": body.mode})
        vaf.stop_where_off(cur, cid, actor, tid=tid)
        out = vaf.state(cur, task)
        conn.commit()
    return out


@app.post("/api/tasks/{tid}/verdikt/autofix/stop")
def stop_verdikt_autofix(tid: str, body: AutofixActorBody, request: Request):
    """Stop auto-fix: the running loop ends now (409 when none runs). Nothing else changes — the
    task stays where it is (an agent mid-rework finishes and hands it back for a person)."""
    with db_cursor() as (conn, cur):
        task = _load_task(cur, tid)
        actor = _human(cur, request, str(task["container_id"]), body.actor_agent_id)
        cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ("verdikt-autofix:" + tid,))
        if not vaf.stop_by_person(cur, task, actor):
            raise HTTPException(409, "auto-fix isn't running for this task")
        out = vaf.state(cur, task)
        conn.commit()
    return out


@app.post("/api/containers/{cid}/verdikt/sweep")
def sweep_verdikt(cid: str, request: Request):
    """{in_flight, loops_running, refreshed, judged}: refresh the project's in-flight Verdikt runs
    (each at most every few seconds) and apply the auto-fix loop to finished ones. Idempotent —
    the same finished run is judged once, however many callers ask."""
    _cid(cid)
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        require_machine_lane_member(cur, request, cid, "manage_repo")
    return vaf.sweep(cid)
