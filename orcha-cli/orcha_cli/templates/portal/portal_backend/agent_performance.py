"""Agent performance (evals-lite): outcome metrics per agent and per project.

Read-only. Every figure is derived from records the portal ALREADY writes; there is no
new table and no new write path:

  * verified        — ``events`` rows ``(entity_type='task', event_type='verified')`` with
                      ``detail.approved = true`` (task_verification_routes). Only a HUMAN
                      verification counts; a full-autonomy auto-complete (``status_changed``
                      ``auto_completed``) is NOT a verification and is never counted as one.
                      The root task is excluded (it is the project, not a unit of work).
  * rework          — a human rejection (``verified`` with ``approved = false``) PLUS an AI
                      manager pre-review send-back (``manager_review_recorded`` with
                      ``decision = 'send_back'``, review_routing / mig 057).
  * first pass      — a verified task with NO rework event before its verification.
  * time to verified — ``tasks.started_at`` (else ``created_at``) → the verification event.
  * cost / verified — the dollar cost of the agent's finished runs on its verified tasks
                      (``worker_runs.task_id``, the same attribution the spend drilldown
                      uses). A task is METERED only when every one of those runs reported a
                      positive ``total_cost_usd``; anything else (subscription billing, an
                      unpriced model, no runs) is "not metered" and EXCLUDED — never $0.
  * plan approval   — ``decisions`` with ``subject_type = 'plan_approval'``: approvals over
                      approvals + rejections (attributed to the decision's target agent,
                      else the task's assignees).
  * escalations     — ``events`` ``(entity_type='request', event_type='escalated')``, i.e. the
                      agent's ask went to a human (by the agent or by the expiry sweep),
                      attributed to the request's requester.

Truthfulness (brief §3): counts are always real counts (0 is a real zero). Every RATE /
MEDIAN / AVERAGE carries its sample size and ``enough = n >= MIN_SAMPLE``; below that the
value is ``None`` and the UI says "not enough data" instead of a noisy number.

Ranges are UTC calendar days (same vocabulary as the Metrics page): 7d / 30d / 90d, or
``all`` (series capped at the last 52 weeks).
"""

from __future__ import annotations

import datetime as _dt
import math
import statistics
from typing import Iterable, Optional

MIN_SAMPLE = 3
RANGES = ("7d", "30d", "90d", "all")
_RANGE_DAYS = {"7d": 7, "30d": 30, "90d": 90}
# (bucket width in days) per range: daily for the short windows, 10-day for 90d, weekly for all.
_BUCKET_DAYS = {"7d": 1, "30d": 1, "90d": 10, "all": 7}
MAX_ALL_BUCKETS = 52


# --------------------------------------------------------------------------- #
# Range + buckets (pure)
# --------------------------------------------------------------------------- #

def _utc_today(now: _dt.datetime) -> _dt.date:
    return now.astimezone(_dt.timezone.utc).date()


def _day_start(d: _dt.date) -> _dt.datetime:
    return _dt.datetime(d.year, d.month, d.day, tzinfo=_dt.timezone.utc)


def range_since(range_key: str, now: _dt.datetime) -> Optional[_dt.datetime]:
    """Inclusive lower bound of the window (start of a UTC day), None for ``all``."""
    if range_key == "all":
        return None
    days = _RANGE_DAYS[range_key]
    return _day_start(_utc_today(now) - _dt.timedelta(days=days - 1))


def build_buckets(
    range_key: str, now: _dt.datetime, first_activity: Optional[_dt.datetime] = None
) -> list[dict]:
    """Contiguous buckets ending today (UTC). Each: {start, end (exclusive), label}."""
    today = _utc_today(now)
    width = _BUCKET_DAYS[range_key]
    if range_key == "all":
        if first_activity is None:
            return []
        span_days = (today - _utc_today(first_activity)).days + 1
        n = min(MAX_ALL_BUCKETS, max(1, math.ceil(span_days / width)))
    else:
        n = math.ceil(_RANGE_DAYS[range_key] / width)
    end_excl = today + _dt.timedelta(days=1)
    first = end_excl - _dt.timedelta(days=n * width)
    if range_key != "all":
        # align the first bucket with the window start (90d/10 is exact; kept general)
        first = max(first, today - _dt.timedelta(days=_RANGE_DAYS[range_key] - 1))
    out = []
    start = first
    while start < end_excl:
        end = min(start + _dt.timedelta(days=width), end_excl)
        out.append({"start": _day_start(start), "end": _day_start(end)})
        start = end
    return out


def bucket_index(buckets: list[dict], ts: _dt.datetime) -> Optional[int]:
    for i, b in enumerate(buckets):
        if b["start"] <= ts < b["end"]:
            return i
    return None


# --------------------------------------------------------------------------- #
# Metric shapes (pure)
# --------------------------------------------------------------------------- #

def _rate(num: int, den: int) -> dict:
    enough = den >= MIN_SAMPLE
    return {
        "value": (num / den) if (enough and den) else None,
        "numerator": num,
        "denominator": den,
        "enough": enough,
    }


def _median_seconds(durations: list[float]) -> dict:
    n = len(durations)
    enough = n >= MIN_SAMPLE
    return {
        "value": float(statistics.median(durations)) if enough else None,
        "n": n,
        "enough": enough,
    }


def _cost(metered_costs: list[float], unmetered: int) -> dict:
    n = len(metered_costs)
    enough = n >= MIN_SAMPLE
    return {
        # never $0: a metered task has a strictly positive cost by construction
        "value": (sum(metered_costs) / n) if enough else None,
        "metered_tasks": n,
        "unmetered_tasks": unmetered,
        "total_metered_usd": float(sum(metered_costs)) if n else None,
        "enough": enough,
    }


def compute_metrics(
    *,
    verified: list[dict],
    rework: list[dict],
    plan_decisions: list[dict],
    escalations: list[dict],
    task_costs: dict,
    since: Optional[_dt.datetime],
) -> dict:
    """One scope's metrics from pre-filtered facts.

    verified:        [{task_id, verified_at, started_at}]  (in range, this scope)
    rework:          [{task_id, at, kind: 'rejection'|'send_back'}]  (ALL time, this scope)
    plan_decisions:  [{decision: 'approve'|'reject', at}]  (in range, this scope)
    escalations:     [{at}]  (in range, this scope)
    task_costs:      {task_id: {runs, priced, cost}}  (this scope's runs on verified tasks)
    """
    in_range = (lambda ts: True) if since is None else (lambda ts: ts >= since)
    rework_by_task: dict[str, list[_dt.datetime]] = {}
    for r in rework:
        rework_by_task.setdefault(r["task_id"], []).append(r["at"])

    first_pass = 0
    durations: list[float] = []
    metered: list[float] = []
    unmetered = 0
    for v in verified:
        prior = [t for t in rework_by_task.get(v["task_id"], []) if t <= v["verified_at"]]
        if not prior:
            first_pass += 1
        if v.get("started_at") is not None:
            d = (v["verified_at"] - v["started_at"]).total_seconds()
            if d >= 0:
                durations.append(d)
        c = task_costs.get(v["task_id"])
        if c and c["runs"] > 0 and c["priced"] == c["runs"] and c["cost"] > 0:
            metered.append(float(c["cost"]))
        else:
            unmetered += 1

    rework_in_range = [r for r in rework if in_range(r["at"])]
    approvals = sum(1 for p in plan_decisions if p["decision"] == "approve")
    rejections = sum(1 for p in plan_decisions if p["decision"] == "reject")
    return {
        "tasks_verified": len(verified),
        "first_pass_rate": _rate(first_pass, len(verified)),
        "rework": {
            "total": len(rework_in_range),
            "human_rejections": sum(1 for r in rework_in_range if r["kind"] == "rejection"),
            "manager_send_backs": sum(1 for r in rework_in_range if r["kind"] == "send_back"),
        },
        "median_time_to_verified_seconds": _median_seconds(durations),
        "cost_per_verified_task_usd": _cost(metered, unmetered),
        "plan_approval_rate": {
            **_rate(approvals, approvals + rejections),
            "approved": approvals,
            "rejected": rejections,
        },
        "escalations": len(escalations),
    }


def compute_series(buckets: list[dict], verified: Iterable[dict], rework: Iterable[dict],
                   since: Optional[_dt.datetime]) -> list[dict]:
    """Per bucket: verified count + rework count (the sparkline's data)."""
    out = [{"start": b["start"].isoformat(), "end": b["end"].isoformat(),
            "verified": 0, "rework": 0} for b in buckets]
    for v in verified:
        i = bucket_index(buckets, v["verified_at"])
        if i is not None:
            out[i]["verified"] += 1
    for r in rework:
        if since is not None and r["at"] < since:
            continue
        i = bucket_index(buckets, r["at"])
        if i is not None:
            out[i]["rework"] += 1
    return out


# --------------------------------------------------------------------------- #
# Fact loading (SQL). One container, one range.
# --------------------------------------------------------------------------- #

def load_facts(cur, cid: str, since: Optional[_dt.datetime]) -> dict:
    """Every raw fact both scopes need, in a handful of queries."""
    # AI agents of the container (retired ones are kept here; the route decides visibility).
    cur.execute(
        "SELECT id, alias, model, role, terminated_at FROM agents "
        "WHERE container_id=%s AND kind='ai' ORDER BY alias",
        (cid,),
    )
    agents = {str(r["id"]): r for r in cur.fetchall()}

    # Current assignees (AI only) of every task in the container.
    cur.execute(
        "SELECT at.task_id, at.agent_id FROM agent_tasks at "
        "JOIN agents a ON a.id = at.agent_id AND a.kind = 'ai' "
        "JOIN tasks t ON t.id = at.task_id WHERE t.container_id=%s",
        (cid,),
    )
    assignees: dict[str, set[str]] = {}
    for r in cur.fetchall():
        assignees.setdefault(str(r["task_id"]), set()).add(str(r["agent_id"]))

    # Human verifications (approved) in range — one per task (latest), root excluded.
    cur.execute(
        """SELECT DISTINCT ON (e.entity_id)
                  e.entity_id AS task_id, e.created_at AS verified_at,
                  COALESCE(t.started_at, t.created_at) AS started_at
             FROM events e JOIN tasks t ON t.id = e.entity_id
            WHERE e.container_id=%s AND e.entity_type='task' AND e.event_type='verified'
              AND e.detail->>'approved' = 'true' AND NOT t.is_root
              AND (%s::timestamptz IS NULL OR e.created_at >= %s::timestamptz)
            ORDER BY e.entity_id, e.created_at DESC""",
        (cid, since, since),
    )
    verified = [
        {"task_id": str(r["task_id"]), "verified_at": r["verified_at"],
         "started_at": r["started_at"]}
        for r in cur.fetchall()
    ]

    # Rework events, ALL time (first-pass needs history before the window).
    cur.execute(
        """SELECT e.entity_id AS task_id, e.created_at AS at, e.event_type,
                  e.detail->'reassigned_to_agent_ids' AS reassigned
             FROM events e JOIN tasks t ON t.id = e.entity_id
            WHERE e.container_id=%s AND e.entity_type='task' AND NOT t.is_root
              AND ((e.event_type='verified' AND e.detail->>'approved' = 'false')
                OR (e.event_type='manager_review_recorded'
                    AND e.detail->>'decision' = 'send_back'))""",
        (cid,),
    )
    rework = []
    for r in cur.fetchall():
        tid = str(r["task_id"])
        who = {str(x) for x in (r["reassigned"] or []) if x} or set(assignees.get(tid, ()))
        rework.append({
            "task_id": tid, "at": r["at"],
            "kind": "rejection" if r["event_type"] == "verified" else "send_back",
            "agents": who,
        })

    # Plan decisions in range.
    cur.execute(
        """SELECT d.subject_id, d.decision, d.target_agent_id, d.created_at AS at
             FROM decisions d
            WHERE d.container_id=%s AND d.subject_type='plan_approval'
              AND (%s::timestamptz IS NULL OR d.created_at >= %s::timestamptz)""",
        (cid, since, since),
    )
    plans = []
    for r in cur.fetchall():
        target = str(r["target_agent_id"]) if r["target_agent_id"] else None
        who = {target} if target in agents else set(assignees.get(str(r["subject_id"]), ()))
        plans.append({"decision": r["decision"], "at": r["at"], "agents": who})

    # Escalations in range (attributed to the request's requester).
    cur.execute(
        """SELECT e.created_at AS at, r.requester_id
             FROM events e JOIN requests r ON r.id = e.entity_id
            WHERE e.container_id=%s AND e.entity_type='request' AND e.event_type='escalated'
              AND (%s::timestamptz IS NULL OR e.created_at >= %s::timestamptz)""",
        (cid, since, since),
    )
    escalations = [
        {"at": r["at"], "agents": {str(r["requester_id"])} if r["requester_id"] else set()}
        for r in cur.fetchall()
    ]

    # Finished runs on the verified tasks: per (task, agent) run / priced / cost.
    task_ids = [v["task_id"] for v in verified]
    run_costs: dict[tuple[str, str], dict] = {}
    if task_ids:
        cur.execute(
            """SELECT wr.task_id, wr.agent_id, count(*) AS runs,
                      count(*) FILTER (WHERE wr.total_cost_usd > 0) AS priced,
                      COALESCE(sum(wr.total_cost_usd) FILTER (WHERE wr.total_cost_usd > 0), 0)
                          AS cost
                 FROM worker_runs wr
                WHERE wr.task_id = ANY(%s::uuid[]) AND wr.ended_at IS NOT NULL
                GROUP BY wr.task_id, wr.agent_id""",
            (task_ids,),
        )
        for r in cur.fetchall():
            run_costs[(str(r["task_id"]), str(r["agent_id"]))] = {
                "runs": int(r["runs"]), "priced": int(r["priced"]), "cost": float(r["cost"]),
            }

    cur.execute(
        """SELECT min(e.created_at) AS first FROM events e
            WHERE e.container_id=%s AND e.entity_type='task'
              AND e.event_type IN ('verified', 'manager_review_recorded')""",
        (cid,),
    )
    row = cur.fetchone()
    first_activity = row["first"] if row else None

    return {
        "agents": agents,
        "assignees": assignees,
        "verified": verified,
        "rework": rework,
        "plans": plans,
        "escalations": escalations,
        "run_costs": run_costs,
        "first_activity": first_activity,
    }


def _costs_for(run_costs: dict, agent_id: Optional[str]) -> dict:
    """{task_id: {runs, priced, cost}} for one agent, or summed across agents (project)."""
    out: dict[str, dict] = {}
    for (tid, aid), c in run_costs.items():
        if agent_id is not None and aid != agent_id:
            continue
        acc = out.setdefault(tid, {"runs": 0, "priced": 0, "cost": 0.0})
        acc["runs"] += c["runs"]
        acc["priced"] += c["priced"]
        acc["cost"] += c["cost"]
    return out


def scope_metrics(facts: dict, agent_id: Optional[str], since, buckets) -> dict:
    """Metrics + series for one agent (agent_id) or the whole project (None)."""
    assignees = facts["assignees"]

    def mine(agents: set) -> bool:
        return agent_id is None or agent_id in agents

    verified = [v for v in facts["verified"]
                if agent_id is None or agent_id in assignees.get(v["task_id"], set())]
    rework = [r for r in facts["rework"] if mine(r["agents"])]
    plans = [p for p in facts["plans"] if mine(p["agents"])]
    escalations = [e for e in facts["escalations"]
                   if (e["agents"] & set(facts["agents"])) and mine(e["agents"])]
    metrics = compute_metrics(
        verified=verified, rework=rework, plan_decisions=plans, escalations=escalations,
        task_costs=_costs_for(facts["run_costs"], agent_id), since=since,
    )
    return {"metrics": metrics, "series": compute_series(buckets, verified, rework, since)}


def has_activity(m: dict) -> bool:
    return bool(
        m["tasks_verified"] or m["rework"]["total"] or m["escalations"]
        or m["plan_approval_rate"]["denominator"]
    )
