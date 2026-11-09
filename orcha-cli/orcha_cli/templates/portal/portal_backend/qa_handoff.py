"""Orcha QA handoff: requests, the rollup and the return path (migration 096; contract:
docs/orcha-qa-plan.md, "Handoff and workflow integration").

A request is the handoff record: what was asked of QA, where it came from and what came back.
`hand_off` files one and creates its linked task through the normal handler. `activate_step` does
the same for a workflow QA step, whose own task is both the source and the QA task. When the QA
task reaches needs_verification, or its session ends, `finish` rolls the verdicts up and runs the
return path: a linked summary on the source task's thread, a wake for its agent, an event and a
notification (category `qa`), and for `on_fail=reopen` with rounds left the source task goes back
to in_progress. A workflow QA step reports its outcome through the existing outcome path instead.

A QA result is evidence. Nothing here records an acceptance or a completion approval, or sets a task
to completed: a person, or the task's own approval rule, still decides, and `qa_run_tasks` is the
one place that can finish work, under the project's `final_decision` setting. What a person's click
does approve is the *plan* of the QA run they asked for (`approve_plan`): the agent then goes straight
on. Task autonomy stays off, so the finished work still stops at needs_verification.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
from typing import Any, Callable, Iterable, Optional

from fastapi import HTTPException

from portal_backend import evidence_parse as ep
from portal_backend import qa_conditions
from portal_backend import qa_store as qs
from portal_backend import qa_triage
from portal_backend import sql
from portal_backend.agent_status import log_event, recompute_agent_status
from portal_backend.database import db_cursor
from portal_backend.events import publish_event
from portal_backend.limits import MAX_DESC_LEN, MAX_DOD_LEN, MAX_NAME_LEN

logger = logging.getLogger(__name__)

KINDS = (*qs.SESSION_KINDS, "triage")
OPEN = ("requested", "running")
FINISHED = ("passed", "failed", "blocked")
ON_FAIL = ("report", "reopen")
TRIGGERS = ("manual", "ui_changes", "always")
DEFAULT_MAX_ROUNDS = 3
SKILLS = {"map": "/orcha-qa-map", "explore": "/orcha-qa-explore", "draft": "/orcha-qa-draft", "check": "/orcha-qa-check",
          "triage": "/orcha-qa-triage"}
#: A finding this severe fails the request, as `orcha-qa-explore` reports it.
FAILING_SEVERITIES = ("blocker", "major")
SEVERITY_ORDER = {"blocker": 0, "major": 1, "minor": 2, "trivial": 3}
#: Workflow findings have their own scale (schemas.workflows.Finding).
OUTCOME_SEVERITY = {"blocker": "blocker", "major": "major", "minor": "minor", "trivial": "note"}
OUTCOME_FINDINGS_MAX = 50
OUTCOME_TEXT_MAX = 3900
VERDICT_ORDER = qs.VERDICT_ORDER
_WARNING = re.compile(r"\[warning\]\s*$", re.IGNORECASE)
_QA_ROLE = re.compile(r"\bqa\b|\bquality\b|\btester\b|\btesting\b", re.IGNORECASE)
_COMMIT = re.compile(r"\b(?:commit|sha)\b(?:\s+(?:is|at|hash))*[:\s`]+([0-9a-f]{7,40})\b", re.IGNORECASE)
_URL = re.compile(r"https?://[^\s'\"<>)\]]+")
_PLATFORM_WORD = {"ios": "iOS", "android": "Android", "web": "Web"}
#: What a person's click writes on a task it creates, and the thread's decision reason.
PERSON_RUN = ("{who} started this run. That is the approval of your plan: go straight on, and do not "
              "stop to ask for plan approval. The finished work still waits for a person to verify it.")

#: The trigger's slow branch reads git; a test turns this off to run it in line.
BACKGROUND = True


def person_run_line(who: str) -> str:
    return PERSON_RUN.format(who=who or "A person")


# ---------------------------------------------------------------- settings

def _role_agent(cur, cid: str) -> Optional[dict]:
    """The agent whose role says QA, else the one named so."""
    cur.execute("SELECT id, alias, role FROM agents WHERE container_id=%s AND kind='ai' AND terminated_at IS NULL "
                "ORDER BY alias", (cid,))
    rows = cur.fetchall()
    return (next((r for r in rows if _QA_ROLE.search(r["role"] or "")), None)
            or next((r for r in rows if (r["alias"] or "").lower().startswith("qa")), None))


def settings(cur, cid: str) -> dict:
    """The project's QA settings as the API returns them. `agent_id` is the agent set here, else
    the one whose role says QA (`agent_source`: set | role | none)."""
    cur.execute("SELECT * FROM qa_settings WHERE container_id=%s", (cid,))
    row = dict(cur.fetchone() or {})
    agent, source = None, "none"
    if row.get("agent_id"):
        cur.execute("SELECT id, alias FROM agents WHERE id=%s AND container_id=%s AND kind='ai' AND terminated_at IS NULL",
                    (str(row["agent_id"]), cid))
        agent = cur.fetchone()
        source = "set" if agent else "none"
    if agent is None:
        agent = _role_agent(cur, cid)
        source = "role" if agent else "none"
    return {"container_id": cid, "agent_id": str(agent["id"]) if agent else None,
            "agent_alias": agent["alias"] if agent else None, "agent_source": source,
            "default_platform": row.get("default_platform"), "trigger": row.get("trigger") or "manual",
            "on_fail": row.get("on_fail") or "report", "max_rounds": int(row.get("max_rounds") or DEFAULT_MAX_ROUNDS),
            "auto_triage": row.get("auto_triage") or "off", "max_per_run": int(row.get("max_per_run") or qa_triage.DEFAULT_MAX_PER_RUN),
            "final_decision": row.get("final_decision") or "person",
            "final_decision_by_agent_id": str(row["final_decision_by_agent_id"]) if row.get("final_decision_by_agent_id") else None,
            "final_decision_by_alias": _alias(cur, row.get("final_decision_by_agent_id")) or None,
            "final_decision_at": qs.iso(row.get("final_decision_at")),
            "updated_at": qs.iso(row.get("updated_at")), "updated_by_agent_id": str(row["updated_by_agent_id"]) if row.get("updated_by_agent_id") else None}


def save_settings(cur, cid: str, who: dict, *, agent_id: Optional[str], default_platform: Optional[str], trigger: str,
                  on_fail: str, max_rounds: int, auto_triage: str = "off", max_per_run: int = qa_triage.DEFAULT_MAX_PER_RUN,
                  final_decision: Optional[str] = None) -> dict:
    if agent_id:
        qs.require_uuid(agent_id, "agent_id")
        cur.execute("SELECT kind, container_id, terminated_at FROM agents WHERE id=%s", (agent_id,))
        a = cur.fetchone()
        if not a or str(a["container_id"]) != cid:
            raise HTTPException(404, "That agent is not a member of this project.")
        if a["kind"] != "ai" or a["terminated_at"] is not None:
            raise HTTPException(409, "QA needs an agent that can work: pick a current AI agent.")
    before = settings(cur, cid)["final_decision"]
    cur.execute(
        """INSERT INTO qa_settings (container_id, agent_id, default_platform, trigger, on_fail, max_rounds, auto_triage,
                                    max_per_run, updated_at, updated_by_agent_id)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
           ON CONFLICT (container_id) DO UPDATE SET
             agent_id=EXCLUDED.agent_id, default_platform=EXCLUDED.default_platform, trigger=EXCLUDED.trigger,
             on_fail=EXCLUDED.on_fail, max_rounds=EXCLUDED.max_rounds, auto_triage=EXCLUDED.auto_triage,
             max_per_run=EXCLUDED.max_per_run, updated_at=EXCLUDED.updated_at,
             updated_by_agent_id=EXCLUDED.updated_by_agent_id""",
        (cid, agent_id, default_platform, trigger, on_fail, max_rounds, auto_triage, max_per_run, qs.now(), who["id"]),
    )
    log_event(cur, cid, "human", who["id"], "container", cid, "qa_settings_changed",
              {"trigger": trigger, "on_fail": on_fail, "max_rounds": max_rounds})
    if final_decision and final_decision != before:
        cur.execute("UPDATE qa_settings SET final_decision=%s, final_decision_by_agent_id=%s, final_decision_at=%s WHERE container_id=%s",
                    (final_decision, who["id"], qs.now(), cid))
        log_event(cur, cid, "human", who["id"], "container", cid, "qa_final_decision_changed",
                  {"from": before, "to": final_decision, "by": who["id"], "by_alias": who.get("alias")})
    return settings(cur, cid)


def qa_agent_id(cur, cid: str) -> Optional[str]:
    return settings(cur, cid)["agent_id"]


def _platform(cur, cid: str, wanted: Optional[str], conf: dict) -> Optional[str]:
    """What was asked, else the project's default, else its one target."""
    if wanted or conf.get("default_platform"):
        return wanted or conf["default_platform"]
    cur.execute("SELECT platform FROM qa_targets WHERE container_id=%s AND app_id IS NOT NULL", (cid,))
    rows = [r["platform"] for r in cur.fetchall()]
    return rows[0] if len(rows) == 1 else None


# ---------------------------------------------------------------- reading requests

def load(cur, rid: str, *, lock: bool = False) -> dict:
    qs.require_uuid(rid, "request id")
    cur.execute("SELECT * FROM qa_requests WHERE id=%s" + (sql.for_update() if lock else ""), (rid,))
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, f"QA request {rid} not found")
    return dict(row)


def public(cur, row: dict) -> dict:
    """A request as the API returns it, with its names and its newest session."""
    out = qs.public(row) or {}
    for key, table, column, target in (("source_task_id", "tasks", "title", "source_task_title"),
                                       ("source_workflow_id", "workflows", "title", "source_workflow_title"),
                                       ("qa_task_id", "tasks", "title", "qa_task_title"),
                                       ("source_agent_id", "agents", "alias", "source_agent_alias"),
                                       ("requested_by_agent_id", "agents", "alias", "requested_by_alias"),
                                       ("approved_by_agent_id", "agents", "alias", "approved_by_alias")):
        out[target] = None
        if row.get(key):
            cur.execute(f"SELECT {column} AS v FROM {table} WHERE id=%s", (str(row[key]),))
            hit = cur.fetchone()
            out[target] = hit["v"] if hit else None
    cur.execute("SELECT * FROM qa_sessions WHERE request_id=%s ORDER BY started_at DESC LIMIT 1", (str(row["id"]),))
    s = cur.fetchone()
    out["session_id"] = str(s["id"]) if s else None
    out["session_status"] = s["status"] if s else None
    out["agent_id"] = str(s["agent_id"]) if s and s.get("agent_id") else None
    out["agent_alias"] = _alias(cur, s.get("agent_id")) or None if s else None
    out["run_id"] = None
    if s:
        from portal_backend import qa_run_tasks

        rows = [qs.public(s)]
        qa_run_tasks.add_run_ids(cur, rows)
        out["run_id"] = rows[0]["run_id"]
    return out


def detail(cur, row: dict) -> dict:
    """`public`, with everything the request led to: sessions, findings, the tasks those were filed
    as, drafts, verdicts and the rounds before and after it."""
    out = public(cur, row)
    rid = str(row["id"])
    sids = _session_ids(cur, rid)
    cur.execute("SELECT * FROM qa_sessions WHERE request_id=%s ORDER BY started_at", (rid,))
    out["sessions"] = qs.with_names(cur, [qs.public(r) for r in cur.fetchall()])
    out["findings"], out["drafts"], out["verdicts"] = [], [], []
    if sids:
        cond, param = sql.in_list("session_id"), (sql.list_param(sids),)
        cur.execute(f"SELECT * FROM qa_findings WHERE {cond} ORDER BY created_at", param)
        out["findings"] = qs.with_names(cur, [qs.public(r) for r in cur.fetchall()])
        cur.execute(f"SELECT * FROM qa_scenarios WHERE {cond} ORDER BY created_at", param)
        out["drafts"] = [qs.public(r) for r in cur.fetchall()]
        cur.execute(f"SELECT * FROM qa_verdicts WHERE {cond} ORDER BY created_at", param)
        out["verdicts"] = [qs.public(r) for r in cur.fetchall()]
    cur.execute("SELECT * FROM qa_acceptance_verdicts WHERE request_id=%s ORDER BY created_at", (rid,))
    out["line_verdicts"] = [qs.public(r) for r in cur.fetchall()]
    out["rounds"] = rounds_of(cur, row)
    return out


def rounds_of(cur, row: dict) -> list[dict]:
    """Every round of this request's chain, oldest first: `{id, round, status, summary}`."""
    first, seen = row, {str(row["id"])}
    while first.get("previous_request_id") and str(first["previous_request_id"]) not in seen:
        seen.add(str(first["previous_request_id"]))
        cur.execute("SELECT * FROM qa_requests WHERE id=%s", (str(first["previous_request_id"]),))
        hit = cur.fetchone()
        if not hit:
            break
        first = dict(hit)
    out, at = [], first
    while at:
        result = qs._json(at.get("result"), None) or {}
        out.append({"id": str(at["id"]), "round": at["round"], "status": at["status"], "summary": result.get("summary")})
        cur.execute("SELECT * FROM qa_requests WHERE previous_request_id=%s ORDER BY created_at LIMIT 1", (str(at["id"]),))
        hit = cur.fetchone()
        at = dict(hit) if hit and str(hit["id"]) not in {r["id"] for r in out} else None
    return out


def list_requests(cur, cid: str, *, status: Optional[str] = None, kind: Optional[str] = None,
                  source_task_id: Optional[str] = None, source_workflow_id: Optional[str] = None,
                  limit: int = 50) -> list[dict]:
    q, args = "SELECT * FROM qa_requests WHERE container_id=%s", [cid]
    for col, val in (("status", status), ("kind", kind), ("source_task_id", source_task_id),
                     ("source_workflow_id", source_workflow_id)):
        if val is not None:
            q += f" AND {col}=%s"
            args.append(val)
    cur.execute(q + " ORDER BY created_at DESC LIMIT %s", (*args, limit))
    return [public(cur, dict(r)) for r in cur.fetchall()]


def task_requests(cur, tid: str) -> list[dict]:
    cur.execute("SELECT * FROM qa_requests WHERE source_task_id=%s OR qa_task_id=%s ORDER BY created_at DESC", (tid, tid))
    return [public(cur, dict(r)) for r in cur.fetchall()]


def _session_ids(cur, rid: str) -> list[str]:
    cur.execute("SELECT id FROM qa_sessions WHERE request_id=%s", (rid,))
    return [str(r["id"]) for r in cur.fetchall()]


# ---------------------------------------------------------------- a person's click is the plan approval

def approve_plan(cur, tid: str, person_id: Optional[str], reason: str, *, source: str = "qa_person_run") -> bool:
    """Record a person's explicit action as the approval of this task's plan, through the
    mechanism a plan card uses: a `plan_approval` decision, its immutable `task_approval_records`
    row and the line on the thread. Task autonomy stays off, so the agent cannot accept its own
    finished work. A person who rejected the plan is not overruled; anyone but a person records
    nothing, so an agent's request follows the project's rule. Returns whether it is approved."""
    from portal_backend.decision_routing import _post_decision_to_thread
    from portal_backend.task_approval_policy import ApprovalPhase
    from portal_backend.task_autonomy_service import record_approval

    if not person_id:
        return False
    cur.execute("SELECT kind, terminated_at FROM agents WHERE id=%s", (str(person_id),))
    person = cur.fetchone()
    if not person or person["kind"] != "human" or person["terminated_at"] is not None:
        return False
    cur.execute("SELECT * FROM tasks WHERE id=%s", (tid,))
    task = dict(cur.fetchone())
    cur.execute("SELECT decision FROM decisions WHERE subject_type='plan_approval' AND subject_id=%s "
                "ORDER BY created_at DESC LIMIT 1", (tid,))
    latest = cur.fetchone()
    if latest and latest["decision"] == "reject":
        return False
    record_approval(cur, task, str(person_id), ApprovalPhase.PLAN, task.get("description") or task["title"],
                    human_review_authorized=True, permission_source=source)
    if latest:  # a repeat round: the decision stands, this work revision has its record
        return True
    cur.execute("SELECT agent_id FROM agent_tasks WHERE task_id=%s ORDER BY assigned_at DESC LIMIT 1", (tid,))
    assignee = cur.fetchone()
    cur.execute(
        """INSERT INTO decisions (container_id, subject_type, subject_id, decision, reason, actor_agent_id, target_agent_id)
           VALUES (%s,'plan_approval',%s,'approve',%s,%s,%s)""",
        (str(task["container_id"]), tid, reason, str(person_id), str(assignee["agent_id"]) if assignee else None),
    )
    _post_decision_to_thread(cur, "plan_approval", tid, "approve", reason, str(person_id))
    return True


# ---------------------------------------------------------------- handing off

def _clean_lines(lines: Optional[Iterable[str]]) -> list[str]:
    return [" ".join(str(x).split()) for x in lines or [] if str(x).strip()]


def _check_scenarios(cur, cid: str, ids: list[str]) -> None:
    for s in ids:
        qs.require_uuid(s, "scenario")
    if ids:
        cur.execute(f"SELECT id FROM qa_scenarios WHERE container_id=%s AND {sql.in_list('id')}", (cid, sql.list_param(ids)))
        found = {str(r["id"]) for r in cur.fetchall()}
        for s in ids:
            if s not in found:
                raise HTTPException(404, f"scenario {s} is not a scenario of this project")


def _kind_for(cur, cid: str, platform: Optional[str]) -> str:
    """Approved scenarios are checked; with none yet, QA explores."""
    q, args = "SELECT count(*) AS n FROM qa_scenarios WHERE container_id=%s AND status='validated'", [cid]
    if platform:
        q += " AND platform=%s"
        args.append(platform)
    cur.execute(q, tuple(args))
    return "check" if int(cur.fetchone()["n"] or 0) else "explore"


def _task_texts(req: dict, source: Optional[dict], approved_by: Optional[str]) -> tuple[str, str, str]:
    kind, rid, lines = req["kind"], str(req["id"]), []
    what = (source or {}).get("title") or req.get("focus") or "the app"
    title = f"QA {kind}: {what}"[:MAX_NAME_LEN]
    if approved_by:
        lines.append(person_run_line(approved_by))
    round_words = f" (round {req['round']})" if req["round"] > 1 else ""
    lines.append(f"Run {SKILLS[kind]} for QA request {rid}{round_words}: pass request_id=\"{rid}\" to start_session.")
    if req.get("platform"):
        lines.append(f"Platform: {req['platform']}.")
    if source:
        lines.append(f"Source: task {source['id']} ({source['title']}).")
    if req.get("focus"):
        lines.append(f"Focus: {req['focus']}")
    if req.get("device"):
        lines.append(f"Device: pass device=\"{req['device']}\" to start_session. A person chose it; use no other.")
    asked = qa_conditions.clean(req.get("conditions"))
    if asked:
        lines.append("Run it under these conditions: " + "; ".join(qa_conditions.words(asked, req.get("platform"))) + ".")
        lines.append(qa_conditions.prompt_line(asked))
    scenarios, tags = qs._json(req.get("scenario_ids"), []), qs._json(req.get("tags"), [])
    findings = qs._json(req.get("finding_ids"), [])
    if findings:
        lines.append("Findings to diagnose: " + ", ".join(findings))
    if scenarios:
        lines.append("Scenarios: " + ", ".join(scenarios))
    if tags:
        lines.append("Tags: " + ", ".join(tags))
    build = qs._json(req.get("build"), None) or {}
    said = [f"{k} {build[k]}" for k in ("branch", "commit", "url", "app_path") if build.get(k)]
    if said:
        lines.append("Build to test: " + ", ".join(said) + ".")
    if build.get("notes"):
        lines.append(f"Build notes: {build['notes']}")
    acceptance = qs._json(req.get("acceptance"), [])
    if acceptance:
        lines.append("Prove these lines; name each with verdict(acceptance_line=<n>):")
        lines += [f"{i}. {text}" for i, text in enumerate(acceptance)]
    lines.append("Finish with /orcha-done. The result goes back to whoever asked; a person still verifies the work.")
    dod = ("Every finding has a diagnosis from triage_finding." if kind == "triage" else
           "The session ended and its result is in: every acceptance line has a verdict with evidence."
           if acceptance else "The session ended and its result is in.")
    return title, "\n".join(lines)[:MAX_DESC_LEN], dod[:MAX_DOD_LEN]


def _insert(cur, cid: str, *, spec: dict, conf: dict, origin: str, who_id: Optional[str], source: Optional[dict],
            source_agent: Optional[str], previous: Optional[str] = None, finding_id: Optional[str] = None,
            round_no: int = 1, max_rounds: Optional[int] = None, qa_task_id: Optional[str] = None,
            status: str = "requested", approved_by: Optional[str] = None) -> dict:
    rid = qs.new_id()
    cur.execute(
        """INSERT INTO qa_requests (id, container_id, kind, platform, origin, source_task_id, source_work_revision,
                                    source_workflow_id, source_agent_id, source_finding_id, requested_by_agent_id,
                                    approved_by_agent_id, qa_task_id, previous_request_id, round, max_rounds,
                                    scenario_ids, tags, focus, minutes, acceptance, build, on_fail, status, created_at,
                                    finding_ids, device)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        (rid, cid, spec["kind"], spec.get("platform"), origin, str(source["id"]) if source else None,
         source.get("work_revision") if source else None,
         str(source["workflow_id"]) if source and source.get("workflow_id") else None, source_agent, finding_id, who_id,
         approved_by, qa_task_id, previous, round_no, max_rounds or conf["max_rounds"],
         qs.dumps(spec.get("scenario_ids") or []), qs.dumps(spec.get("tags") or []), spec.get("focus"), spec.get("minutes"),
         qs.dumps(spec.get("acceptance") or []), qs.dumps(spec["build"]) if spec.get("build") else None,
         spec.get("on_fail") or conf["on_fail"], status, qs.now(), qs.dumps(spec.get("finding_ids") or []), spec.get("device")),
    )
    qa_conditions.store(cur, "qa_requests", rid, spec.get("conditions"))
    return load(cur, rid)


def _source_agent(cur, tid: str) -> Optional[str]:
    cur.execute("""SELECT at.agent_id FROM agent_tasks at JOIN agents a ON a.id=at.agent_id
                    WHERE at.task_id=%s AND a.kind='ai' ORDER BY at.assigned_at DESC LIMIT 1""", (tid,))
    row = cur.fetchone()
    return str(row["agent_id"]) if row else None


def _changed(cur, cid: str, req: dict) -> None:
    """Live views follow requests over the container's event stream; it wakes nobody."""
    publish_event(cur, cid, None, "qa_request_changed", {"request_id": str(req["id"]), "status": req["status"]})


def hand_off(cid: str, who: dict, spec: dict, *, source_task_id: Optional[str] = None, origin: str = "handoff",
             previous: Optional[dict] = None, finding_id: Optional[str] = None, approved_by: Optional[str] = None) -> dict:
    """File a request and create its linked QA task through the normal handler, assigned to the
    QA agent. Runs outside any transaction: the handler opens its own, and the row goes first so
    the task can name it. A person asking is the approval of the run's plan (`approve_plan`); a
    further round of what a person asked for carries that on. Returns `{request, qa_task_id}`."""
    from portal_backend import task_creation_routes
    from portal_backend.schemas import TaskCreateBody

    spec = dict(spec)
    spec["acceptance"] = _clean_lines(spec.get("acceptance"))
    if who.get("kind") == "human":
        approved_by = who["id"]
    with db_cursor() as (conn, cur):
        conf = settings(cur, cid)
        source = None
        if source_task_id:
            qs.require_task_in(cur, cid, source_task_id)
            cur.execute("SELECT * FROM tasks WHERE id=%s", (source_task_id,))
            source = dict(cur.fetchone())
            if source["is_root"]:
                raise HTTPException(409, "The project's root task can't go to QA: send a task with work on it.")
            if source["status"] == "cancelled":
                raise HTTPException(409, "This task was cancelled, so there is nothing for QA to test.")
        spec["platform"] = _platform(cur, cid, spec.get("platform"), conf)
        spec["kind"] = spec.get("kind") or _kind_for(cur, cid, spec["platform"])
        _check_scenarios(cur, cid, spec.get("scenario_ids") or [])
        if spec["kind"] == "triage":
            spec["acceptance"] = []
            if not spec.get("finding_ids"):
                raise HTTPException(400, "Triage needs the findings to diagnose (finding_ids).")
        elif source and not spec["acceptance"]:
            spec["acceptance"] = ep.split_dod(source.get("definition_of_done") or "")
        if source:
            cur.execute(f"""SELECT id FROM qa_requests WHERE source_task_id=%s AND kind=%s AND status IN ('requested','running')
                             AND {'platform IS NULL' if not spec['platform'] else 'platform=%s'} LIMIT 1""",
                        (source_task_id, spec["kind"]) + ((spec["platform"],) if spec["platform"] else ()))
            open_one = cur.fetchone()
            if open_one:
                raise HTTPException(409, f"QA already has this task: request {open_one['id']} is still open.")
        source_agent = (spec.get("source_agent_id") or (_source_agent(cur, source_task_id) if source_task_id else None)
                        or (who["id"] if who.get("kind") != "human" else None))
        approver_alias = None
        if approved_by:
            cur.execute("SELECT alias FROM agents WHERE id=%s", (approved_by,))
            hit = cur.fetchone()
            approver_alias = hit["alias"] if hit else None
        req = _insert(cur, cid, spec=spec, conf=conf, origin=origin, who_id=who["id"], source=source, source_agent=source_agent,
                      previous=str(previous["id"]) if previous else None, finding_id=finding_id,
                      round_no=int(previous["round"]) + 1 if previous else 1,
                      max_rounds=previous.get("max_rounds") if previous else None, approved_by=approved_by)
        title, description, dod = _task_texts(req, source, approver_alias)
        alias = conf["agent_alias"]
        conn.commit()
    rid = str(req["id"])
    try:
        created = task_creation_routes.create_task(
            cid, TaskCreateBody(title=title, description=description, definition_of_done=dod,
                                created_by_agent_id=who["id"], assignee_alias=alias,
                                priority=(source or {}).get("priority") or 100),
            qs.internal_request(),
        )
    except Exception:
        with db_cursor() as (conn, cur):
            cur.execute("DELETE FROM qa_requests WHERE id=%s", (rid,))
            conn.commit()
        raise
    tid = str(created["task_id"])
    with db_cursor() as (conn, cur):
        cur.execute("UPDATE qa_requests SET qa_task_id=%s WHERE id=%s", (tid, rid))
        from portal_backend import qa_run_tasks

        qa_run_tasks.mark(cur, cid, tid, "request", kind=spec["kind"], platform=spec["platform"])
        if approved_by:
            approve_plan(cur, tid, approved_by, person_run_line(approver_alias or ""))
        log_event(cur, cid, "human" if who.get("kind") == "human" else "ai", who["id"], "qa_request", rid,
                  "qa_request_created", {"kind": spec["kind"], "platform": spec["platform"], "origin": origin,
                                         "source_task_id": source_task_id, "qa_task_id": tid, "round": req["round"]})
        req = load(cur, rid)
        _changed(cur, cid, req)
        out = public(cur, req)
        conn.commit()
    return {"request": out, "qa_task_id": tid}


# ---------------------------------------------------------------- a workflow QA step

def _result_text(value: Any) -> str:
    from portal_backend.evidence_pack import _result_text as text

    return text(value)


def step_build(cur, task: dict) -> Optional[dict]:
    """What to test, from what the steps before this one handed in."""
    cur.execute("""SELECT t.id, t.title, t.result FROM task_dependencies d JOIN tasks t ON t.id=d.depends_on_id
                    WHERE d.task_id=%s ORDER BY t.priority, t.created_at""", (str(task["id"]),))
    notes: list[str] = []
    out: dict[str, Any] = {}
    for row in cur.fetchall():
        text = _result_text(row["result"])
        if text:
            notes.append(f"{row['title']}: {text[:600]}")
            url, commit = _URL.search(text), _COMMIT.search(text)
            if url and "url" not in out:
                out["url"] = url.group(0).rstrip(".,")
            if commit and "commit" not in out:
                out["commit"] = commit.group(1)
        cur.execute("""SELECT branch FROM worker_runs WHERE task_id=%s AND branch IS NOT NULL
                        ORDER BY started_at DESC LIMIT 1""", (str(row["id"]),))
        run = cur.fetchone()
        if run and "branch" not in out:
            out["branch"] = run["branch"]
    if notes:
        out["notes"] = "\n".join(notes)[:2000]
    return out or None


def _group_of(cur, tid: str) -> Optional[dict]:
    cur.execute("""SELECT g.current_round, g.max_rounds FROM workflow_repeat_groups g
                     JOIN workflow_repeat_group_members m ON m.group_id=g.id WHERE m.task_id=%s""", (tid,))
    row = cur.fetchone()
    return dict(row) if row else None


def activate_step(cur, task: dict, workflow: dict) -> dict:
    """A QA step's turn was reserved: file its request. The step's own task is both source and QA
    task. A retried turn of the same work reuses the open request. In the caller's transaction."""
    tid, cid = str(task["id"]), str(task["container_id"])
    cur.execute("""SELECT * FROM qa_requests WHERE qa_task_id=%s AND source_work_revision=%s AND status IN ('requested','running')
                    ORDER BY created_at DESC LIMIT 1""", (tid, task["work_revision"]))
    open_one = cur.fetchone()
    if open_one:
        return dict(open_one)
    conf = settings(cur, cid)
    step = qs._json(task.get("qa_step"), None) or {}
    group = _group_of(cur, tid)
    cur.execute("SELECT * FROM qa_requests WHERE qa_task_id=%s ORDER BY created_at DESC LIMIT 1", (tid,))
    before = cur.fetchone()
    triage = step["kind"] == "triage"
    failures = _prior_failures(cur, tid) if triage else []
    prior = failures[0] if failures else None
    spec = {"kind": step["kind"], "platform": _platform(cur, cid, step.get("platform") or (prior or {}).get("platform"), conf),
            "device": step.get("device") or (prior or {}).get("device"), "scenario_ids": step.get("scenario_ids") or [], "tags": step.get("tags") or [], "focus": step.get("focus"),
            "minutes": step.get("minutes"), "acceptance": [] if triage else ep.split_dod(task.get("definition_of_done") or ""),
            "build": step_build(cur, task), "on_fail": "report",
            "finding_ids": list(dict.fromkeys(f for r in failures for f in findings_to_triage(cur, r)))}
    owner = str(workflow["owner_human_id"])
    source = {**task, "workflow_id": str(workflow["id"])}
    req = _insert(cur, cid, spec=spec, conf=conf, origin="workflow", who_id=owner, source=source,
                  source_agent=_source_agent(cur, tid), previous=str(before["id"]) if before else None,
                  round_no=int(group["current_round"] or 1) if group else 1,
                  max_rounds=int(group["max_rounds"]) if group else 1, qa_task_id=tid, approved_by=owner)
    from portal_backend import qa_run_tasks

    qa_run_tasks.mark(cur, cid, tid, "workflow", kind=spec["kind"], platform=spec["platform"])
    # The owner started this workflow: that click is the plan approval of the QA step in it.
    approve_plan(cur, tid, owner, person_run_line(_alias(cur, owner)), source="workflow_started_by_person")
    log_event(cur, cid, "system", None, "qa_request", str(req["id"]), "qa_request_created",
              {"kind": spec["kind"], "platform": spec["platform"], "origin": "workflow", "source_task_id": tid,
               "workflow_id": str(workflow["id"]), "round": req["round"]})
    _changed(cur, cid, req)
    return req


def _prior_failures(cur, tid: str) -> list[dict]:
    """The QA requests whose failures this triage step diagnoses: the newest failed one of each
    step before it, newest first (a release check has one per platform)."""
    cur.execute("""SELECT r.* FROM qa_requests r JOIN task_dependencies d ON d.depends_on_id=r.qa_task_id
                    WHERE d.task_id=%s AND r.status='failed' ORDER BY r.created_at DESC""", (tid,))
    out, seen = [], set()
    for row in map(dict, cur.fetchall()):
        if str(row["qa_task_id"]) not in seen:
            seen.add(str(row["qa_task_id"]))
            out.append(row)
    return out


def findings_to_triage(cur, req: dict) -> list[str]:
    """What failed the request, as findings: a failed criterion with no finding of its own gets one,
    so triage can judge it. Dismissed findings and those already diagnosed stay out."""
    cid, rid = str(req["container_id"]), str(req["id"])
    result = qs._json(req.get("result"), None) or {}
    sids = _session_ids(cur, rid)
    if not sids:
        return []
    cond = sql.in_list("session_id")
    for s in result.get("scenarios") or []:
        for c in s.get("criteria") or []:
            if c["verdict"] != "fail" or s.get("quarantined") or _WARNING.search(c.get("text") or ""):
                continue
            cur.execute(f"SELECT 1 AS hit FROM qa_findings WHERE {cond} AND scenario_id=%s LIMIT 1", (sql.list_param(sids), s["scenario_id"]))
            if cur.fetchone():
                continue
            cur.execute("""INSERT INTO qa_findings (id, container_id, session_id, task_id, severity, title, expected, actual, frame_ids,
                                                    status, created_at, scenario_id, request_id)
                           VALUES (%s,%s,%s,%s,'major',%s,%s,%s,%s,'open',%s,%s,%s)""",
                        (qs.new_id(), cid, sids[0], req.get("qa_task_id"), f"{s['name']}: criterion {c['index'] + 1} failed"[:200],
                         c.get("text"), c.get("note"), qs.dumps(c.get("frame_ids") or []), qs.now(), s["scenario_id"], rid))
    cur.execute(f"SELECT id FROM qa_findings WHERE {cond} AND status<>'dismissed' AND triage IS NULL ORDER BY created_at", (sql.list_param(sids),))
    return [str(r["id"]) for r in cur.fetchall()]


def _alias(cur, aid: Optional[str]) -> str:
    if not aid:
        return ""
    cur.execute("SELECT alias FROM agents WHERE id=%s", (str(aid),))
    row = cur.fetchone()
    return row["alias"] if row else ""


def prompt_context(cur, task: dict) -> Optional[dict]:
    """What a QA step's worker is told: the skill, the request and what to prove."""
    tid = str(task["id"])
    cur.execute("SELECT * FROM qa_requests WHERE qa_task_id=%s ORDER BY created_at DESC LIMIT 1", (tid,))
    row = cur.fetchone()
    step = qs._json(task.get("qa_step"), None) or {}
    if not row:
        return {"skill": SKILLS.get(step.get("kind"), ""), "kind": step.get("kind"), "request_id": None}
    r = qs.public(dict(row)) or {}
    return {"skill": SKILLS[r["kind"]], "kind": r["kind"], "request_id": r["id"], "platform": r.get("platform"),
            "device": r.get("device"), "round": r["round"], "scenario_ids": r["scenario_ids"], "tags": r["tags"], "focus": r.get("focus"),
            "minutes": r.get("minutes"), "acceptance": r["acceptance"], "build": r.get("build"),
            "conditions": qa_conditions.clean(r.get("conditions")),
            "finding_ids": r.get("finding_ids") or [], "approved_by": _alias(cur, r.get("approved_by_agent_id"))}


def close_for_tasks(cur, task_ids: list[str], actor_id: Optional[str]) -> None:
    """Their tasks stopped: requests still open on them will never run. In the caller's transaction."""
    ids = [str(t) for t in task_ids]
    if not ids:
        return
    cur.execute(f"SELECT * FROM qa_requests WHERE status IN ('requested','running') AND {sql.in_list('qa_task_id')}",
                (sql.list_param(ids),))
    for row in cur.fetchall():
        _cancel_row(cur, dict(row), actor_id, "Its task was stopped.")


def _cancel_row(cur, req: dict, actor_id: Optional[str], why: str) -> dict:
    result = {"summary": why, "lines": [], "scenarios": [], "finding_ids": [], "draft_ids": [], "session_ids": []}
    cur.execute("UPDATE qa_requests SET status='cancelled', finished_at=%s, result=%s WHERE id=%s AND status IN ('requested','running')",
                (qs.now(), qs.dumps(result), str(req["id"])))
    cid = str(req["container_id"])
    log_event(cur, cid, "system" if not actor_id else "human", actor_id, "qa_request", str(req["id"]), "qa_request_cancelled", {"reason": why})
    out = load(cur, str(req["id"]))
    _changed(cur, cid, out)
    return out


def cancel(cid: str, rid: str, who: dict, request: Any) -> dict:
    """The requester or a person stops an open request, and the task it made goes with it. A
    workflow step stays where it is: its owner decides."""
    with db_cursor() as (conn, cur):
        req = load(cur, rid, lock=True)
        if str(req["container_id"]) != cid:
            raise HTTPException(404, f"QA request {rid} not found")
        if who["kind"] != "human" and str(req.get("requested_by_agent_id")) != who["id"]:
            raise HTTPException(403, "Only a person or whoever asked can cancel a QA request.")
        if req["status"] not in OPEN:
            raise HTTPException(409, f"This request already ended ({req['status']}).")
        out = _cancel_row(cur, req, who["id"] if who["kind"] == "human" else None, f"Cancelled by {who['alias']}.")
        step = bool(req.get("qa_task_id") and str(req.get("source_task_id")) == str(req["qa_task_id"]))
        result = public(cur, out)
        conn.commit()
    if req.get("qa_task_id") and not step:
        from portal_backend.schemas.task_operations import TaskCancel
        from portal_backend.task_cancellation_routes import cancel_task

        try:
            cancel_task(str(req["qa_task_id"]), TaskCancel(actor_agent_id=who["id"], reason="The QA request was cancelled."), request)
        except HTTPException as e:
            if e.status_code != 409:
                raise
    return result


# ---------------------------------------------------------------- sessions and verdicts

def request_for_task(cur, tid: Optional[str]) -> Optional[dict]:
    """The open request this task works, if any."""
    if not tid:
        return None
    cur.execute("SELECT * FROM qa_requests WHERE qa_task_id=%s AND status IN ('requested','running') "
                "ORDER BY created_at DESC LIMIT 1", (str(tid),))
    row = cur.fetchone()
    return dict(row) if row else None


def link_session(cur, s: dict, request_id: Optional[str]) -> dict:
    """Tie a new session to its request: the one named, else the open one its task works. Refused
    for a request of another project or one that ended. The session's result then counts."""
    cid = str(s["container_id"])
    req = load(cur, request_id, lock=True) if request_id else request_for_task(cur, s.get("task_id"))
    if req is None:
        return s
    if str(req["container_id"]) != cid:
        raise HTTPException(400, "that QA request belongs to another project")
    if req["status"] not in OPEN:
        raise HTTPException(409, f"This QA request already ended ({req['status']}); ask for a new one.")
    if req.get("platform") and req["platform"] != s["platform"]:
        raise HTTPException(400, f"That QA request is for {req['platform']}, not {s['platform']}.")
    rid = str(req["id"])
    cur.execute("UPDATE qa_sessions SET request_id=%s, task_id=COALESCE(task_id, %s) WHERE id=%s",
                (rid, str(req["qa_task_id"]) if req.get("qa_task_id") else None, str(s["id"])))
    cur.execute("UPDATE qa_requests SET status='running', platform=COALESCE(platform, %s) WHERE id=%s", (s["platform"], rid))
    _changed(cur, cid, load(cur, rid))
    return qs.load_session(cur, str(s["id"]))


def add_line_verdict(cur, s: dict, *, line: int, verdict: str, note: Optional[str], frames: list[str],
                     scenario_id: Optional[str], criterion_index: Optional[int]) -> dict:
    rid = s.get("request_id")
    if not rid:
        raise HTTPException(400, "This session has no QA request, so it has no acceptance lines.")
    req = load(cur, str(rid))
    if req["status"] not in OPEN:
        raise HTTPException(409, f"This QA request already ended ({req['status']}).")
    lines = qs._json(req.get("acceptance"), [])
    if line >= len(lines):
        raise HTTPException(400, f"This request has acceptance lines 0 to {len(lines) - 1}." if lines else "This request has no acceptance lines.")
    vid = qs.new_id()
    cur.execute(
        """INSERT INTO qa_acceptance_verdicts (id, container_id, request_id, session_id, line_index, verdict, note, frame_ids,
                                               scenario_id, criterion_index, created_at)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        (vid, str(s["container_id"]), str(rid), str(s["id"]), line, verdict, note, qs.dumps(frames), scenario_id,
         criterion_index, qs.now()),
    )
    cur.execute("SELECT * FROM qa_acceptance_verdicts WHERE id=%s", (vid,))
    return qs.public(cur.fetchone()) or {}


# ---------------------------------------------------------------- the rollup

def _worst(verdicts: Iterable[str]) -> Optional[str]:
    return min(verdicts, key=lambda v: VERDICT_ORDER.get(v, 9), default=None)


def _scenario_results(cur, req: dict, sids: list[str]) -> tuple[list[dict], bool]:
    """Per scenario, each criterion's newest verdict (per Examples row) and the worst of them.
    A `[warning]` criterion and a quarantined scenario are reported, and fail nothing."""
    verdicts: list[dict] = []
    if sids:
        cur.execute(f"""SELECT v.*, s.name AS scenario_name, s.criteria AS scenario_criteria, s.quarantined_at
                          FROM qa_verdicts v JOIN qa_scenarios s ON s.id=v.scenario_id
                         WHERE {sql.in_list('v.session_id')} ORDER BY v.created_at""", (sql.list_param(sids),))
        verdicts = [dict(r) for r in cur.fetchall()]
    newest: dict[tuple, dict] = {}
    for v in verdicts:
        newest[(str(v["scenario_id"]), v["criterion_index"], v.get("example_row"))] = v
    by_scenario: dict[str, list[dict]] = {}
    for key, v in newest.items():
        by_scenario.setdefault(key[0], []).append(v)
    out, failed = [], False
    for sid, rows in by_scenario.items():
        rows.sort(key=lambda r: (r["criterion_index"], r.get("example_row") or 0))
        first = rows[0]
        criteria = qs._json(first["scenario_criteria"], [])
        counted = []
        for r in rows:
            text = criteria[r["criterion_index"]] if r["criterion_index"] < len(criteria) else ""
            if r["verdict"] == "fail" and _WARNING.search(text or ""):
                continue
            counted.append(r["verdict"])
        verdict = _worst(counted) or "pass"
        quarantined = bool(first.get("quarantined_at"))
        if verdict == "fail" and not quarantined:
            failed = True
        worst = next((r for r in rows if r["verdict"] == verdict), rows[0])
        out.append({"scenario_id": sid, "name": first["scenario_name"], "verdict": verdict, "note": worst.get("note"),
                    "quarantined": quarantined, "frame_ids": qs._json(worst.get("frame_ids"), []),
                    "criteria": [{"index": r["criterion_index"], "verdict": r["verdict"], "note": r.get("note"),
                                  "example_row": r.get("example_row"), "text": criteria[r["criterion_index"]] if r["criterion_index"] < len(criteria) else None,
                                  "frame_ids": qs._json(r.get("frame_ids"), [])} for r in rows]})
    seen = {r["scenario_id"] for r in out}
    for sid in qs._json(req.get("scenario_ids"), []):
        if sid not in seen:
            cur.execute("SELECT name FROM qa_scenarios WHERE id=%s", (sid,))
            hit = cur.fetchone()
            out.append({"scenario_id": sid, "name": hit["name"] if hit else None, "verdict": None, "note": None,
                        "quarantined": False, "frame_ids": [], "criteria": []})
    return out, failed


def _line_results(cur, req: dict) -> list[dict]:
    if not req.get("id"):
        return []
    cur.execute("SELECT * FROM qa_acceptance_verdicts WHERE request_id=%s ORDER BY created_at", (str(req["id"]),))
    newest = {r["line_index"]: dict(r) for r in cur.fetchall()}
    out = []
    for i, text in enumerate(qs._json(req.get("acceptance"), [])):
        r = newest.get(i)
        out.append({"index": i, "text": text, "verdict": r["verdict"] if r else None, "note": r.get("note") if r else None,
                    "frame_ids": qs._json(r.get("frame_ids"), []) if r else [],
                    "session_id": str(r["session_id"]) if r else None})
    return out


def rollup(cur, req: dict, sessions: Optional[list[dict]] = None) -> tuple[str, dict]:
    """The request's verdicts rolled up to passed, failed or blocked, and its result. Pure read.
    A run with no request passes its `sessions` and a `req` of `{id: None, kind, platform}`.

    failed: a scenario that counts failed, a line failed, or a blocker or major finding.
    blocked: nothing failed but QA could not say: no session finished, a verdict came back blocked
    or inconclusive, a named scenario got no verdict, or a check recorded nothing that covers it.
    passed: everything else. Lines nobody judged stay unjudged: they prove nothing either way."""
    if sessions is None:
        cur.execute("SELECT id, status FROM qa_sessions WHERE request_id=%s", (str(req["id"]),))
        sessions = cur.fetchall()
    sids = [str(s["id"]) for s in sessions]
    scenarios, scenario_failed = _scenario_results(cur, req, sids)
    lines = _line_results(cur, req)
    findings: list[dict] = []
    drafts: list[str] = []
    if sids:
        cond, param = sql.in_list("session_id"), (sql.list_param(sids),)
        cur.execute(f"SELECT * FROM qa_findings WHERE {cond} AND status<>'dismissed' ORDER BY created_at", param)
        findings = [dict(r) for r in cur.fetchall()]
        cur.execute(f"SELECT id FROM qa_scenarios WHERE {cond} ORDER BY created_at", param)
        drafts = [str(r["id"]) for r in cur.fetchall()]
    serious = [f for f in findings if f["severity"] in FAILING_SEVERITIES and qa_triage.counts_against_gate(f)]
    judged_lines = [l for l in lines if l["verdict"]]
    judged_scenarios = [s for s in scenarios if s["verdict"]]
    unclear = [v for v in [l["verdict"] for l in judged_lines] + [s["verdict"] for s in judged_scenarios]
               if v in ("blocked", "inconclusive")]
    missing = [s for s in scenarios if not s["verdict"]]
    finished = [s for s in sessions if s["status"] == "done"]
    if scenario_failed or any(l["verdict"] == "fail" for l in judged_lines) or serious:
        status = "failed"
    elif not finished and not judged_lines and not judged_scenarios:
        status = "blocked"
    elif unclear or missing:
        status = "blocked"
    elif req["kind"] == "check" and not judged_scenarios and len(judged_lines) < max(len(lines), 1):
        status = "blocked"  # nothing but lines was recorded, so they are the whole brief
    else:
        status = "passed"
    result = {"lines": lines, "scenarios": scenarios, "finding_ids": [str(f["id"]) for f in findings], "draft_ids": drafts,
              "session_ids": sids, "findings": _finding_rows(findings), "failing_findings": len(serious)}
    result["summary"] = _summary(req, status, lines, scenarios, findings, finished)
    return status, result


def _finding_rows(findings: list[dict]) -> list[dict]:
    rows = sorted(findings, key=lambda f: SEVERITY_ORDER.get(f["severity"], 9))
    return [{"id": str(f["id"]), "severity": f["severity"], "title": f["title"], "expected": f.get("expected"),
             "actual": f.get("actual"), "fix_prompt": f.get("fix_prompt"), "frame_ids": qs._json(f.get("frame_ids"), []),
             "screen_key": f.get("screen_key")} for f in rows]


def _summary(req: dict, status: str, lines: list[dict], scenarios: list[dict], findings: list[dict], finished: list) -> str:
    where = f" on {_PLATFORM_WORD.get(req['platform'], req['platform'])}" if req.get("platform") else ""
    # Only a check can fail. Findings are what a map, an exploration or a draft run is there to bring back.
    word = "found problems" if status == "failed" and req["kind"] != "check" else status
    bits = [f"QA {req['kind']}{where} {word}"]
    if scenarios:
        ok = sum(1 for s in scenarios if s["verdict"] == "pass")
        bits.append(f"{ok} of {len(scenarios)} scenarios passed")
    judged = [l for l in lines if l["verdict"]]
    if judged:
        bits.append(f"{sum(1 for l in judged if l['verdict'] == 'pass')} of {len(lines)} lines proven")
    if findings:
        bits.append(f"{len(findings)} finding{'s' if len(findings) != 1 else ''}")
    if status == "blocked" and not finished:
        bits.append("no session finished")
    return ": ".join(bits[:1]) + (": " + ", ".join(bits[1:]) if len(bits) > 1 else "") + "."


def outcome_findings(result: dict) -> list[dict]:
    """The result as a step's outcome findings, worst first: what `round_context` hands the fix
    step. The text stays free of ids and frames, so the stall rule can compare two rounds."""
    out: list[dict] = []
    for f in result.get("findings") or []:
        parts = [f["title"]]
        if f.get("expected"):
            parts.append(f"expected: {f['expected']}")
        if f.get("actual"):
            parts.append(f"actual: {f['actual']}")
        out.append({"id": f["id"][:80], "text": "; ".join(parts)[:OUTCOME_TEXT_MAX], "severity": OUTCOME_SEVERITY.get(f["severity"])})
    for s in result.get("scenarios") or []:
        if s["verdict"] == "fail" and not s.get("quarantined"):
            for c in s.get("criteria") or []:
                if c["verdict"] == "fail" and not _WARNING.search(c.get("text") or ""):
                    text = f"Scenario {s['name']}: {c.get('text') or 'criterion ' + str(c['index'])}"
                    if c.get("note"):
                        text += f": {c['note']}"
                    out.append({"text": text[:OUTCOME_TEXT_MAX], "severity": "major"})
    for l in result.get("lines") or []:
        if l["verdict"] == "fail":
            text = f"Acceptance line: {l['text']}" + (f": {l['note']}" if l.get("note") else "")
            out.append({"text": text[:OUTCOME_TEXT_MAX], "severity": "major"})
    return out[:OUTCOME_FINDINGS_MAX]


def outcome_for(cur, tid: str, status: str, decision: Optional[str] = None) -> Optional[str]:
    """The step's declared outcome for a rolled-up status. A blocked request reports nothing unless
    the step declares `blocked`: accepting it then asks the owner, because QA could not say. A
    triage step's outcome is its decision, by name, else by kind."""
    cur.execute("SELECT name, kind FROM workflow_step_outcomes WHERE task_id=%s ORDER BY position", (tid,))
    rows = cur.fetchall()
    if decision:
        named = next((r["name"] for r in rows if r["name"].casefold() == decision), None)
        kinds = {"fix": ("changes", "failure"), "clear": ("success",)}.get(decision, ())
        return named or next((r["name"] for k in kinds for r in rows if r["kind"] == k), None)
    def first(*kinds: str) -> Optional[str]:
        return next((r["name"] for k in kinds for r in rows if r["kind"] == k), None)
    if status == "passed":
        return first("success")
    if status == "failed":
        return first("failure", "changes")
    return next((r["name"] for r in rows if r["name"].casefold() == "blocked"), None)


# ---------------------------------------------------------------- the return path

def _is_step(req: dict) -> bool:
    return bool(req.get("qa_task_id") and req.get("source_workflow_id") and str(req.get("source_task_id")) == str(req["qa_task_id"]))


def finish(cur, req: dict) -> Optional[dict]:
    """Roll an open request up and run the return path, once. In the caller's transaction."""
    req = load(cur, str(req["id"]), lock=True)
    if req["status"] not in OPEN:
        return None
    decision = None
    if req["kind"] == "triage":
        status, decision, result = qa_triage.decide(cur, req)
    else:
        status, result = rollup(cur, req)
    cid, rid = str(req["container_id"]), str(req["id"])
    cur.execute("UPDATE qa_requests SET status=%s, decision=%s, result=%s, finished_at=%s WHERE id=%s",
                (status, decision, qs.dumps(result), qs.now(), rid))
    req = load(cur, rid)
    log_event(cur, cid, "system", None, "qa_request", rid, "qa_request_finished",
              {"status": status, "round": req["round"], "source_task_id": str(req["source_task_id"]) if req.get("source_task_id") else None,
               "summary": result["summary"]})
    if _is_step(req):
        _report_step(cur, req, result)
    return _return_path(cur, req, result)


def _report_step(cur, req: dict, result: dict) -> None:
    """A QA step's result goes through the existing outcome path, with its findings as the report.
    The route it selects applies when the step is accepted under its own rule, never here. A
    failure leaves the step for its owner to pick an outcome: the transition already happened."""
    from portal_backend.workflow_integration import IntegratedWorkflowHooks
    from portal_backend.workflow_service import WorkflowActor, WorkflowService

    tid, wid, cid = str(req["qa_task_id"]), str(req["source_workflow_id"]), str(req["container_id"])
    triage = req["kind"] == "triage"
    outcome = outcome_for(cur, tid, req["status"], req.get("decision"))
    svc = WorkflowService(cur, IntegratedWorkflowHooks())
    w = svc.workflow(wid)
    if not outcome or w.get("semantics_version") != 2:
        return
    cur.execute("SELECT work_revision FROM tasks WHERE id=%s", (tid,))
    task = cur.fetchone()
    turn = svc.live_turn(tid)
    actor_id = str(turn["claimant_id"]) if turn else str(req.get("source_agent_id") or "")
    body = {"expected_revision": w["revision"], "expected_work_revision": task["work_revision"],
            "idempotency_key": f"qa-outcome-{req['id']}", "reason": "", "outcome": outcome,
            "findings": qa_triage.confirmed_findings(result) if triage else outcome_findings(result),
            "note": qa_triage.confirmed_note(result) if triage else (result.get("summary") or "")[:4000], "qa_rollup": True}
    try:
        svc.mutate(cid, WorkflowActor(actor_id, True, True, str(turn["run_id"]) if turn and turn.get("run_id") else None),
                   "report_outcome", body, wid=wid, tid=tid)
    except HTTPException as e:
        logger.warning("QA step %s kept no outcome: %s", tid, e.detail)
        result["outcome_refused"] = str(e.detail)[:300]


def evidence_text(req: dict, result: dict) -> str:
    """The result as a person reads it in the workflow's evidence."""
    lines = [result.get("summary") or f"QA {req['status']}", f"Request {req['id']}, round {req['round']}."]
    for l in result.get("lines") or []:
        lines.append(f"Line {l['index']} [{l['verdict'] or 'not judged'}] {l['text']}" + (f": {l['note']}" if l.get("note") else ""))
        lines += [f"  /api/qa/frames/{x}" for x in l.get("frame_ids") or []]
    for s in result.get("scenarios") or []:
        lines.append(f"Scenario {s.get('name')} [{s['verdict'] or 'no verdict'}]" + (f": {s['note']}" if s.get("note") else ""))
        lines += [f"  /api/qa/frames/{x}" for x in s.get("frame_ids") or []]
    for f in result.get("findings") or []:
        lines.append(f"Finding [{f['severity']}] {f['title']}")
        lines += [f"  /api/qa/frames/{x}" for x in f.get("frame_ids") or []]
    for d in result.get("diagnoses") or []:
        lines.append(f"Finding [{d['severity']}] {d['title']}: {d.get('classification') or 'not diagnosed'}"
                     + (f", {d['rate']}" if d.get("rate") else "") + (f". Root cause: {d['root_cause']}" if d.get("root_cause") else ""))
        lines += [f"  /api/qa/frames/{x}" for x in [*d.get("frame_ids", []), *d.get("evidence_frame_ids", [])]]
    return "\n".join(lines)[:200_000]


def land_evidence(cur, req: dict) -> bool:
    """Put a QA step's result into the workflow's evidence, beside the worker's submission. Only
    into a set still open: a frozen set stays exactly what it was. Once per request."""
    from portal_backend.workflow_evidence_service import capture_qa_result

    result = qs._json(req.get("result"), None) or {}
    if result.get("evidence_landed") or req["status"] not in FINISHED:
        return False
    tid = str(req["qa_task_id"])
    cur.execute("""SELECT * FROM workflow_executions WHERE task_id=%s AND current_evidence_set_id IS NOT NULL
                    ORDER BY generation DESC LIMIT 1""", (tid,))
    execution = cur.fetchone()
    cur.execute("SELECT * FROM tasks WHERE id=%s", (tid,))
    task = dict(cur.fetchone())
    if not execution or not capture_qa_result(
            cur, task, dict(execution), text=evidence_text(req, result),
            note=f"QA result, round {req['round']}: {req['status']}"):
        return False
    result["evidence_landed"] = True
    cur.execute("UPDATE qa_requests SET result=%s WHERE id=%s", (qs.dumps(result), str(req["id"])))
    return True


def _thread_body(req: dict, result: dict, *, reopened: bool, exhausted: bool, person: bool = True) -> str:
    rid, top = str(req["id"]), result.get("summary") or f"QA {req['status']}."
    of = f" of {req['max_rounds']}" if req.get("max_rounds") else ""
    lines = [f"[QA result · round {req['round']}{of}] {top}"]
    for f in (result.get("findings") or [])[:10]:
        lines.append(f"- [{f['severity']}] {f['title']}" + (f" (expected: {f['expected']})" if f.get("expected") else ""))
    for d in (result.get("diagnoses") or [])[:20]:
        lines.append(f"- [{d['severity']}] {d['title']}: {(d.get('classification') or 'not diagnosed').replace('_', ' ')}"
                     + (f", {d['rate']}" if d.get("rate") else "") + (f" ({d['action']})" if d.get("action") else ""))
    extra = [o["text"] for o in outcome_findings({"scenarios": result.get("scenarios"), "lines": result.get("lines")})][:10]
    lines += [f"- {t}" for t in extra]
    if reopened:
        lines.append("This task is back with you: fix what QA found, then finish it again. QA runs again when you do.")
    elif exhausted:
        lines.append("That was the last round: a person decides what happens next.")
    elif req["status"] == "passed" and person:
        lines.append("A person still verifies this task.")
    elif req["status"] == "blocked":
        lines.append("QA could not finish, so this proves nothing yet: read why before going on.")
    lines.append(f"QA request: /qa?view=requests&request={rid}")
    return "\n".join(lines)


def _reopen(cur, req: dict, source: dict, feedback: str) -> None:
    """Back to in_progress, as a person's rejection does, but it records no verification."""
    from portal_backend.review_routing import supersede_pending_prereview

    tid, cid = str(source["id"]), str(source["container_id"])
    cur.execute("UPDATE tasks SET status='in_progress' WHERE id=%s AND status='needs_verification'", (tid,))
    cur.execute("UPDATE agent_tasks SET assignment_status='working' WHERE task_id=%s AND assignment_status='done' RETURNING agent_id", (tid,))
    restored = [str(r["agent_id"]) for r in cur.fetchall()]
    for aid in restored:
        recompute_agent_status(cur, aid)
    supersede_pending_prereview(cur, cid, tid, reason="qa_reopened")
    log_event(cur, cid, "system", None, "task", tid, "qa_reopened",
              {"request_id": str(req["id"]), "round": req["round"], "feedback": feedback[:500], "reassigned_to_agent_ids": restored})


def _people(cur, req: dict, source: Optional[dict]) -> list[str]:
    """Who hears about a result: the person who asked, the task's creator, the workflow's owner;
    with none of those, the project's owners."""
    ids = [req.get("requested_by_agent_id"), (source or {}).get("created_by_agent_id")]
    if req.get("source_workflow_id"):
        cur.execute("SELECT owner_human_id FROM workflows WHERE id=%s", (str(req["source_workflow_id"]),))
        hit = cur.fetchone()
        ids.append(hit["owner_human_id"] if hit else None)
    wanted = list(dict.fromkeys(str(i) for i in ids if i))
    people: list[str] = []
    if wanted:
        cur.execute(f"SELECT id FROM agents WHERE kind='human' AND terminated_at IS NULL AND {sql.in_list('id')}", (sql.list_param(wanted),))
        people = [str(r["id"]) for r in cur.fetchall()]
    if not people:
        cur.execute("SELECT id FROM agents WHERE container_id=%s AND kind='human' AND member_role='owner' AND terminated_at IS NULL",
                    (str(req["container_id"]),))
        people = [str(r["id"]) for r in cur.fetchall()]
    return people


def _return_path(cur, req: dict, result: dict) -> dict:
    from portal_backend.task_message_delivery import message_recipients

    cid, rid = str(req["container_id"]), str(req["id"])
    source = None
    if req.get("source_task_id"):
        cur.execute("SELECT * FROM tasks WHERE id=%s", (str(req["source_task_id"]),))
        hit = cur.fetchone()
        source = dict(hit) if hit else None
    step = _is_step(req)
    top = (req.get("max_rounds") or DEFAULT_MAX_ROUNDS)
    reopened = exhausted = False
    from portal_backend import qa_run_tasks

    quality = settings(cur, cid)["final_decision"] == "quality"
    failed = req["status"] == "failed" and source is not None
    wants = failed and req["on_fail"] == "reopen"
    if failed and quality and not wants and not source.get("workflow_id"):
        wants = qa_run_tasks.sends_back(cur, req, source, result)
    if wants and source.get("workflow_id"):
        # A workflow step goes back through a person or a QA step's route, never through this.
        result["reopen_refused"] = "A workflow step goes back through its reviewer or its QA step."
    elif wants and source["status"] in ("needs_verification", "in_progress"):
        if int(req["round"]) < int(top):
            reopened = True
            result["reopened"] = True
            feedback = "; ".join(f["title"] for f in result.get("findings") or []) or (result.get("summary") or "")
            _reopen(cur, req, source, feedback)
        else:
            exhausted = True
            result["rounds_exhausted"] = True
    author = str(req["source_agent_id"]) if step and req.get("source_agent_id") else _qa_author(cur, req)
    message_id = None
    if source is not None:
        body = _thread_body(req, result, reopened=reopened, exhausted=exhausted, person=not quality)
        cur.execute("INSERT INTO task_messages (task_id, author_id, body) VALUES (%s,%s,%s) RETURNING id",
                    (str(source["id"]), author, body))
        message_id = str(cur.fetchone()["id"])
        log_event(cur, cid, "ai" if author else "system", author, "task", str(source["id"]), "message",
                  {"message_id": message_id, "preview": body[:120]})
        log_event(cur, cid, "system", None, "task", str(source["id"]), "qa_result",
                  {"request_id": rid, "status": req["status"], "round": req["round"], "reopened": reopened})
    preview = (result.get("summary") or "")[:200]
    payload = {"task_id": str(source["id"]) if source else (str(req["qa_task_id"]) if req.get("qa_task_id") else None),
               "request_id": rid, "status": req["status"], "round": req["round"], "reopened": reopened, "preview": preview}
    if source is not None and not step and source["status"] not in ("completed", "cancelled"):
        cur.execute("SELECT * FROM tasks WHERE id=%s", (str(source["id"]),))
        for row in message_recipients(cur, dict(cur.fetchone())):
            publish_event(cur, cid, str(row["agent_id"]), "task_message",
                          {"task_id": str(source["id"]), "message_id": message_id, "from_agent_id": author, "preview": preview})
    if source is None and req.get("requested_by_agent_id"):
        cur.execute("SELECT kind FROM agents WHERE id=%s", (str(req["requested_by_agent_id"]),))
        asker = cur.fetchone()
        if asker and asker["kind"] != "human":
            publish_event(cur, cid, str(req["requested_by_agent_id"]), "qa_result", payload)
    for person in _people(cur, req, source):
        publish_event(cur, cid, person, "qa_result", payload)
    _changed(cur, cid, req)
    cur.execute("UPDATE qa_requests SET result=%s WHERE id=%s", (qs.dumps(result), rid))
    return load(cur, rid)


def _qa_author(cur, req: dict) -> Optional[str]:
    """The agent that did the work: its session's, else the QA task's assignee."""
    cur.execute("SELECT agent_id FROM qa_sessions WHERE request_id=%s AND agent_id IS NOT NULL ORDER BY started_at DESC LIMIT 1", (str(req["id"]),))
    hit = cur.fetchone()
    if hit:
        return str(hit["agent_id"])
    return _source_agent(cur, str(req["qa_task_id"])) if req.get("qa_task_id") else None


# ---------------------------------------------------------------- hooks: a session ended, a task finished

def after_session_end(sid: str) -> None:
    """A session ended well and nothing else of its request is running: the result is in. A session
    that failed leaves the request open, so the agent can try again; the task's end closes it.
    After the commit of what ended it, and it never raises."""
    from portal_backend import qa_run_tasks

    try:
        _finish_session(sid)
    except Exception:  # noqa: BLE001 - the session already ended
        logger.exception("QA return path failed for session %s", sid)
    qa_run_tasks.after_session_end(sid)


def _finish_session(sid: str) -> None:
    with db_cursor() as (conn, cur):
        s = qs.load_session(cur, sid)
        if not s.get("request_id") or s["status"] != "done":
            return
        cur.execute("SELECT 1 AS hit FROM qa_sessions WHERE request_id=%s AND status='running' LIMIT 1", (str(s["request_id"]),))
        if cur.fetchone():
            return
        req = load(cur, str(s["request_id"]))
        if req["kind"] == "triage":
            return  # its result is the diagnoses: it closes when the agent finishes the task
        done = finish(cur, req)
        conf = settings(cur, str(req["container_id"]))
        conn.commit()
    _auto_triage(done, conf)


def _qa_work(cur, task: dict) -> Optional[dict]:
    """The request this finished task did, newest first; a step's for this work revision."""
    tid = str(task["id"])
    cur.execute("SELECT * FROM qa_requests WHERE qa_task_id=%s ORDER BY created_at DESC LIMIT 1", (tid,))
    row = cur.fetchone()
    return dict(row) if row else None


def after_task_done(tid: str, agent_id: str) -> None:
    """A task reached needs_verification (or completed under its own autonomy), standalone or as a
    workflow step. If it was QA work its result goes back; if not, it may start QA. After the
    transition's commit: it never raises, because the transition already happened."""
    from portal_backend import qa_run_tasks

    decide = True
    try:
        decide = _after_done(tid, agent_id)
    except Exception:  # noqa: BLE001
        logger.exception("QA hook failed for task %s", tid)
    qa_run_tasks.after_task_done(tid)
    if decide is not False:  # the UI trigger, which reads git, decides after it
        _later(qa_run_tasks.consider, tid)


def _after_done(tid: str, agent_id: str) -> Optional[bool]:
    with db_cursor() as (conn, cur):
        cur.execute("SELECT * FROM tasks WHERE id=%s", (tid,))
        task = dict(cur.fetchone())
        req = _qa_work(cur, task)
        if req is not None:
            done = finish(cur, req) if req["status"] in OPEN else None
            req = done or req
            if _is_step(req):
                req = load(cur, str(req["id"]))
                land_evidence(cur, req)
            conf = settings(cur, str(req["container_id"]))
            conn.commit()
            _auto_triage(done, conf)
            return None
        if task.get("qa_step"):
            return None
        plan = _next_for(cur, task, agent_id)
    if plan is None:
        return None
    if plan == "ui_changes":
        _later(_trigger_on_ui, tid, agent_id)
        return False
    plan()
    return None


def _auto_triage(req: Optional[dict], conf: dict) -> None:
    """`qa_settings.auto_triage`: a failed request outside a workflow goes to triage, at most
    `max_per_run` findings. A workflow routes through its own triage step."""
    if not req or _is_step(req):
        return
    result = qs._json(req.get("result"), None) or {}
    with db_cursor(readonly=True) as (_, cur):
        ids = qa_triage.for_auto(cur, req, conf, result)
        who = _who(cur, req.get("requested_by_agent_id"))
    if ids and who:
        # What a setting started is not a person's click: its plan follows the project's rule.
        hand_off(str(req["container_id"]), {**who, "kind": "ai"},
                 {"kind": "triage", "platform": req.get("platform"), "finding_ids": ids, "on_fail": "report",
                  "build": qs._json(req.get("build"), None)},
                 source_task_id=str(req["source_task_id"]) if req.get("source_task_id") else None, origin="auto_triage")


def triage_findings(cid: str, who: dict, finding_ids: list[str], conditions: Any = None) -> dict:
    """"Triage" on a finding, or several, outside a workflow. It reproduces under `conditions`, else
    under the first finding's own (what it was found under, or what a person set on it)."""
    with db_cursor(readonly=True) as (_, cur):
        rows = qa_triage.rows_of(cur, finding_ids)
        if len(rows) != len(set(finding_ids)) or any(str(f["container_id"]) != cid for f in rows):
            raise HTTPException(404, "That finding is not a finding of this project.")
        cur.execute("SELECT platform FROM qa_sessions WHERE id=%s", (str(rows[0]["session_id"]),))
        session = cur.fetchone()
        source = None
        if rows[0].get("request_id"):
            cur.execute("SELECT source_task_id FROM qa_requests WHERE id=%s", (str(rows[0]["request_id"]),))
            source = cur.fetchone()
    return hand_off(cid, who, {"kind": "triage", "platform": session["platform"] if session else None,
                               "finding_ids": [str(f["id"]) for f in rows], "on_fail": "report",
                               "focus": rows[0]["title"] if len(rows) == 1 else None,
                               "conditions": qa_conditions.merge(rows[0].get("conditions"), conditions)},
                    source_task_id=str(source["source_task_id"]) if source and source.get("source_task_id") else None)


def _later(fn: Callable[..., None], *args: Any) -> None:
    if not BACKGROUND:
        fn(*args)
        return
    threading.Thread(target=fn, args=args, name=f"qa-trigger-{str(args[0])[:8]}", daemon=True).start()


def _who(cur, aid: Optional[str]) -> Optional[dict]:
    if not aid:
        return None
    cur.execute("SELECT id, kind, alias FROM agents WHERE id=%s AND terminated_at IS NULL", (str(aid),))
    row = cur.fetchone()
    return {"id": str(row["id"]), "kind": row["kind"], "alias": row["alias"]} if row else None


def _next_for(cur, task: dict, agent_id: str) -> Any:
    """What this finished task starts: another round, a re-check, the task's own "Send to Quality
    when finished", the project's trigger, or nothing. A callable that hands off, `ui_changes` when the diff must be read first, or None."""
    tid, cid = str(task["id"]), str(task["container_id"])
    if task["is_root"]:
        return None
    cur.execute("SELECT 1 AS hit FROM qa_sessions WHERE task_id=%s LIMIT 1", (tid,))
    if cur.fetchone():
        return None  # QA work done outside a request: testing it again would never end
    cur.execute("SELECT * FROM qa_requests WHERE source_task_id=%s ORDER BY created_at DESC LIMIT 1", (tid,))
    latest = cur.fetchone()
    latest = dict(latest) if latest else None
    if latest and latest["status"] in OPEN:
        return None
    if latest and latest["status"] == "failed" and (qs._json(latest.get("result"), None) or {}).get("reopened"):
        who = _who(cur, latest.get("requested_by_agent_id")) or _who(cur, agent_id)
        spec = {k: qs._json(latest.get(k), None) if k in ("scenario_ids", "tags", "acceptance", "build") else latest.get(k)
                for k in ("kind", "platform", "scenario_ids", "tags", "focus", "minutes", "acceptance", "build", "on_fail")}
        approved = str(latest["approved_by_agent_id"]) if latest.get("approved_by_agent_id") else None
        return lambda: hand_off(cid, who, spec, source_task_id=tid, origin="reopen", previous=latest, approved_by=approved)
    cur.execute("SELECT * FROM qa_findings WHERE filed_task_id=%s ORDER BY created_at LIMIT 1", (tid,))
    finding = cur.fetchone()
    if finding:
        finding = dict(finding)
        cur.execute("SELECT platform FROM qa_sessions WHERE id=%s", (str(finding["session_id"]),))
        session = cur.fetchone()
        who = _who(cur, agent_id)
        expected = finding.get("expected") or f"The problem \"{finding['title']}\" no longer happens."
        spec = {"kind": "check" if finding.get("scenario_id") else "explore", "platform": session["platform"] if session else None,
                "scenario_ids": [str(finding["scenario_id"])] if finding.get("scenario_id") else [],
                "focus": f"Re-check the finding \"{finding['title']}\": walk what showed it.", "acceptance": [expected],
                "on_fail": "report"}
        return lambda: hand_off(cid, who, spec, source_task_id=tid, origin="recheck", finding_id=str(finding["id"]))
    if task.get("workflow_id"):
        cur.execute("SELECT 1 AS hit FROM tasks WHERE workflow_id=%s AND qa_step IS NOT NULL LIMIT 1", (str(task["workflow_id"]),))
        if cur.fetchone():
            return None  # its QA step tests this work
    conf = settings(cur, cid)
    own = on_done_of(task)
    if own is not None and not task.get("workflow_id"):
        # The task's own choice beats the project's trigger, either way.
        return _own_call(cur, cid, tid, agent_id, conf, own) if own.get("enabled") else None
    if conf["trigger"] == "manual":
        return None
    if conf["trigger"] == "ui_changes":
        return "ui_changes"
    return _trigger_call(cur, cid, tid, agent_id, conf)


def on_done_of(task: dict) -> Optional[dict]:
    """The task's own choice for when its agent finishes (`tasks.qa_on_done`), or None: the
    project's trigger decides."""
    value = qs._json(task.get("qa_on_done"), None)
    return value if isinstance(value, dict) else None


def set_on_done(cur, task: dict, who: dict, *, enabled: Optional[bool], platform: Optional[str], device: Optional[str],
                kind: Optional[str], conditions: Any = None) -> Optional[dict]:
    """A person chooses whether this task goes to Quality when its agent finishes it. `enabled`
    None clears the choice: the project's trigger decides again. A workflow's task has its own
    Quality steps; the root task and a cancelled one have nothing to test. In the caller's
    transaction. Returns what is stored."""
    if task["is_root"]:
        raise HTTPException(409, "The project's root task can't go to Quality: choose a task with work on it.")
    if task.get("workflow_id"):
        raise HTTPException(409, "This task is a workflow step: its workflow decides what Quality does.")
    if task["status"] == "cancelled":
        raise HTTPException(409, "This task was cancelled, so there is nothing for Quality to test.")
    value = None if enabled is None else {
        "enabled": bool(enabled), "platform": platform if enabled else None, "device": (device or "").strip() or None if enabled else None,
        "kind": kind if enabled else None, "conditions": qa_conditions.clean(conditions) if enabled else None,
        "by": who["id"], "at": qs.now().isoformat()}
    cur.execute("UPDATE tasks SET qa_on_done=%s WHERE id=%s", (qs.dumps(value) if value is not None else None, str(task["id"])))
    return value


def _own_call(cur, cid: str, tid: str, agent_id: str, conf: dict, own: dict) -> Any:
    """The task's own "Send to Quality when finished": handed off as the person who turned it on,
    which approves the run's plan as a click on Send to QA does."""
    who = _who(cur, own.get("by")) or _who(cur, agent_id)
    spec = {"platform": own.get("platform") or conf.get("default_platform"), "device": own.get("device"),
            "kind": own.get("kind"), "on_fail": conf["on_fail"], "conditions": own.get("conditions")}
    return lambda: hand_off(cid, who, spec, source_task_id=tid)  # a person chose it: a handoff


def _trigger_call(cur, cid: str, tid: str, agent_id: str, conf: dict) -> Any:
    who = _who(cur, agent_id)
    spec = {"platform": conf.get("default_platform"), "on_fail": conf["on_fail"]}
    return lambda: hand_off(cid, who, spec, source_task_id=tid, origin="trigger")


def ui_touched(cur, tid: str) -> bool:
    """Whether this round's work changed UI files, read as the evidence pack reads the runs."""
    from portal_backend import evidence_pack as pack

    runs, _ = pack._round_runs(cur, tid)
    files = [f for r in runs for f in (pack._run_changes(cur, r)[0].get("files") or [])]
    return ep.is_ui_touching(files)


def _trigger_on_ui(tid: str, agent_id: str) -> None:
    from portal_backend import qa_run_tasks

    try:
        with db_cursor(readonly=True) as (_, cur):
            cur.execute("SELECT container_id FROM tasks WHERE id=%s", (tid,))
            cid = str(cur.fetchone()["container_id"])
            call = _trigger_call(cur, cid, tid, agent_id, settings(cur, cid)) if ui_touched(cur, tid) else None
        if call:
            call()
    except Exception:  # noqa: BLE001 - the task already finished
        logger.exception("QA trigger failed for task %s", tid)
    qa_run_tasks.consider(tid)


# ---------------------------------------------------------------- proof in the evidence pack

def _line_key(text: str) -> str:
    return " ".join((text or "").split()).casefold()


def proof_for_task(cur, tid: str, start: Any) -> dict:
    """What QA proved about this task's current round: `{requests, lines}`, `lines` keyed by a
    definition-of-done line. Requests from before the round (a rejection, a QA send-back) are out."""
    cur.execute(f"""SELECT * FROM qa_requests WHERE source_task_id=%s AND status IN ('passed','failed','blocked')
                      AND ({sql.ts_param()} IS NULL OR created_at >= {sql.ts_param()}) ORDER BY created_at""", (tid, start, start))
    requests, lines = [], {}
    for r in cur.fetchall():
        result = qs._json(r.get("result"), None) or {}
        requests.append({"id": str(r["id"]), "kind": r["kind"], "platform": r.get("platform"), "round": r["round"],
                         "status": r["status"], "summary": result.get("summary")})
        for line in result.get("lines") or []:
            if line.get("verdict"):
                lines[_line_key(line["text"])] = {**line, "request_id": str(r["id"])}
    return {"requests": requests, "lines": lines}


def proof_signature(proof: dict) -> str:
    return hashlib.sha1(json.dumps(proof, sort_keys=True, default=str).encode()).hexdigest()[:12]
