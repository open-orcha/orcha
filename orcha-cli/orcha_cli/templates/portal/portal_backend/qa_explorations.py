"""Orcha QA explorations (migration 095): what a person keeps on a session and what the session
screens read beyond its rows.

- A session's series: Run again stays in it, Duplicate starts one; a session an agent starts on
  its own joins the newest session with the same kind, platform and goal, so its score has a
  previous one to move against.
- Queued sessions: a row with `queued_at` and no `claimed_at`. Its status stays `running` (093's
  check allows no other, and SQLite cannot change a check), and the agent that starts a session for
  its task takes the row. A session whose device another run holds is back in that state, with what
  it waits for in `result.waiting`: the tool server reads that from the machine-wide lock files, so
  the line holds across projects and this file only shows it.
- Sessions nobody is running end `abandoned` with a plain reason (`stop_reason`), on read and from
  the portal's sweeper, and `again_plan` says what Run again does about the task left behind.
- The audit's measurements (`qa_measured`), kept apart from what an agent judged.
- The App model: what the agents understand the app to be, a numbered version per change, built
  from the newest briefing, the feature list, the flow queue and the walks.
"""

from __future__ import annotations

import datetime as dt
import json
import time
from typing import Any, Optional

from fastapi import HTTPException

from portal_backend import qa_store as qs
from portal_backend import sql
from portal_backend.database import db_cursor

#: Worst first: what the UI's severity dialog offers. `trivial` is what the screens call cosmetic.
SEVERITIES = ("blocker", "major", "minor", "trivial")
MEASURED_SEVERITIES = ("blocker", "major", "minor", "cosmetic", "info")
MODEL_SOURCES = ("briefing", "plan", "walks", "person")
MAX_VERSIONS = 50


# ---------------------------------------------------------------- series and the queue

def _goal_key(goal: Optional[str]) -> str:
    return " ".join((goal or "").lower().split())


def previous_in_series(cur, cid: str, kind: str, platform: str, goal: Optional[str]) -> Optional[dict]:
    """The newest session this one repeats: same kind, platform and goal."""
    cur.execute(
        """SELECT id, series_id, goal FROM qa_sessions
            WHERE container_id=%s AND kind=%s AND platform=%s
            ORDER BY started_at DESC LIMIT 50""",
        (cid, kind, platform),
    )
    want = _goal_key(goal)
    for r in cur.fetchall():
        if _goal_key(r["goal"]) == want:
            return dict(r)
    return None


def series_of(cur, cid: str, kind: str, platform: str, goal: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    """(series_id, previous_session_id) for a new session; (None, None) starts a series."""
    prev = previous_in_series(cur, cid, kind, platform, goal)
    if not prev:
        return None, None
    return str(prev["series_id"] or prev["id"]), str(prev["id"])


def cancel_queued_task(request: Any, task_id: str, who: dict, reason: str = "Stopped in the QA tab before an agent picked it up.") -> None:
    """Cancel the open task behind a session a person stopped. One that already ended stays."""
    from portal_backend.schemas.task_operations import TaskCancel
    from portal_backend.task_cancellation_routes import close_task

    try:
        close_task(task_id, TaskCancel(actor_agent_id=str(who["id"]), reason=reason), request, tell_owners=False)
    except HTTPException as e:
        if e.status_code != 409:
            raise


def claim_queued(cur, cid: str, who: dict, *, kind: str, platform: str, task_id: Optional[str],
                 device_name: Optional[str], device_udid: Optional[str], app_id: Optional[str],
                 budget_minutes: Optional[int], goal: Optional[str], draft_sources: Optional[str] = None) -> Optional[dict]:
    """The queued row an agent's new session takes, when one waits for its task."""
    if not task_id:
        return None
    cur.execute(
        """SELECT * FROM qa_sessions
            WHERE container_id=%s AND task_id=%s AND kind=%s AND platform=%s AND status='running'
              AND queued_at IS NOT NULL AND claimed_at IS NULL
            ORDER BY queued_at LIMIT 1""",
        (cid, task_id, kind, platform),
    )
    row = cur.fetchone()
    if not row:
        return None
    sid = str(row["id"])
    at = qs.now()
    cur.execute(
        """UPDATE qa_sessions SET claimed_at=%s, started_at=%s, last_seen_at=%s, agent_id=%s,
                  device_name=COALESCE(%s, device_name), device_udid=COALESCE(%s, device_udid),
                  app_id=COALESCE(%s, app_id), budget_minutes=COALESCE(%s, budget_minutes),
                  goal=COALESCE(%s, goal), draft_sources=COALESCE(%s, draft_sources)
            WHERE id=%s""",
        (at, at, at, who["id"], device_name, device_udid, app_id, budget_minutes, goal, draft_sources, sid),
    )
    return qs.load_session(cur, sid)


def queue_session(cur, cid: str, who: dict, *, kind: str, platform: str, task_id: Optional[str], goal: Optional[str],
                  budget_minutes: Optional[int], agent_id: Optional[str], name: Optional[str] = None,
                  series_id: Optional[str] = None, previous_id: Optional[str] = None, new_series: bool = False,
                  draft_sources: Optional[str] = None) -> dict:
    """A session waiting for its agent. In its series unless `new_series`."""
    t = qs.target(cur, cid, platform) or {}
    if not new_series and not series_id:
        series_id, previous_id = series_of(cur, cid, kind, platform, goal)
    sid = qs.new_id()
    at = qs.now()
    cur.execute(
        """INSERT INTO qa_sessions (id, container_id, kind, platform, task_id, agent_id, device_name, app_id, status,
                                    budget_minutes, goal, name, series_id, previous_session_id, queued_at, started_at,
                                    last_seen_at, draft_sources)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'running',%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        (sid, cid, kind, platform, task_id, agent_id, t.get("device_name"), t.get("app_id"), budget_minutes, goal, name,
         series_id or sid, previous_id, at, at, at, draft_sources),
    )
    return qs.load_session(cur, sid)


def queue_place(cur, s: dict) -> Optional[dict]:
    """A queued session's place in line and what it waits for; None once it is taken. Waiting for a
    device, the place is its place in the machine's line, across projects. `reason` says it all."""
    if not s.get("queued_at") or s.get("claimed_at") or s.get("status") != "running":
        return None
    waiting = None
    if s.get("agent_id"):
        cur.execute("SELECT alias FROM agents WHERE id=%s", (str(s["agent_id"]),))
        a = cur.fetchone()
        waiting = a["alias"] if a else None
    wait = waits_for(s)
    if wait:
        return {"position": int(wait.get("position") or 1), "waiting": waiting, "device": wait.get("device"),
                "devices": wait.get("devices") or [], "used_by": wait.get("used_by"), "project": wait.get("project"),
                "kind": wait.get("kind"), "held_session_id": wait.get("held_session_id"), "reason": wait.get("reason")}
    cur.execute(
        """SELECT count(*) AS n FROM qa_sessions
            WHERE container_id=%s AND status='running' AND queued_at IS NOT NULL AND claimed_at IS NULL
              AND queued_at < %s""",
        (str(s["container_id"]), s["queued_at"]),
    )
    ahead = int(cur.fetchone()["n"] or 0)
    reason = f"Waiting for {waiting} to pick it up." if waiting else "Waiting for an agent to pick it up."
    return {"position": ahead + 1, "waiting": waiting, "device": None, "devices": [], "used_by": None, "project": None,
            "kind": None, "held_session_id": None, "reason": reason}


def waits_for(s: dict) -> Optional[dict]:
    """What the tool server said this session waits for, while it waits for a device."""
    if not s.get("queued_at") or s.get("claimed_at") or s.get("status") != "running":
        return None
    return (qs._json(s.get("result"), None) or {}).get("waiting")


# ---------------------------------------------------------------- sessions nobody is running

#: No heartbeat for this long ends a session; with no worker left, this grace after the last one ended.
SILENT_SECONDS = 15 * 60
NO_WORKER_GRACE_SECONDS = 2 * 60
SWEEP_EVERY_SECONDS = 30
#: How often the portal's sweeper looks at every project (`application_lifecycle`).
SWEEPER_SECONDS = 60
STOPPED_WORDS = "The agent stopped before finishing."
REPLACED_WORDS = "The agent's worker stopped, and a new one started this run over."
_RUN_WORDS = {"killed": "The agent's worker was stopped before it finished.",
              "rate_limited": "The agent hit a rate limit and stopped before finishing.",
              "failed": "The agent's worker failed before it finished."}
_STOP_DEFAULT = {"abandoned": STOPPED_WORDS, "cancelled": "It was stopped before it finished.",
                 "failed": "It failed before it finished."}
STOPPED = tuple(_STOP_DEFAULT)
#: A task in these states can still be worked: Run again goes on with it.
OPEN_TASK = ("pending", "ready", "in_progress")
_swept: dict[str, float] = {}


def _when(value: Any) -> Optional[dt.datetime]:
    if isinstance(value, str):
        try:
            value = dt.datetime.fromisoformat(value)
        except ValueError:
            return None
    if isinstance(value, dt.datetime):
        return value if value.tzinfo else value.replace(tzinfo=dt.timezone.utc)
    return None


def _why_stopped(cur, s: dict) -> Optional[str]:
    """Why nobody is going to finish this running session, in words; None while somebody may.
    Its task's worker left (only a run of this session's agent that was there once it started
    counts, and a respawn gets a grace), or nothing was heard for a long time: the tool server beats
    while it holds a session or waits for a device. A queued row no agent has come for keeps
    waiting: that is the no-agent state, not a stop."""
    at = qs.now()
    start = _when(s.get("started_at"))
    if s.get("task_id") and s.get("agent_id"):
        # The worker died and a new one began the same run: this one can never finish.
        cur.execute("""SELECT 1 AS hit FROM qa_sessions
                        WHERE task_id=%s AND agent_id=%s AND kind=%s AND platform=%s AND status='running' AND started_at>%s LIMIT 1""",
                    (str(s["task_id"]), str(s["agent_id"]), s["kind"], s["platform"], s["started_at"]))
        if cur.fetchone():
            return REPLACED_WORDS
    if s.get("task_id"):
        cur.execute("""SELECT agent_id, status, ended_at FROM worker_runs
                        WHERE task_id=%s OR run_id IN (SELECT run_id FROM worker_run_tasks WHERE task_id=%s)""",
                    (str(s["task_id"]), str(s["task_id"])))
        runs = [dict(r) for r in cur.fetchall()]
        if s.get("agent_id"):
            runs = [r for r in runs if str(r["agent_id"]) == str(s["agent_id"])]
        if runs and not any(r["status"] == "running" and r["ended_at"] is None for r in runs):
            ended = [(t, r) for r in runs if (t := _when(r["ended_at"]))]
            last, run = max(ended, key=lambda p: p[0]) if ended else (start, runs[0])
            if last and (not start or last >= start) and (at - last).total_seconds() >= NO_WORKER_GRACE_SECONDS:
                return _RUN_WORDS.get(str(run["status"]), STOPPED_WORDS)
    if s.get("queued_at") and not s.get("claimed_at") and not waits_for(s):
        return None
    seen = _when(s.get("last_seen_at")) or start
    if seen and (at - seen).total_seconds() >= SILENT_SECONDS:
        return f"Nothing was heard from the agent for {SILENT_SECONDS // 60} minutes."
    return None


def sweep_abandoned(cid: str, *, force: bool = False) -> None:
    """Running sessions nobody will finish end `abandoned`, with the reason in words. Called on read
    (at most once per `SWEEP_EVERY_SECONDS` per project) and by the portal's sweeper. It looks with a
    read and writes only when there is something to end, deciding again inside the write, so polling
    pages never queue on the database and a heartbeat that just came in wins."""
    from portal_backend import qa_handoff
    from portal_backend.agent_status import log_event

    clock = time.monotonic()
    if not force and clock - _swept.get(cid, -SWEEP_EVERY_SECONDS) < SWEEP_EVERY_SECONDS:
        return
    _swept[cid] = clock
    with db_cursor(readonly=True) as (_, cur):
        cur.execute("SELECT * FROM qa_sessions WHERE container_id=%s AND status='running'", (cid,))
        due = [str(s["id"]) for s in [dict(r) for r in cur.fetchall()] if _why_stopped(cur, s)]
    if not due:
        return
    ended: list[str] = []
    with db_cursor() as (conn, cur):
        for sid in due:
            s = qs.load_session(cur, sid)
            words = _why_stopped(cur, s) if s["status"] == "running" else None
            if not words:
                continue
            kept = {k: v for k, v in (qs._json(s.get("result"), None) or {}).items() if k != "waiting"}
            cur.execute("UPDATE qa_sessions SET status='abandoned', ended_at=%s, result=%s WHERE id=%s AND status='running'",
                        (qs.now(), qs.dumps({**kept, "error": words}), sid))
            qs.end_open_walks(cur, sid, "the agent stopped before finishing")
            log_event(cur, cid, "ai", str(s["agent_id"]) if s.get("agent_id") else None, "qa_session", sid, "qa_session_ended",
                      {"status": "abandoned", "kind": s["kind"], "reason": words})
            ended.append(sid)
        conn.commit()
    for sid in ended:
        qa_handoff.after_session_end(sid)


def sweep_all() -> None:
    """One pass of the portal's sweeper over every project with a running session. A project that
    fails is left for the next pass."""
    with db_cursor(readonly=True) as (_, cur):
        cur.execute("SELECT DISTINCT container_id FROM qa_sessions WHERE status='running'")
        cids = [str(r["container_id"]) for r in cur.fetchall()]
    for cid in cids:
        try:
            sweep_abandoned(cid, force=True)
        except Exception as e:  # noqa: BLE001 - the sweeper outlives any one project
            print(f"[qa-sweep] {cid}: {type(e).__name__}: {e}", flush=True)


def stop_reason(s: dict) -> Optional[str]:
    """Why a session ended short, in words; None while it runs and when it finished."""
    if s.get("status") not in _STOP_DEFAULT:
        return None
    result = qs._json(s.get("result"), None) or {}
    return result.get("error") or result.get("reason") or _STOP_DEFAULT[s["status"]]


def add_state(cur, rows: list[dict]) -> None:
    """Add `queued`, `queue` and `stop_reason` to public session rows, in place."""
    for r in rows:
        if "queued_at" in r:
            r["queue"] = queue_place(cur, r)
            r["queued"] = r["queue"] is not None
            r["stop_reason"] = stop_reason(r)


def again_plan(cur, cid: str, task_id: Optional[str]) -> dict:
    """What Run again does after a run stopped: `{mode, task_id, agent_alias, says}`. An open task is
    still the work, so it goes on with no second task: `resume` wakes its agent. `add_agent`: nobody
    can take it, so a QA agent comes first and picks it up. `new_task`: there is nothing open to go on
    with. A workflow step's task stays with its owner, so a run again beside it is a new task."""
    from portal_backend import qa_handoff

    task = None
    if task_id:
        cur.execute("SELECT id, status, workflow_id FROM tasks WHERE id=%s AND container_id=%s", (str(task_id), cid))
        task = cur.fetchone()
    resumable = bool(task and task["status"] in OPEN_TASK and not task["workflow_id"])
    agent = active_assignee(cur, str(task["id"])) if resumable else None
    qa_id = qa_handoff.qa_agent_id(cur, cid)
    if resumable and agent:
        return {"mode": "resume", "task_id": str(task["id"]), "agent_alias": agent["alias"],
                "says": f"Run again wakes {agent['alias']} on the same task, so no second task is made."}
    if resumable and qa_id:
        cur.execute("SELECT alias FROM agents WHERE id=%s", (qa_id,))
        alias = cur.fetchone()["alias"]
        return {"mode": "resume", "task_id": str(task["id"]), "agent_alias": alias,
                "says": f"Run again gives the waiting task to {alias}, so no second task is made."}
    if resumable:
        return {"mode": "add_agent", "task_id": str(task["id"]), "agent_alias": None,
                "says": "Add a QA agent first: it picks up the waiting task."}
    cur.execute("SELECT count(*) AS n FROM agents WHERE container_id=%s AND kind='ai' AND terminated_at IS NULL", (cid,))
    if not int(cur.fetchone()["n"] or 0):
        return {"mode": "add_agent", "task_id": None, "agent_alias": None,
                "says": "Add a QA agent first, then Run again starts a new task."}
    return {"mode": "new_task", "task_id": None, "agent_alias": None, "says": "Run again starts a new task for the same work."}


def active_assignee(cur, tid: str) -> Optional[dict]:
    """The live AI agent assigned to this task, or None."""
    cur.execute("""SELECT a.id, a.alias FROM agent_tasks x JOIN agents a ON a.id=x.agent_id
                    WHERE x.task_id=%s AND x.assignment_status IN ('assigned','accepted','working')
                      AND a.kind='ai' AND a.terminated_at IS NULL LIMIT 1""", (tid,))
    row = cur.fetchone()
    return dict(row) if row else None


def resume_task(cur, cid: str, tid: str, plan: dict, who: dict) -> None:
    """Run again on an open task: wake its agent, the way restart recovery hands a task back, or
    give it to the project's QA agent when it has none. Nothing changes the task's status."""
    from portal_backend import qa_handoff
    from portal_backend.agent_status import recompute_agent_status
    from portal_backend.events import publish_event

    if plan["mode"] != "resume":
        return
    agent = active_assignee(cur, tid)
    aid = str(agent["id"]) if agent else qa_handoff.qa_agent_id(cur, cid)
    if not agent:
        cur.execute("INSERT INTO agent_tasks (agent_id, task_id, assignment_status) VALUES (%s,%s,'assigned') "
                    "ON CONFLICT (agent_id, task_id) DO UPDATE SET assignment_status='assigned'", (aid, tid))
        recompute_agent_status(cur, aid)
    cur.execute("SELECT title FROM tasks WHERE id=%s", (tid,))
    publish_event(cur, cid, aid, "task_assigned", {"task_id": tid, "title": cur.fetchone()["title"], "reason": "qa_run_again",
                                                   "by_id": who["id"]})


# ---------------------------------------------------------------- what the audit measured

def add_measured(cur, s: dict, rows: list[dict]) -> int:
    """Store measurements, one per fingerprint per session; a repeat changes nothing."""
    sid, cid = str(s["id"]), str(s["container_id"])
    added = 0
    for r in rows:
        cur.execute("SELECT 1 AS hit FROM qa_measured WHERE session_id=%s AND fingerprint=%s", (sid, r["fingerprint"]))
        if cur.fetchone():
            continue
        frame = r.get("frame_id")
        if frame:
            qs.require_frames_in(cur, cid, [frame])
        cur.execute(
            """INSERT INTO qa_measured (id, container_id, session_id, fingerprint, kind, severity, summary, measured,
                                        threshold, unit, rect, element_label, element_identifier, appearance, confident,
                                        extra, screen_key, screen_hash, frame_id, step_seq, created_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (qs.new_id(), cid, sid, r["fingerprint"], r["kind"], r["severity"], r["summary"], r.get("measured"),
             r.get("threshold"), r.get("unit"), qs.dumps(r["rect"]) if r.get("rect") is not None else None,
             r.get("element_label"), r.get("element_identifier"), r.get("appearance"), bool(r.get("confident", True)),
             qs.dumps(r.get("extra") or {}), r.get("screen_key"), r.get("screen_hash"), frame, r.get("step_seq"), qs.now()),
        )
        added += 1
    return added


def measured_of(cur, sids: list[str]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {sid: [] for sid in sids}
    if not sids:
        return out
    cur.execute(f"SELECT * FROM qa_measured WHERE {sql.in_list('session_id')} ORDER BY created_at",
                (sql.list_param(sids),))
    for r in cur.fetchall():
        row = qs.public(r)
        row["confident"] = bool(row.get("confident"))
        out[str(r["session_id"])].append(row)
    return out


# ---------------------------------------------------------------- the App model

_KEY_CRITICALITY = {"high": "high", "medium": "normal", "low": "low"}
_WF_STATUS = {"passed": "passed", "failed": "failed", "unreachable": "unreachable"}


def _text(v: Any) -> str:
    return v.strip() if isinstance(v, str) else ""


def _persona(p: Any) -> Optional[dict]:
    if isinstance(p, dict) and _text(p.get("name")):
        name = _text(p["name"])
        return {"key": qs.slug(name) or name, "name": name, "goal": _text(p.get("goal")) or None}
    if isinstance(p, str) and p.strip():
        return {"key": qs.slug(p) or p.strip(), "name": p.strip(), "goal": None}
    return None


def build_app_model(cur, cid: str, platform: str) -> Optional[dict]:
    """The model as what is stored says it now; None before there is anything to say."""
    cur.execute(
        """SELECT briefing FROM qa_sessions WHERE container_id=%s AND platform=%s AND briefing IS NOT NULL
            ORDER BY started_at DESC LIMIT 1""",
        (cid, platform),
    )
    row = cur.fetchone()
    briefing = qs._json(row["briefing"], None) if row else None
    briefing = briefing if isinstance(briefing, dict) else {}
    cur.execute("SELECT key, name, summary FROM qa_features WHERE container_id=%s ORDER BY key", (cid,))
    jobs = [{"key": r["key"], "name": r["name"], "why": r["summary"]} for r in cur.fetchall()]
    cur.execute("SELECT * FROM qa_flows WHERE container_id=%s AND platform=%s ORDER BY score DESC, created_at", (cid, platform))
    flows = [dict(r) for r in cur.fetchall()]
    if not briefing and not flows:
        return None
    cur.execute(
        """SELECT w.id, w.flow_id, w.status, w.reason, w.started_at, w.ended_at, w.session_id, w.steps, w.scenario_id
             FROM qa_walks w JOIN qa_flows f ON f.id = w.flow_id
            WHERE f.container_id=%s AND f.platform=%s ORDER BY w.started_at""",
        (cid, platform),
    )
    walks: dict[str, list[dict]] = {}
    for r in cur.fetchall():
        walks.setdefault(str(r["flow_id"]), []).append(dict(r))
    cur.execute("SELECT id, name FROM qa_scenarios WHERE container_id=%s AND platform=%s", (cid, platform))
    scenario_name = {str(r["id"]): r["name"] for r in cur.fetchall()}
    workflows = []
    for f in flows:
        mine = [w for w in walks.get(str(f["id"]), []) if w["status"] != "walking"]
        settled = [w for w in mine if w["status"] in _WF_STATUS]
        last = settled[-1] if settled else None
        steps = qs._json(f.get("steps"), [])
        screens = [s["screen"] for s in steps if isinstance(s, dict) and _text(s.get("screen"))]
        for w in mine:
            screens += [s["screen_key"] for s in qs._json(w.get("steps"), []) if isinstance(s, dict) and _text(s.get("screen_key"))]
        data = qs._json(f.get("data"), {})
        code = _text(data.get("code_ref")) if isinstance(data, dict) else ""
        workflows.append({
            "key": f["key"], "name": f["name"], "persona": f.get("persona"), "job": None,
            "criticality": _KEY_CRITICALITY.get(f.get("criticality"), "normal"),
            "steps": steps, "data": data,
            "evidence": {
                "routes": [], "screens": list(dict.fromkeys(screens)), "tests": [], "docs": [], "code": [code] if code else [],
                "scenarios": list(dict.fromkeys(scenario_name[str(w["scenario_id"])] for w in mine
                                                if w.get("scenario_id") and str(w["scenario_id"]) in scenario_name)),
                "runs": [{"run_id": str(w["session_id"]), "walk_id": str(w["id"]), "status": w["status"],
                          "at": qs.iso(w.get("ended_at") or w.get("started_at"))} for w in mine],
            },
            "risk": {"never_walked": not mine, "failed_recently": bool(last and last["status"] == "failed"),
                     "changed_at": None, "covered_by": sum(1 for w in mine if w.get("scenario_id"))},
            "status": _WF_STATUS.get(last["status"], "unwalked") if last else "unwalked",
            "last_walk": {"walk_id": str(last["id"]), "status": last["status"], "reason": last.get("reason"),
                          "at": qs.iso(last.get("ended_at") or last.get("started_at"))} if last else None,
            "sources": [f.get("source")] if f.get("source") else [],
        })
    personas = [p for p in map(_persona, briefing.get("personas") or []) if p]
    read = briefing.get("sources_read") if isinstance(briefing.get("sources_read"), dict) else {}
    return {
        "purpose": _text(briefing.get("app_summary")),
        "personas": personas,
        "core_jobs": jobs,
        "workflows": workflows,
        "built_from": {"map_build_id": None, "tests": int(read.get("tests") or 0), "docs": int(read.get("docs") or 0),
                       "scenarios": int(read.get("scenarios") or 0)},
    }


def _canonical(model: Any) -> str:
    return json.dumps(model, sort_keys=True, default=str)


def snapshot_app_model(cur, cid: str, platform: str, source: str, summary: Optional[str]) -> Optional[int]:
    """A new version when the model changed; the version number, or None when nothing did."""
    model = build_app_model(cur, cid, platform)
    if model is None:
        return None
    cur.execute(
        "SELECT version, model FROM qa_app_models WHERE container_id=%s AND platform=%s ORDER BY version DESC LIMIT 1",
        (cid, platform),
    )
    last = cur.fetchone()
    if last and _canonical(qs._json(last["model"], {})) == _canonical(model):
        return None
    version = int(last["version"]) + 1 if last else 1
    cur.execute(
        """INSERT INTO qa_app_models (id, container_id, platform, version, source, summary, model, created_at)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
        (qs.new_id(), cid, platform, version, source, summary, qs.dumps(model), qs.now()),
    )
    return version


def app_model_payload(cur, cid: str, platform: str, version: Optional[int]) -> dict:
    cur.execute(
        """SELECT version, source, summary, created_at FROM qa_app_models
            WHERE container_id=%s AND platform=%s ORDER BY version DESC LIMIT %s""",
        (cid, platform, MAX_VERSIONS),
    )
    versions = [{**dict(r), "created_at": qs.iso(r["created_at"])} for r in cur.fetchall()]
    empty = {"model": None, "version": None, "source": None, "summary": None, "created_at": None, "versions": versions}
    if not versions:
        return empty
    pick = version if version is not None else versions[0]["version"]
    cur.execute("SELECT * FROM qa_app_models WHERE container_id=%s AND platform=%s AND version=%s", (cid, platform, pick))
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, f"the App model has no version {pick}")
    return {"model": qs._json(row["model"], {}), "version": row["version"], "source": row["source"],
            "summary": row["summary"], "created_at": qs.iso(row["created_at"]), "versions": versions}
