"""Per-agent spend drilldown + rule-based spend-reduction insights.

Companion reads to the #289 tokens-vs-quota meter (container_token_usage_routes):
where that route answers "what is the fleet burning right now", this module answers
"where did ONE agent's burn go" (broken down by task) and "what should a human DO
about it" (a small set of honest, threshold-gated rules — no LLM in the loop).

Accounting doctrine, unchanged from the meter (repeat here so a reader of just this
file gets it right): a wake's load against the plan QUOTA is
input + output + cache-CREATION + cache-READ tokens — cache reads are nearly free
in dollars yet still count against the quota, so `total_tokens` sums all four.
`total_cost_usd` is the dollar figure and is surfaced SEPARATELY; it is never folded
into total_tokens and never used as a proxy for quota burn.
"""

import statistics
from typing import Optional

from fastapi import HTTPException, Query, Request

from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container, valid_uuid
from portal_backend.identity_routes import require_member_read

# Same measured-usage predicate as the meter: only wakes that recorded at least one
# usage field are "measured" (pre-mig-019 / usage-less clean exits are absent, not zero).
MEASURED_USAGE = (
    "(wr.input_tokens IS NOT NULL OR wr.output_tokens IS NOT NULL "
    "OR wr.cache_read_input_tokens IS NOT NULL OR wr.cache_creation_input_tokens IS NOT NULL "
    "OR wr.total_cost_usd IS NOT NULL)"
)

WINDOW_INTERVALS = {"5h": "5 hours", "7d": "7 days"}

# Insight rules need enough runs that a ratio isn't just sampling noise.
MIN_RUNS_FOR_RULE = 5


def _window_clause(window: str) -> str:
    """SQL boolean literal (or a real predicate) gating rows into a window."""
    if window == "all":
        return "TRUE"
    return f"wr.ended_at >= now() - interval '{WINDOW_INTERVALS[window]}'"


def _totals_row(row) -> dict:
    it = int(row["it"])
    ot = int(row["ot"])
    crt = int(row["crt"])
    cct = int(row["cct"])
    return {
        "input_tokens": it,
        "output_tokens": ot,
        "cache_read_input_tokens": crt,
        "cache_creation_input_tokens": cct,
        "total_tokens": it + ot + crt + cct,
        "total_cost_usd": float(row["cost"]),
        "runs": int(row["runs"]),
    }


@app.get("/api/containers/{cid}/metrics/agents/{aid}/spend")
def agent_spend(
    cid: str,
    aid: str,
    request: Request,
    window: str = Query(default="all", pattern="^(5h|7d|all)$"),
):
    """One agent's measured spend, broken down by task, for the metrics drilldown.

    Same accounting doctrine as the #289 meter: `total_tokens` sums all four token
    kinds (input + output + cache-read + cache-creation) — that is the quota signal;
    `total_cost_usd` is the dollar figure, reported alongside but never folded in.
    Same NULL-as-0 + measured-usage-only semantics: a worker_run with every usage
    column NULL (pre-mig-019 or a usage-less clean exit) does not contribute and does
    not count toward `runs`. Windows: `5h` / `7d` mirror the meter's rolling
    quota windows; `all` is since the container was created (the default here, unlike
    the meter, since a drilldown is usually opened to understand the whole picture).

    `tasks` is sorted by total_tokens desc, one row per task the agent has runs
    against, PLUS a synthetic `task_id: null` row ("Conversation & drains") that
    rolls up every run not attributed to a task (conversation turns, event drains,
    orphan-reaped work) — so the sum of task rows always equals `totals`.

    Membership-gated exactly like the meter (require_member_read): reads are
    project-isolated, a trusted non-member gets 403, an unmapped container stays
    world-readable (fresh-stack bootstrap exemption)."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        require_member_read(cur, request, cid)
        cur.execute(
            "SELECT id, alias, model, reasoning_effort FROM agents "
            "WHERE id=%s AND container_id=%s",
            (aid, cid),
        )
        agent_row = cur.fetchone()
        if not agent_row:
            raise HTTPException(404, f"agent {aid} not found in container {cid}")

        win_clause = _window_clause(window)
        cur.execute(
            f"""SELECT
                    count(*) AS runs,
                    COALESCE(sum(COALESCE(wr.input_tokens,0)),0) AS it,
                    COALESCE(sum(COALESCE(wr.output_tokens,0)),0) AS ot,
                    COALESCE(sum(COALESCE(wr.cache_read_input_tokens,0)),0) AS crt,
                    COALESCE(sum(COALESCE(wr.cache_creation_input_tokens,0)),0) AS cct,
                    COALESCE(sum(COALESCE(wr.total_cost_usd,0)),0) AS cost
                FROM worker_runs wr
               WHERE wr.agent_id=%s AND wr.ended_at IS NOT NULL AND {MEASURED_USAGE}
                 AND {win_clause}""",
            (aid,),
        )
        totals = _totals_row(cur.fetchone())

        cur.execute(
            f"""SELECT wr.task_id, t.title, t.status,
                       count(*) AS runs,
                       COALESCE(sum(COALESCE(wr.input_tokens,0)),0) AS it,
                       COALESCE(sum(COALESCE(wr.output_tokens,0)),0) AS ot,
                       COALESCE(sum(COALESCE(wr.cache_read_input_tokens,0)),0) AS crt,
                       COALESCE(sum(COALESCE(wr.cache_creation_input_tokens,0)),0) AS cct,
                       COALESCE(sum(COALESCE(wr.total_cost_usd,0)),0) AS cost,
                       min(wr.started_at) AS first_run_at,
                       max(COALESCE(wr.ended_at, wr.started_at)) AS last_run_at
                  FROM worker_runs wr
                  LEFT JOIN tasks t ON t.id = wr.task_id
                 WHERE wr.agent_id=%s AND wr.ended_at IS NOT NULL AND {MEASURED_USAGE}
                   AND {win_clause}
                 GROUP BY wr.task_id, t.title, t.status
                 ORDER BY (COALESCE(sum(COALESCE(wr.input_tokens,0)),0)
                           + COALESCE(sum(COALESCE(wr.output_tokens,0)),0)
                           + COALESCE(sum(COALESCE(wr.cache_read_input_tokens,0)),0)
                           + COALESCE(sum(COALESCE(wr.cache_creation_input_tokens,0)),0)) DESC""",
            (aid,),
        )
        tasks = []
        for row in cur.fetchall():
            it, ot, crt, cct = int(row["it"]), int(row["ot"]), int(row["crt"]), int(row["cct"])
            tasks.append({
                "task_id": str(row["task_id"]) if row["task_id"] else None,
                "title": row["title"] if row["task_id"] else "Conversation & drains",
                "status": row["status"] if row["task_id"] else None,
                "runs": int(row["runs"]),
                "input_tokens": it,
                "output_tokens": ot,
                "cache_read_input_tokens": crt,
                "cache_creation_input_tokens": cct,
                "total_tokens": it + ot + crt + cct,
                "total_cost_usd": float(row["cost"]),
                "first_run_at": row["first_run_at"].isoformat() if row["first_run_at"] else None,
                "last_run_at": row["last_run_at"].isoformat() if row["last_run_at"] else None,
            })

    return {
        "agent": {
            "id": str(agent_row["id"]),
            "alias": agent_row["alias"],
            "model": agent_row["model"],
            "reasoning_effort": agent_row["reasoning_effort"],
        },
        "window": window,
        "totals": totals,
        "tasks": tasks,
    }


# --------------------------------------------------------------------------- #
# Insights: rule-based, no LLM. Each rule is a pure function of the same
# per-run rows every other metrics view already reads, with an honest
# data-floor (MIN_RUNS_FOR_RULE) so a quiet container never sees inflated
# ratios dressed up as a pattern.
# --------------------------------------------------------------------------- #

# Opus/Fable-class ids (model_policy.AVAILABLE_MODELS) — heaviest-cost model tier.
_HEAVY_MODEL_MARKERS = ("opus", "fable")


def _is_heavy_model(model: Optional[str]) -> bool:
    m = (model or "").lower()
    return any(marker in m for marker in _HEAVY_MODEL_MARKERS)


@app.get("/api/containers/{cid}/metrics/insights")
def metrics_insights(
    cid: str,
    request: Request,
    window: str = Query(default="7d", pattern="^(7d|all)$"),
):
    """Rule-based ("how to reduce spending") insights over the container's measured
    worker_runs — no LLM in the loop, every rule ties to a real, existing control
    (wake cadence / notifier settings, task scoping, model/effort choice, session
    cadence vs. cache TTL). Same accounting doctrine as the meter: quota-shaped
    ratios below (cache-read share, output-per-run) are computed from the four raw
    token kinds; `total_cost_usd` only enters the *concentration* rule, which is
    explicitly about dollars, not quota.

    Each rule skips itself (silently — no low-confidence insight is emitted) when
    the population it would judge has fewer than MIN_RUNS_FOR_RULE measured runs,
    so a fresh or quiet container never gets a confident-sounding verdict off noise.

    Returns `insights`, most-severe-first (high, then medium, then info)."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        require_member_read(cur, request, cid)
        win_clause = _window_clause(window)
        cur.execute(
            f"""SELECT wr.run_id, wr.agent_id, wr.task_id, a.alias, a.model,
                       COALESCE(wr.input_tokens,0) AS it,
                       COALESCE(wr.output_tokens,0) AS ot,
                       COALESCE(wr.cache_read_input_tokens,0) AS crt,
                       COALESCE(wr.cache_creation_input_tokens,0) AS cct,
                       COALESCE(wr.total_cost_usd,0) AS cost,
                       t.title AS task_title
                  FROM worker_runs wr
                  JOIN agents a ON a.id = wr.agent_id
                  LEFT JOIN tasks t ON t.id = wr.task_id
                 WHERE a.container_id=%s AND wr.ended_at IS NOT NULL AND {MEASURED_USAGE}
                   AND {win_clause}""",
            (cid,),
        )
        rows = cur.fetchall()

    insights = []
    insights.extend(_rule_cold_context(rows))
    insights.extend(_rule_wake_churn(rows))
    insights.extend(_rule_context_bloat(rows))
    insights.extend(_rule_heavy_model_small_talk(rows))
    insights.extend(_rule_concentration(rows))
    insights.extend(_rule_cache_write_churn(rows))
    insights.extend(_rule_subscription_loop(rows))

    order = {"high": 0, "medium": 1, "info": 2}
    insights.sort(key=lambda i: order.get(i["severity"], 3))
    return {"window": window, "insights": insights}


def _by_agent(rows):
    agents: dict = {}
    for r in rows:
        agents.setdefault(str(r["agent_id"]), {"alias": r["alias"], "model": r["model"], "rows": []})
        agents[str(r["agent_id"])]["rows"].append(r)
    return agents


def _rule_cold_context(rows):
    """Per agent: cache_read / (input + cache_read) < 0.3 → rewarming context every wake.

    A healthy resident-style agent should be reading MOST of its context back from
    cache once warm; a low ratio means each wake is paying full input-token price to
    rebuild context it already had — the notifier/wake-cadence knobs are the lever."""
    out = []
    for aid, info in _by_agent(rows).items():
        rs = info["rows"]
        if len(rs) < MIN_RUNS_FOR_RULE:
            continue
        total_in = sum(r["it"] for r in rs)
        total_crt = sum(r["crt"] for r in rs)
        denom = total_in + total_crt
        if denom <= 0:
            continue
        ratio = total_crt / denom
        if ratio < 0.3:
            out.append({
                "id": f"cold-context:{aid}",
                "severity": "high",
                "title": f"{info['alias'] or 'Agent'} rewarms context every wake",
                "detail": (
                    "Cache reads make up only "
                    f"{round(ratio * 100, 1)}% of this agent's input+cache-read tokens "
                    "across the window — most wakes are rebuilding context from scratch "
                    "instead of reading it back from cache."
                ),
                "evidence": {
                    "agent_alias": info["alias"],
                    "cache_read_input_tokens": total_crt,
                    "input_tokens": total_in,
                    "cache_hit_ratio": round(ratio, 4),
                    "runs": len(rs),
                },
                "action": (
                    "Batch this agent's work into fewer, longer sessions; check its wake "
                    "cadence / notifier settings for premature re-wakes."
                ),
            })
    return out


def _rule_wake_churn(rows):
    """Per agent: >40% of runs produce <500 output tokens → many tiny wakes."""
    out = []
    for aid, info in _by_agent(rows).items():
        rs = info["rows"]
        if len(rs) < MIN_RUNS_FOR_RULE:
            continue
        tiny = sum(1 for r in rs if r["ot"] < 500)
        frac = tiny / len(rs)
        if frac > 0.4:
            out.append({
                "id": f"wake-churn:{aid}",
                "severity": "medium",
                "title": f"{info['alias'] or 'Agent'} has many tiny wakes",
                "detail": (
                    f"{tiny} of {len(rs)} runs ({round(frac * 100, 1)}%) produced fewer than "
                    "500 output tokens — each wake still pays the fixed cost of a wake-up "
                    "(context load, tool setup) for very little output."
                ),
                "evidence": {
                    "agent_alias": info["alias"],
                    "tiny_runs": tiny,
                    "total_runs": len(rs),
                    "tiny_fraction": round(frac, 4),
                },
                "action": "Tune this agent's wake policy or require batched nudges instead of one-off pings.",
            })
    return out


def _rule_context_bloat(rows):
    """Per task: input > 8x output AND total > 100k → the task's scope is too wide."""
    out = []
    tasks: dict = {}
    for r in rows:
        if r["task_id"] is None:
            continue
        tid = str(r["task_id"])
        tasks.setdefault(tid, {"title": r["task_title"], "it": 0, "ot": 0, "crt": 0, "cct": 0, "runs": 0})
        tasks[tid]["it"] += r["it"]
        tasks[tid]["ot"] += r["ot"]
        tasks[tid]["crt"] += r["crt"]
        tasks[tid]["cct"] += r["cct"]
        tasks[tid]["runs"] += 1
    for tid, t in tasks.items():
        total = t["it"] + t["ot"] + t["crt"] + t["cct"]
        if t["runs"] < MIN_RUNS_FOR_RULE:
            continue
        if total <= 100_000:
            continue
        if t["ot"] <= 0 or t["it"] <= 8 * t["ot"]:
            continue
        out.append({
            "id": f"context-bloat:{tid}",
            "severity": "medium",
            "title": f"Task “{t['title'] or tid}” is burning context for little output",
            "detail": (
                f"Input tokens ({t['it']:,}) are over 8x output tokens ({t['ot']:,}) and the "
                f"task's total is {total:,} tokens — the task's scope or protocol notes are "
                "likely too wide for what it actually produces."
            ),
            "evidence": {
                "task_id": tid, "task_title": t["title"],
                "input_tokens": t["it"], "output_tokens": t["ot"], "total_tokens": total,
                "runs": t["runs"],
            },
            "action": "Narrow the task's scope, trim protocol/context notes, or split it into smaller tasks.",
        })
    return out


def _rule_heavy_model_small_talk(rows):
    """Per agent on an Opus/Fable-class model: median output/run < 800 tokens."""
    out = []
    for aid, info in _by_agent(rows).items():
        rs = info["rows"]
        if len(rs) < MIN_RUNS_FOR_RULE:
            continue
        if not _is_heavy_model(info["model"]):
            continue
        median_out = statistics.median(r["ot"] for r in rs)
        if median_out < 800:
            out.append({
                "id": f"heavy-model-small-talk:{aid}",
                "severity": "medium",
                "title": f"{info['alias'] or 'Agent'} uses a heavy model for small replies",
                "detail": (
                    f"Median output per run is {int(median_out)} tokens on {info['model']} "
                    "— a premium-tier model priced for substantial work, spent mostly on "
                    "short turns."
                ),
                "evidence": {
                    "agent_alias": info["alias"], "model": info["model"],
                    "median_output_tokens": int(median_out), "runs": len(rs),
                },
                "action": "Consider a smaller model or a lower reasoning effort for this agent (Settings → agent controls).",
            })
    return out


def _rule_concentration(rows):
    """A single task is >40% of the window's total dollar spend — surface it plainly."""
    out = []
    total_cost = sum(float(r["cost"]) for r in rows)
    if total_cost <= 0:
        return out
    tasks: dict = {}
    for r in rows:
        tid = str(r["task_id"]) if r["task_id"] else None
        key = tid or "__none__"
        tasks.setdefault(key, {"title": r["task_title"] if tid else "Conversation & drains", "cost": 0.0, "runs": 0, "task_id": tid})
        tasks[key]["cost"] += float(r["cost"])
        tasks[key]["runs"] += 1
    for key, t in tasks.items():
        frac = t["cost"] / total_cost
        if frac > 0.4:
            out.append({
                "id": f"concentration:{key}",
                "severity": "info",
                "title": f"“{t['title'] or 'Untitled task'}” is {round(frac * 100, 1)}% of this window's spend",
                "detail": (
                    f"${t['cost']:.2f} of ${total_cost:.2f} total window spend "
                    f"({round(frac * 100, 1)}%) came from a single task across {t['runs']} runs."
                ),
                "evidence": {
                    "task_id": t["task_id"], "task_title": t["title"],
                    "task_cost_usd": round(t["cost"], 6), "window_cost_usd": round(total_cost, 6),
                    "fraction": round(frac, 4),
                },
                "action": "Not necessarily a problem — just worth knowing where the window's dollars actually went.",
            })
    return out


def _rule_cache_write_churn(rows):
    """Window-wide: cache_read / cache_creation < 1 → paying to warm caches that never get reused."""
    total_crt = sum(r["crt"] for r in rows)
    total_cct = sum(r["cct"] for r in rows)
    if len(rows) < MIN_RUNS_FOR_RULE or total_cct <= 0:
        return []
    ratio = total_crt / total_cct
    if ratio >= 1:
        return []
    return [{
        "id": "cache-write-churn:window",
        "severity": "high",
        "title": "Paying to warm caches that never get reused",
        "detail": (
            f"Across the window, cache-creation tokens ({total_cct:,}) outweigh cache-read "
            f"tokens ({total_crt:,}) — a read/creation ratio of {round(ratio, 2)}. Each warmed "
            "cache is mostly being paid for and then abandoned before it gets read back."
        ),
        "evidence": {
            "cache_read_input_tokens": total_crt,
            "cache_creation_input_tokens": total_cct,
            "read_to_creation_ratio": round(ratio, 4),
            "runs": len(rows),
        },
        "action": "Tighten session cadence so wakes land within the cache TTL instead of letting it expire between wakes.",
    }]


# Wake circuit-breaker incident (see wake_backoff.py): a subscription-billed daemon
# (Claude Code / claude -p on the user's own login, not an API key) can wake hundreds of times
# for a trigger nobody is consuming while total_cost_usd stays near-zero, because subscription
# billing never surfaces in worker_runs.total_cost_usd — the token/run counters are the ONLY
# signal such a loop leaves behind. High run count + near-zero recorded cost is exactly that
# shape; this rule flags it independent of MIN_RUNS_FOR_RULE's 5-run floor (that floor exists to
# avoid noisy ratios on a quiet container — a >200-run population is never noise).
_SUBSCRIPTION_LOOP_MIN_RUNS = 200
_SUBSCRIPTION_LOOP_MAX_COST_USD = 1.0


def _rule_subscription_loop(rows):
    """Per agent: window run count > 200 AND recorded total_cost_usd < $1 -> likely
    subscription-billed wakes invisible to the dollar meter (see the wake circuit breaker)."""
    out = []
    for aid, info in _by_agent(rows).items():
        rs = info["rows"]
        if len(rs) <= _SUBSCRIPTION_LOOP_MIN_RUNS:
            continue
        total_cost = sum(float(r["cost"]) for r in rs)
        if total_cost >= _SUBSCRIPTION_LOOP_MAX_COST_USD:
            continue
        out.append({
            "id": f"subscription-loop:{aid}",
            "severity": "high",
            "title": f"{info['alias'] or 'Agent'} has {len(rs)} runs with almost no recorded cost",
            "detail": (
                f"{len(rs)} runs with almost no recorded cost — subscription-billed wakes, "
                "invisible to the dollar meter."
            ),
            "evidence": {
                "agent_alias": info["alias"],
                "runs": len(rs),
                "total_cost_usd": round(total_cost, 6),
            },
            "action": "Check this agent's wake backoff (GET .../wake-backoff) or triage its wake triggers — a trigger it can't act on may be looping.",
        })
    return out
