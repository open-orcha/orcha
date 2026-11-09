"""Orcha QA run tasks: every run is a task (migration 097; contract: docs/orcha-qa-plan.md, "Run
tasks: every run is a task").

A run task is a task created for QA work, marked by a `qa_runs` row whatever made it. When its run
ends the results go into `tasks.result` and a linked thread message, and the task stops at
needs_verification for a person. Only under `qa_settings.final_decision = quality`, and only when
`qa_final_decision.decide` finds nothing against it, does `_finish` complete anything.

The setting is read at the moment of each decision. Nothing here raises into what called it: the
transition that got us here has already happened.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
from typing import Any, Optional

from fastapi import HTTPException

from portal_backend import evidence_pack, qa_explorations as qx, qa_final_decision as fd, qa_handoff, qa_store as qs, qa_triage, sql
from portal_backend.agent_status import log_event, recompute_agent_status
from portal_backend.database import db_cursor
from portal_backend.event_acknowledgement import _ack_events_handled
from portal_backend.events import publish_event
from portal_backend.limits import MAX_NAME_LEN

logger = logging.getLogger(__name__)

SYSTEM_ACTOR = "system:qa"
ORIGINS = ("request", "workflow", "onboarding", "run_check", "exploration", "agent")
_DOD = {"map": "The map session ended and its result is in.", "explore": "The exploration ended and its result is in.",
        "draft": "The drafting session ended and its result is in.", "check": "The check ended and its result is in."}


# ---------------------------------------------------------------- the mark

def mark(cur, cid: str, tid: str, origin: str, *, kind: Optional[str] = None, platform: Optional[str] = None) -> None:
    """This task is a run task. A task keeps its first mark."""
    cur.execute("""INSERT INTO qa_runs (task_id, container_id, origin, kind, platform, created_at)
                   VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT (task_id) DO NOTHING""", (tid, cid, origin, kind, platform, qs.now()))


def origin_for(kind: Optional[str]) -> str:
    return "run_check" if kind == "check" else "exploration"


def run_of(cur, tid: str) -> Optional[dict]:
    cur.execute("SELECT * FROM qa_runs WHERE task_id=%s", (tid,))
    row = cur.fetchone()
    return dict(row) if row else None


def list_run_tasks(cur, cid: str, *, limit: int = 200) -> list[dict]:
    """Every run task of a project, newest first: what the Tasks list marks and filters by."""
    cur.execute("""SELECT q.task_id, q.origin, q.kind, q.platform, q.created_at, t.status, t.title
                     FROM qa_runs q JOIN tasks t ON t.id=q.task_id
                    WHERE q.container_id=%s ORDER BY q.created_at DESC LIMIT %s""", (cid, limit))
    return [{"task_id": str(r["task_id"]), "origin": r["origin"], "kind": r["kind"], "platform": r["platform"],
             "status": r["status"], "title": r["title"], "created_at": qs.iso(r["created_at"])} for r in cur.fetchall()]


# ---------------------------------------------------------------- which task a session belongs to

def current_task(cur, cid: str, agent_id: str, run_token: Optional[str]) -> Optional[str]:
    """The task this worker was woken for: its run's task, else the agent's task in progress, a run
    task first and the newest next."""
    def usable(tid: Any) -> Optional[str]:
        cur.execute("SELECT id FROM tasks WHERE id=%s AND container_id=%s AND status='in_progress' AND NOT is_root", (str(tid), cid))
        hit = cur.fetchone()
        return str(hit["id"]) if hit else None

    if run_token:
        cur.execute("""SELECT r.run_id, r.task_id FROM embodiment_tokens k JOIN worker_runs r ON r.run_id=k.run_id
                        WHERE k.run_token=%s AND k.agent_id=%s AND k.revoked_at IS NULL""", (run_token, agent_id))
        run = cur.fetchone()
        if run:
            cur.execute("SELECT task_id FROM worker_run_tasks WHERE run_id=%s", (str(run["run_id"]),))
            for tid in [run["task_id"], *[r["task_id"] for r in cur.fetchall()]]:
                if tid and (hit := usable(tid)):
                    return hit
    cur.execute("""SELECT t.id FROM agent_tasks x JOIN tasks t ON t.id=x.task_id LEFT JOIN qa_runs q ON q.task_id=t.id
                    WHERE x.agent_id=%s AND t.container_id=%s AND t.status='in_progress' AND NOT t.is_root
                      AND x.assignment_status<>'done'
                    ORDER BY CASE WHEN q.task_id IS NULL THEN 1 ELSE 0 END, x.assigned_at DESC LIMIT 1""", (agent_id, cid))
    row = cur.fetchone()
    return str(row["id"]) if row else None


def resolve_task(cid: str, who: dict, *, kind: str, platform: str, goal: Optional[str], run_token: Optional[str]) -> dict:
    """The task a session starts on: `{task_id, created}`. With none to go on, a run task for this
    work through the normal handler, already in this agent's hands: the worker asking is the one
    doing it, so nothing wakes a second one."""
    from portal_backend import task_creation_routes
    from portal_backend.schemas import TaskCreateBody

    with db_cursor(readonly=True) as (_, cur):
        tid = current_task(cur, cid, who["id"], run_token)
    if tid:
        return {"task_id": tid, "created": False}
    ai = who.get("kind") != "human"
    created = task_creation_routes.create_task(
        cid, TaskCreateBody(title=f"QA {kind}: {goal or platform}"[:MAX_NAME_LEN], description=f"A {kind} run on {platform}, started by {who['alias']}.",
                            definition_of_done=_DOD.get(kind, _DOD["check"]), created_by_agent_id=who["id"],
                            assignee_alias=who["alias"] if ai else None),
        qs.internal_request(),
    )
    tid = str(created["task_id"])
    with db_cursor() as (conn, cur):
        mark(cur, cid, tid, "agent", kind=kind, platform=platform)
        if ai:
            cur.execute("UPDATE agent_tasks SET assignment_status='working' WHERE task_id=%s AND agent_id=%s", (tid, who["id"]))
            _ack_events_handled(cur, who["id"], "task_assigned", "task_id", tid)
        conn.commit()
    return {"task_id": tid, "created": True}


# ---------------------------------------------------------------- who ran it

def _runs_of(cur, tid: str) -> list[dict]:
    cur.execute("""SELECT run_id, agent_id, status, total_cost_usd, started_at, ended_at FROM worker_runs
                    WHERE task_id=%s OR run_id IN (SELECT run_id FROM worker_run_tasks WHERE task_id=%s)
                    ORDER BY started_at""", (tid, tid))
    return [dict(r) for r in cur.fetchall()]


def _run_for(runs: list[dict], s: dict) -> Optional[dict]:
    """The worker run behind a session: its agent's newest run of the task that had started by the
    time the session did, else its agent's first."""
    mine = [r for r in runs if not s.get("agent_id") or str(r["agent_id"]) == str(s["agent_id"])]
    begun = qx._when(s.get("started_at"))
    before = [r for r in mine if begun and (t := qx._when(r.get("started_at"))) and t <= begun]
    return (before or mine or [None])[-1] if before else (mine[0] if mine else None)


def add_run_ids(cur, rows: list[dict]) -> None:
    """`run_id` on public session rows, in place."""
    sessions = [r for r in rows if "queued_at" in r]
    by_task: dict[str, list[dict]] = {}
    for r in sessions:
        tid = r.get("task_id")
        if tid and str(tid) not in by_task:
            by_task[str(tid)] = _runs_of(cur, str(tid))
        run = _run_for(by_task.get(str(tid), []), r) if tid else None
        r["run_id"] = str(run["run_id"]) if run else None


def session_cost(runs: list[dict]) -> Optional[float]:
    costs = [float(r["total_cost_usd"]) for r in runs if r.get("total_cost_usd")]
    return round(sum(costs), 4) if costs else None


def _seconds(s: dict) -> Optional[int]:
    begun, ended = qx._when(s.get("started_at")), qx._when(s.get("ended_at"))
    if not begun:
        return None
    return max(int(((ended or qx._when(qs.now())) - begun).total_seconds()), 0)


def _links(tid: str, sid: Optional[str], rid: Optional[str], alias: Optional[str], run_id: Optional[str]) -> dict:
    run = f"/qa?view=sessions&session={sid}" if sid else None
    return {"task": f"/tasks?task={tid}", "run": run, "replay": run, "findings": f"{run}#findings" if run else None,
            "request": f"/qa?view=requests&request={rid}" if rid else None,
            "worker_run": f"/agents?agent={alias}&changes={run_id}" if alias and run_id else f"/tasks?task={tid}&tab=runs",
            "activity_log": f"/api/qa/run-log?task_id={tid}" + (f"&session_id={sid}" if sid else "")}


# ---------------------------------------------------------------- the run result

def _outcome(cur, req: Optional[dict], sessions: list[dict]) -> tuple[Optional[str], Optional[str], dict]:
    """`(outcome, reason, result)`: passed, failed, blocked, stopped, running or None for no run yet."""
    newest = sessions[0] if sessions else None
    if any(s["status"] == "running" for s in sessions):
        return "running", None, {}
    if req and req["status"] in qa_handoff.FINISHED:
        return req["status"], None, qs._json(req.get("result"), None) or {}
    if req and req["status"] == "cancelled":
        result = qs._json(req.get("result"), None) or {}
        return "stopped", result.get("summary"), result
    if newest is None:
        return None, None, {}
    if newest["status"] in qx.STOPPED:
        return "stopped", qx.stop_reason(newest), {}
    if req:  # a triage run, whose result is its diagnoses: it ends with the task
        return "running", None, {}
    pseudo = {"id": None, "kind": newest["kind"], "platform": newest["platform"], "scenario_ids": [], "acceptance": []}
    status, result = qa_handoff.rollup(cur, pseudo, sessions=sessions)
    return status, None, result


def run_result(cur, tid: str) -> Optional[dict]:
    """What the task page's Run result card shows, computed from the run records. None for a task
    that is no run task and has no session."""
    run = run_of(cur, tid)
    cur.execute(f"SELECT * FROM qa_sessions WHERE task_id=%s AND {qs.STARTED_SQL} ORDER BY started_at DESC", (tid,))
    sessions = [dict(r) for r in cur.fetchall()]
    if run is None and not sessions:
        return None
    cur.execute("SELECT * FROM qa_requests WHERE qa_task_id=%s ORDER BY created_at DESC LIMIT 1", (tid,))
    hit = cur.fetchone()
    req = dict(hit) if hit else None
    outcome, reason, result = _outcome(cur, req, sessions)
    newest = sessions[0] if sessions else None
    sids = [str(s["id"]) for s in sessions]
    screens: list[str] = []
    drafts: list[dict] = []
    if sids:
        cond, param = sql.in_list("session_id"), (sql.list_param(sids),)
        cur.execute(f"SELECT DISTINCT screen_key FROM qa_steps WHERE {cond} AND screen_key IS NOT NULL", param)
        screens = sorted(r["screen_key"] for r in cur.fetchall())
        cur.execute(f"SELECT id, name, status FROM qa_scenarios WHERE {cond} ORDER BY created_at", param)
        drafts = [{"id": str(r["id"]), "name": r["name"], "status": r["status"]} for r in cur.fetchall()]
    runs = _runs_of(cur, tid)
    worker = _run_for(runs, newest) if newest else (runs[-1] if runs else None)
    alias = qa_handoff._alias(cur, newest.get("agent_id")) if newest else ""
    seconds = [x for x in map(_seconds, sessions) if x is not None]
    sid = str(newest["id"]) if newest else None
    run_id = str(worker["run_id"]) if worker else None
    cur.execute("SELECT status FROM tasks WHERE id=%s", (tid,))
    state = cur.fetchone()
    return {"task_id": tid, "is_run_task": run is not None, "origin": (run or {}).get("origin"),
            "task_cancelled": bool(state) and state["status"] == "cancelled",
            "kind": (req or {}).get("kind") or (newest or {}).get("kind") or (run or {}).get("kind"),
            "platform": (newest or {}).get("platform") or (req or {}).get("platform") or (run or {}).get("platform"),
            "outcome": outcome, "reason": reason, "summary": result.get("summary"), "request_id": str(req["id"]) if req else None,
            "scenarios": result.get("scenarios") or [], "lines": result.get("lines") or [], "findings": result.get("findings") or [],
            "diagnoses": result.get("diagnoses") or [], "drafts": drafts, "screens_reached": len(screens), "screens": screens[:50],
            "duration_seconds": sum(seconds) if seconds else None, "cost_usd": session_cost(runs),
            "device": {"name": newest.get("device_name"), "udid": newest.get("device_udid")} if newest else None,
            "build": newest.get("build_label") if newest else None, "app_id": newest.get("app_id") if newest else None,
            "agent": {"id": str(newest["agent_id"]), "alias": alias} if newest and newest.get("agent_id") else None,
            "worker_run": {"run_id": run_id, "status": worker["status"]} if worker else None, "session_id": sid, "session_ids": sids,
            "links": _links(tid, sid, str(req["id"]) if req else None, alias or None, run_id)}


def _thread_body(out: dict) -> str:
    who = (out.get("agent") or {}).get("alias")
    if out["outcome"] == "stopped":
        # A person's Stop cancels the run's task; a run that died leaves it open for Run again.
        stays = "" if out.get("task_cancelled") else " This task stays open."
        lines = [f"[Run stopped] {out.get('reason') or 'It stopped before it finished.'}{stays}"]
    else:
        lines = [f"[Run result] {out.get('summary') or out['outcome']}"]
        lines += [f"- [{f['severity']}] {f['title']}" for f in out["findings"][:10]]
    facts = [f"{out['screens_reached']} screens" if out["screens_reached"] else None,
             f"{round(out['duration_seconds'] / 60, 1)} min" if out.get("duration_seconds") is not None else None,
             (out.get("device") or {}).get("name"), out.get("build"), who]
    said = [str(x) for x in facts if x]
    if said:
        lines.append(" · ".join(said))
    if out["links"].get("run"):
        lines.append(f"Run: {out['links']['run']}")
    return "\n".join(lines)


def _write(cur, tid: str, out: dict) -> None:
    """Into `tasks.result`, beside what the agent wrote: `result` stays the text every reader reads."""
    cur.execute("SELECT result, status FROM tasks WHERE id=%s", (tid,))
    row = cur.fetchone()
    if row["status"] in ("completed", "cancelled"):
        return
    now = qs._json(row["result"], None)
    base = now if isinstance(now, dict) else ({"result": now} if now else {})
    cur.execute("UPDATE tasks SET result=%s WHERE id=%s",
                (json.dumps({**base, "result": base.get("result") or out.get("summary") or out.get("reason"), "qa_run": out}, default=str), tid))


def record(cur, tid: str) -> Optional[dict]:
    """A run task's run ended: its result goes into the task, and once per session onto its thread
    (a workflow step's and a source task's thread hear it from the return path)."""
    run = run_of(cur, tid)
    if run is None:
        return None
    out = run_result(cur, tid)
    if not out or out["outcome"] in (None, "running"):
        return out
    _write(cur, tid, out)
    if run["origin"] == "workflow" or (run.get("result_session_id") and str(run["result_session_id"]) == str(out["session_id"])):
        return out
    body = _thread_body(out)
    cid = str(run["container_id"])
    author = (out.get("agent") or {}).get("id")
    cur.execute("INSERT INTO task_messages (task_id, author_id, body) VALUES (%s,%s,%s) RETURNING id", (tid, author, body))
    log_event(cur, cid, "ai" if author else "system", author, "task", tid, "message",
              {"message_id": str(cur.fetchone()["id"]), "preview": body[:120]})
    log_event(cur, cid, "system", None, "task", tid, "qa_run_ended", {"outcome": out["outcome"], "session_id": out["session_id"], "reason": out.get("reason")})
    cur.execute("UPDATE qa_runs SET result_session_id=%s WHERE task_id=%s", (out["session_id"], tid))
    return out


def after_session_end(sid: str) -> None:
    """A session ended, well or not. After every other hook of its end, and it never raises."""
    try:
        with db_cursor() as (conn, cur):
            s = qs.load_session(cur, sid)
            tid = str(s["task_id"]) if s.get("task_id") else None
            if tid:
                record(cur, tid)
                conn.commit()
        if tid and s["status"] == "done":
            qa_handoff._later(consider, tid)
    except Exception:  # noqa: BLE001 - the session already ended
        logger.exception("Run result failed for session %s", sid)


def after_task_done(tid: str) -> None:
    """The agent finished a task: the agent's text is on it now, so the run result goes back beside
    it. Never raises."""
    try:
        with db_cursor() as (conn, cur):
            record(cur, tid)
            conn.commit()
    except Exception:  # noqa: BLE001 - the transition already happened
        logger.exception("Run result failed for task %s", tid)


# ---------------------------------------------------------------- the facts behind a decision

def authors_of(cur, task: dict) -> set[str]:
    """Who did this work. A QA step only tests: its work is the steps before it."""
    tid = str(task["id"])
    ids = {tid}
    if task.get("qa_step"):
        ids, frontier = set(), [tid]
        while frontier:
            cur.execute(f"SELECT depends_on_id FROM task_dependencies WHERE {sql.in_list('task_id')}", (sql.list_param(frontier),))
            frontier = [str(r["depends_on_id"]) for r in cur.fetchall() if str(r["depends_on_id"]) not in ids]
            ids.update(frontier)
    out: set[str] = set()
    for one in ids:
        cur.execute("""SELECT x.agent_id FROM agent_tasks x JOIN agents a ON a.id=x.agent_id WHERE x.task_id=%s AND a.kind='ai'""", (one,))
        out.update(str(r["agent_id"]) for r in cur.fetchall())
        out.update(str(r["agent_id"]) for r in _runs_of(cur, one))
    return out


def _finished_at(cur, tid: str) -> Optional[dt.datetime]:
    """When the task last reached needs_verification."""
    cur.execute("""SELECT created_at, detail FROM events WHERE entity_type='task' AND entity_id=%s AND event_type='status_changed'
                    ORDER BY created_at DESC LIMIT 20""", (tid,))
    for r in cur.fetchall():
        if (qs._json(r["detail"], None) or {}).get("to") == "needs_verification":
            return qx._when(r["created_at"])
    return None


def _run_facts(cur, task: dict) -> dict:
    """What the runs of this task's current round say, for `qa_final_decision`."""
    tid = str(task["id"])
    start = evidence_pack._round_start(cur, tid)
    cur.execute(f"""SELECT * FROM qa_requests WHERE (source_task_id=%s OR qa_task_id=%s)
                      AND ({sql.ts_param()} IS NULL OR created_at >= {sql.ts_param()}) ORDER BY created_at""", (tid, tid, start, start))
    requests = [dict(r) for r in cur.fetchall()]
    if task.get("workflow_id"):  # a repeat round is a new work revision of the same step
        requests = [r for r in requests if r.get("source_work_revision") == task.get("work_revision")]
    cur.execute(f"""SELECT * FROM qa_sessions WHERE task_id=%s AND ({sql.ts_param()} IS NULL OR started_at >= {sql.ts_param()})
                     ORDER BY started_at""", (tid, start, start))
    sessions = {str(r["id"]): dict(r) for r in cur.fetchall()}
    for r in requests:
        cur.execute("SELECT * FROM qa_sessions WHERE request_id=%s ORDER BY started_at", (str(r["id"]),))
        sessions.update({str(s["id"]): dict(s) for s in cur.fetchall()})
    groups: dict[str, list[dict]] = {}
    for s in sessions.values():
        groups.setdefault(str(s.get("request_id") or "own"), []).append(s)
    newest = [max(g, key=lambda s: qx._when(s.get("started_at")) or dt.datetime.min.replace(tzinfo=dt.timezone.utc)) for g in groups.values()]
    f: dict[str, Any] = {"open_runs": sum(1 for s in sessions.values() if s["status"] == "running") + sum(1 for r in requests if r["status"] in qa_handoff.OPEN),
                         "stopped": [qx.stop_reason(s) for s in newest if s["status"] in qx.STOPPED and s["status"] != "running"],
                         "blocked": sum(1 for r in requests if r["status"] == "blocked"),
                         "failed": sum(1 for r in requests if r["status"] == "failed"),
                         "inconclusive": 0, "unjudged": 0, "drafts": 0, "proved_nothing": 0, "findings": []}
    f["stopped"] += [(qs._json(r.get("result"), None) or {}).get("summary") or "It was cancelled." for r in requests if r["status"] == "cancelled"]
    own = groups.get("own") or []
    results = [(r["kind"], qs._json(r.get("result"), None) or {}) for r in requests if r["status"] in qa_handoff.FINISHED]
    if own and not any(s["status"] == "running" for s in own):
        pseudo = {"id": None, "kind": own[0]["kind"], "platform": own[0]["platform"], "scenario_ids": [], "acceptance": []}
        status, result = qa_handoff.rollup(cur, pseudo, sessions=own)
        f["failed"] += status == "failed"
        f["blocked"] += status == "blocked" and not f["stopped"]
        results.append((own[0]["kind"], result))
    for kind, result in results:
        lines, scenarios = result.get("lines") or [], result.get("scenarios") or []
        f["inconclusive"] += sum(1 for x in [*lines, *scenarios] if x.get("verdict") in ("blocked", "inconclusive"))
        f["unjudged"] += sum(1 for x in [*lines, *scenarios] if not x.get("verdict"))
        if kind == "check" and not any(x.get("verdict") == "pass" for x in [*scenarios, *lines]):
            f["proved_nothing"] += 1
    sids = list(sessions)
    cond = f"(task_id=%s OR {sql.in_list('session_id')})" if sids else "task_id=%s"
    param = (tid, sql.list_param(sids)) if sids else (tid,)
    cur.execute(f"SELECT count(*) AS n FROM qa_scenarios WHERE {cond} AND status='draft'", param)
    f["drafts"] = int(cur.fetchone()["n"] or 0)
    cur.execute(f"SELECT id, severity, title, triage FROM qa_findings WHERE {cond} AND status<>'dismissed'", param)
    f["findings"] = [{"id": str(r["id"]), "severity": r["severity"], "title": r["title"]} for r in map(dict, cur.fetchall())
                     if r["severity"] in qa_handoff.FAILING_SEVERITIES and qa_triage.counts_against_gate(r)]
    f["session_agents"] = {str(s["agent_id"]) for s in sessions.values() if s.get("agent_id")}
    f["requests"] = requests
    return f


def _stale_requests(cur, task: dict, requests: list[dict]) -> list[str]:
    """QA proof from before the work finished says nothing about what was finished."""
    done = None if task.get("workflow_id") else _finished_at(cur, str(task["id"]))
    if done is None:
        return []
    return [str(r["id"]) for r in requests if (t := qx._when(r.get("finished_at"))) and t < done]


def _tests_stale(cur, task: dict, pack: dict) -> bool:
    """A workflow step's repeat round reruns the same task: only this revision's tests count."""
    if not task.get("workflow_id"):
        return False
    cur.execute("SELECT run_id FROM workflow_executions WHERE task_id=%s AND work_revision=%s", (str(task["id"]), task["work_revision"]))
    current = {str(r["run_id"]) for r in cur.fetchall() if r["run_id"]}
    return any(str(i.get("run_id")) not in current for i in (pack.get("tests") or {}).get("latest") or [])


def _no_outcome(cur, task: dict) -> bool:
    tid = str(task["id"])
    cur.execute("SELECT 1 AS hit FROM workflow_step_outcomes WHERE task_id=%s LIMIT 1", (tid,))
    if not task.get("workflow_id") or not cur.fetchone():
        return False
    cur.execute("SELECT 1 AS hit FROM workflow_outcome_reports WHERE task_id=%s AND work_revision=%s LIMIT 1", (tid, task["work_revision"]))
    return cur.fetchone() is None


def _person(cur, conf: dict) -> Optional[dict]:
    """The current person who let Quality decide."""
    who = qa_handoff._who(cur, conf.get("final_decision_by_agent_id"))
    return who if who and who["kind"] == "human" else None


def facts_for(cur, task: dict, conf: dict, subject: str, pack: Optional[dict]) -> dict:
    f = _run_facts(cur, task)
    person = _person(cur, conf)
    authors = authors_of(cur, task)
    f.update(setting=conf["final_decision"], subject=subject, pack=pack, authors=authors, turned_on_by=person["id"] if person else None,
             no_outcome=_no_outcome(cur, task), stale_requests=_stale_requests(cur, task, f["requests"]),
             tests_stale=bool(pack) and _tests_stale(cur, task, pack), tester=bool(task.get("qa_step")))
    if subject == "work":
        f["own_check"] = bool(f["session_agents"] & authors)
    if pack:
        ids = [i["qa_session_id"] for i in (pack.get("dod") or {}).get("items") or [] if i.get("qa_session_id")]
        f["verdict_agents"] = {}
        for sid in dict.fromkeys(ids):
            cur.execute("SELECT agent_id FROM qa_sessions WHERE id=%s", (sid,))
            hit = cur.fetchone()
            if hit and hit["agent_id"]:
                f["verdict_agents"][sid] = str(hit["agent_id"])
    return f


def sends_back(cur, req: dict, source: dict, result: dict) -> bool:
    """A failed run outside a workflow goes back to its agent under `quality`, as `on_fail=reopen`
    does. `req` is the just-finished request. Read at the moment of the decision."""
    conf = qa_handoff.settings(cur, str(req["container_id"]))
    if conf["final_decision"] != fd.QUALITY:
        return False
    return fd.send_back(facts_for(cur, source, conf, "work", None))


def _pack_of(tid: str) -> Optional[dict]:
    """The task's evidence pack, built now if it has none: a workflow step never gets one from
    /done. With none to be had the rule stays blind, so `decide` hands the task to a person. Before
    the decision's write transaction: a pack reads git."""
    try:
        with db_cursor(readonly=True) as (_, cur):
            task = evidence_pack._load_task(cur, tid)
        return evidence_pack.fresh_pack(task, reason="final_decision")[0] if task else None
    except Exception:  # noqa: BLE001
        logger.exception("No evidence pack for task %s", tid)
        return None


# ---------------------------------------------------------------- deciding

def _record_decision(cur, task: dict, conf: dict, subject: str, decision: str, verdict: dict) -> None:
    person = qa_handoff._who(cur, conf.get("final_decision_by_agent_id"))
    cur.execute("""INSERT INTO qa_final_decisions (id, container_id, task_id, subject, decision, setting, turned_on_by_agent_id,
                                                   turned_on_by_alias, turned_on_at, reasons, lines, created_at)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (qs.new_id(), str(task["container_id"]), str(task["id"]), subject, decision, conf["final_decision"],
                 person["id"] if person else None, person["alias"] if person else None, conf.get("final_decision_at"),
                 qs.dumps(verdict["reasons"]), qs.dumps(verdict["lines"]), qs.now()))


def latest_decision(cur, tid: str) -> Optional[dict]:
    """What the last decision under `quality` said about this task, or None."""
    cur.execute("SELECT * FROM qa_final_decisions WHERE task_id=%s ORDER BY created_at DESC LIMIT 1", (tid,))
    r = cur.fetchone()
    if not r:
        return None
    return {"decision": r["decision"], "subject": r["subject"], "setting": r["setting"], "actor": SYSTEM_ACTOR,
            "turned_on_by_agent_id": str(r["turned_on_by_agent_id"]) if r["turned_on_by_agent_id"] else None,
            "turned_on_by_alias": r["turned_on_by_alias"], "turned_on_at": qs.iso(r["turned_on_at"]),
            "reasons": qs._json(r["reasons"], []), "lines": qs._json(r["lines"], []), "at": qs.iso(r["created_at"])}


def _refuse(cur, task: dict, conf: dict, subject: str, verdict: dict) -> None:
    """It stays at needs_verification for a person, who sees why. Said once for the same reasons."""
    tid, cid = str(task["id"]), str(task["container_id"])
    before = latest_decision(cur, tid)
    if before and before["decision"] == "person" and [r["code"] for r in before["reasons"]] == [r["code"] for r in verdict["reasons"]]:
        return
    _record_decision(cur, task, conf, subject, "person", verdict)
    lines = ["[Needs a person] Quality did not finish this task:"] + [f"- {r['text']}" for r in verdict["reasons"]]
    lines += [f"  Line {x['index'] + 1}: {x['text']} ({x['why_text']})" for x in verdict["lines"][:20]]
    cur.execute("INSERT INTO task_messages (task_id, author_id, body) VALUES (%s,NULL,%s)", (tid, "\n".join(lines)))
    log_event(cur, cid, "system", None, "task", tid, "qa_final_decision",
              {"actor": SYSTEM_ACTOR, "decision": "person", "codes": [r["code"] for r in verdict["reasons"]]})


def _accept_step(cur, task: dict, person: dict, *, decided: str) -> None:
    """A step's acceptance through the workflow's own path, so its evidence, review and routing
    rules all hold. `workflow_task_acceptances` admits a person or an agent, so the row names the
    person whose setting this is, with acceptance_source `qa_final_decision`, and the audit says
    `system:qa` decided."""
    from portal_backend.workflow_evidence_service import evidence_reference
    from portal_backend.workflow_integration import IntegratedWorkflowHooks
    from portal_backend.workflow_service import WorkflowActor, WorkflowService

    tid, wid = str(task["id"]), str(task["workflow_id"])
    cur.execute("""SELECT current_evidence_set_id FROM workflow_executions WHERE task_id=%s AND work_revision=%s
                     AND current_evidence_set_id IS NOT NULL ORDER BY generation DESC LIMIT 1""", (tid, task["work_revision"]))
    execution = cur.fetchone()
    if not execution:
        raise HTTPException(409, {"code": "evidence_missing", "message": "This step has no saved evidence."})
    svc = WorkflowService(cur, IntegratedWorkflowHooks())
    svc.mutate(str(task["container_id"]), WorkflowActor(person["id"], True), "accept",
               {"expected_revision": svc.workflow(wid)["revision"], "expected_work_revision": task["work_revision"],
                "idempotency_key": f"qa-final-{tid}-{task['work_revision']}", "qa_final_decision": decided,
                "evidence": evidence_reference(cur, execution["current_evidence_set_id"])}, wid=wid, tid=tid)


def _finish(cur, task: dict, conf: dict, person: dict, subject: str, verdict: dict) -> None:
    """Complete a task that `qa_final_decision.decide` found nothing against.

    OWNER-APPROVED EXCEPTION to "agent work stops at needs_verification; a human verifies": a person
    set `final_decision = quality` for this project (only a person can, and it is logged). This is
    the one code path that completes work without a person's click; the actor is `system:qa`, and
    the approval row and `qa_final_decisions` name the setting and who turned it on. Anything else
    that a task needs from a person goes through `_refuse` instead.
    """
    from portal_backend.review_routing import supersede_pending_prereview
    from portal_backend.task_approval_policy import ApprovalPhase
    from portal_backend.task_autonomy_service import completion_submission, record_approval
    from portal_backend.task_completion_support import _complete_and_unblock

    tid, cid = str(task["id"]), str(task["container_id"])
    unblocked: list = []
    if task.get("workflow_id"):
        _accept_step(cur, task, person, decided="finished")
    else:
        supersede_pending_prereview(cur, cid, tid, reason="qa_final_decision")
        record_approval(cur, task, person["id"], ApprovalPhase.COMPLETION, completion_submission(task),
                        human_review_authorized=True, permission_source="qa_final_decision")
        unblocked = _complete_and_unblock(cur, cid, tid)
    _record_decision(cur, task, conf, subject, "finished", verdict)
    cur.execute("SELECT DISTINCT agent_id FROM agent_tasks WHERE task_id=%s", (tid,))
    assignees = [str(r["agent_id"]) for r in cur.fetchall()]
    for aid in assignees:
        recompute_agent_status(cur, aid)
        publish_event(cur, cid, aid, "task_verified", {"task_id": tid, "approved": True, "feedback": None, "by": SYSTEM_ACTOR})
    words = f"[Finished by itself] Every line is proven. {person['alias']} let work finish by itself in this project."
    cur.execute("INSERT INTO task_messages (task_id, author_id, body) VALUES (%s,NULL,%s)", (tid, words))
    log_event(cur, cid, "system", None, "task", tid, "status_changed",
              {"to": "completed", "actor": SYSTEM_ACTOR, "final_decision": fd.QUALITY, "turned_on_by": person["id"],
               "turned_on_by_alias": person["alias"], "turned_on_at": qs.iso(conf.get("final_decision_at")), "unblocked": unblocked})
    for who in qa_handoff._people(cur, {"requested_by_agent_id": None, "container_id": cid}, task):
        publish_event(cur, cid, who, "qa_result", {"task_id": tid, "request_id": None, "status": "passed", "round": 1, "reopened": False,
                                                   "preview": f"Finished by itself: {task['title']}"[:200]})


def _waiting(task: Optional[dict], conf: dict, stopped: bool) -> bool:
    """This task is ready for its decision. A workflow step's evidence is saved once its worker
    stops; it comes back then."""
    return bool(task and conf["final_decision"] == fd.QUALITY and task["status"] == "needs_verification" and not task["is_root"]
                and (stopped or not task.get("workflow_id")))


def _decide_one(tid: str, stopped: bool) -> None:
    with db_cursor(readonly=True) as (_, cur):
        cur.execute("SELECT * FROM tasks WHERE id=%s", (tid,))
        hit = cur.fetchone()
        if not hit or not _waiting(dict(hit), qa_handoff.settings(cur, str(hit["container_id"])), stopped):
            return
        run = run_of(cur, tid)
    subject = "run" if run and run["origin"] != "workflow" else "work"
    pack = _pack_of(tid) if subject == "work" else None
    with db_cursor() as (conn, cur):
        cur.execute("SELECT * FROM tasks WHERE id=%s" + sql.for_update(), (tid,))
        task = dict(cur.fetchone())
        conf = qa_handoff.settings(cur, str(task["container_id"]))
        if not _waiting(task, conf, stopped):  # it moved, or the setting did, while the pack was built
            return
        facts = facts_for(cur, task, conf, subject, pack)
        verdict = fd.decide(facts)
        if any(r["code"] == "run_open" for r in verdict["reasons"]):
            return  # nothing is decided while its run goes; the run's end comes back here
        person = _person(cur, conf)
        try:
            if verdict["finish"]:
                _finish(cur, task, conf, person, subject, verdict)
            elif task.get("workflow_id") and fd.send_back(facts) and not task.get("awaiting_loop_decision"):
                _accept_step(cur, task, person, decided="sent_back")
                _record_decision(cur, task, conf, subject, "sent_back", verdict)
            else:
                _refuse(cur, task, conf, subject, verdict)
                conn.commit()
                return
            conn.commit()
            return
        except HTTPException as e:
            refused = e.detail.get("message") if isinstance(e.detail, dict) else str(e.detail)
            conn.rollback()
    with db_cursor() as (conn, cur):  # the workflow's own rules said no: a person takes it from here
        verdict = {"finish": False, "lines": verdict["lines"], "reasons": [*verdict["reasons"], {"code": "acceptance_refused", "text": refused}]}
        _refuse(cur, task, conf, subject, verdict)
        conn.commit()


def consider(tid: str, *, stopped: bool = False) -> None:
    """A task may be ready for its final decision: it reached needs_verification, its run ended or
    its step's worker stopped. A run task's source is looked at with it. Costs one read under
    `person`. Never raises."""
    try:
        with db_cursor(readonly=True) as (_, cur):
            cur.execute("""SELECT q.final_decision, t.id FROM tasks t LEFT JOIN qa_settings q ON q.container_id=t.container_id
                            WHERE t.id=%s""", (tid,))
            row = cur.fetchone()
            if not row or row["final_decision"] != fd.QUALITY:
                return
            cur.execute("SELECT DISTINCT source_task_id FROM qa_requests WHERE qa_task_id=%s AND source_task_id IS NOT NULL", (tid,))
            ids = list(dict.fromkeys([tid, *[str(r["source_task_id"]) for r in cur.fetchall()]]))
        for one in ids:
            _decide_one(one, stopped)
    except Exception:  # noqa: BLE001 - the transition already happened
        logger.exception("Final decision failed for task %s", tid)


# ---------------------------------------------------------------- who did it

def agent_runs(cur, aid: str, *, limit: int = 50) -> dict:
    """An agent's Quality runs, newest first, with outcome, cost, time and where to look."""
    cur.execute("SELECT alias FROM agents WHERE id=%s", (aid,))
    alias = cur.fetchone()["alias"]
    cur.execute(f"SELECT * FROM qa_sessions WHERE agent_id=%s AND {qs.STARTED_SQL} ORDER BY started_at DESC LIMIT %s", (aid, limit))
    rows, spent = [], {}
    for s in map(dict, cur.fetchall()):
        tid = str(s["task_id"]) if s.get("task_id") else None
        runs = [r for r in _runs_of(cur, tid) if str(r["agent_id"]) == aid] if tid else []
        run = _run_for(runs, s)
        title = None
        if tid:
            cur.execute("SELECT title FROM tasks WHERE id=%s", (tid,))
            hit = cur.fetchone()
            title = hit["title"] if hit else None
            spent[tid] = session_cost(runs)
        req = None
        if s.get("request_id"):
            cur.execute("SELECT status FROM qa_requests WHERE id=%s", (str(s["request_id"]),))
            req = cur.fetchone()
        outcome = req["status"] if req and req["status"] in qa_handoff.FINISHED else ("stopped" if s["status"] in qx.STOPPED else ("running" if s["status"] == "running" else "ended"))
        run_id = str(run["run_id"]) if run else None
        rows.append({"session_id": str(s["id"]), "task_id": tid, "task_title": title, "kind": s["kind"], "platform": s["platform"],
                     "status": s["status"], "outcome": outcome, "stop_reason": qx.stop_reason(s), "request_id": str(s["request_id"]) if s.get("request_id") else None,
                     "run_id": run_id, "cost_usd": session_cost(runs), "duration_seconds": _seconds(s), "device_name": s.get("device_name"),
                     "build": s.get("build_label"), "started_at": qs.iso(s.get("started_at")), "ended_at": qs.iso(s.get("ended_at")),
                     "links": _links(tid or "", str(s["id"]), str(s["request_id"]) if s.get("request_id") else None, alias, run_id)})
    costs = [c for c in spent.values() if c]
    return {"agent_id": aid, "agent_alias": alias, "runs": rows,
            "totals": {"runs": len(rows), "cost_usd": round(sum(costs), 4) if costs else None,
                       "duration_seconds": sum(r["duration_seconds"] or 0 for r in rows)}}


def metrics(cur, cid: str, since: Any) -> dict:
    """QA's share of the project's Metrics, in the window. Its cost is already in the totals: every
    worker run counts there. A task a person never verified is not `tasks_verified`."""
    cur.execute(f"SELECT status, started_at, ended_at, agent_id FROM qa_sessions WHERE container_id=%s AND started_at>=%s AND {qs.STARTED_SQL}", (cid, since))
    sessions = [dict(r) for r in cur.fetchall()]
    cur.execute("""SELECT sum(total_cost_usd) AS cost FROM worker_runs WHERE started_at>=%s AND total_cost_usd>0
                     AND (task_id IN (SELECT task_id FROM qa_runs WHERE container_id=%s)
                          OR run_id IN (SELECT w.run_id FROM worker_run_tasks w JOIN qa_runs q ON q.task_id=w.task_id WHERE q.container_id=%s))""",
                (since, cid, cid))
    cost = cur.fetchone()["cost"]
    return {"runs": len(sessions), "stopped": sum(1 for s in sessions if s["status"] in qx.STOPPED),
            "seconds": sum(_seconds(s) or 0 for s in sessions if s["status"] != "running"), "cost_usd": round(float(cost), 4) if cost else 0.0}
