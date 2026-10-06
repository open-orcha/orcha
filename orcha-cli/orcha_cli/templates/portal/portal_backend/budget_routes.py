"""Per-agent monthly budgets with hard stops, plus an optional project-wide cap.

Idea credit: Paperclip (github.com/paperclipai/paperclip, MIT) — "agents have monthly
budgets; when they hit the limit they stop". No Paperclip code is copied here; the
accounting below is Orcha's own, built on the worker_runs usage columns (mig 019).

Accounting doctrine (repeated at every read site, same as agent_spend_routes and the
Metrics page — keep them in lockstep):
  * Dollars = worker_runs.total_cost_usd, the figure the worker reported. For a run whose
    four usage columns are ALL NULL the captured stream-json tail is parsed as a fallback,
    exactly like container_metrics_routes._run_measures.
  * A finished run that reported NO dollar figure (subscription billing, Codex, unpriced
    model) is NOT METERED. It is never counted as $0 of spend — it is counted apart
    (`unmetered_runs` / `unmetered_tokens`) so the UI can say "not metered". The owner may
    additionally set a TOKEN cap, which counts every run's tokens, metered or not.
  * Tokens = input + output + cache-read + cache-creation (the #289 quota doctrine).
  * Budget month = the UTC calendar month; a run belongs to the month it STARTED in.
    Rollover resets by construction (usage recomputed per month; the override / notice
    markers are period-scoped 'YYYY-MM' strings that simply stop matching).

Enforcement (the ONE hard-stop point): `apply_budget_gate`, called by the wake-scan
(wake_scan_routes) BEFORE the notifier decides to spawn anything. A paused agent's
candidate keeps flowing to the daemon but with should_wake=False, `budget_paused=True`
and a plain `budget_reason` — so the daemon never starts a NEW run for it. An in-flight
run (or a live resident/terminal session) is NEVER killed; it finishes on its own and its
cost still lands in this month's total.

Authority: only a human may change a budget — owner or the `manage_autonomy` grant (the
same grant that governs wakes, since a budget is a wake throttle). Viewers read only. Every
change and every override is audited in `events`.
"""

from __future__ import annotations

from datetime import timezone
from decimal import Decimal
from typing import Literal, Optional

from fastapi import HTTPException, Request
from pydantic import BaseModel, Field

from portal_backend import sql
from portal_backend.agent_status import log_event
from portal_backend.application import app
from portal_backend.container_metrics_routes import OUTPUT_TAIL_BYTES, parse_output_tail
from portal_backend.database import db_cursor
from portal_backend.events import publish_event
from portal_backend.guards import find_actionable_human, require_container, require_kind, valid_uuid
from portal_backend.identity_routes import enforce_grant, require_member_read, trusted_actor

WARN_RATIO = 0.8
MAX_USD = 1_000_000
MAX_TOKENS = 10_000_000_000_000
MAX_NOTE_LEN = 500

_BUDGET_COLS = (
    "monthly_limit_usd, monthly_limit_tokens, override_period, override_by, override_at, "
    "override_note, warned_period, paused_period, updated_by, updated_at"
)


# --------------------------------------------------------------------------- #
# Period + usage
# --------------------------------------------------------------------------- #

def current_period(cur) -> dict:
    """The budget month (UTC calendar month) as {'period','starts_at','resets_at'}.
    Computed in Python (GH #258: no date_trunc / AT TIME ZONE / interval on SQLite); `cur`
    stays in the signature for the callers."""
    starts_at = sql.utcnow().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    if starts_at.month == 12:
        resets_at = starts_at.replace(year=starts_at.year + 1, month=1)
    else:
        resets_at = starts_at.replace(month=starts_at.month + 1)
    return {"period": starts_at.strftime("%Y-%m"), "starts_at": starts_at, "resets_at": resets_at}


def _empty_usage() -> dict:
    return {
        "spend_usd": 0.0,
        "metered_runs": 0,
        "unmetered_runs": 0,
        "unmetered_tokens": 0,
        "tokens": 0,
        # M13: the cache-read + cache-creation share of `tokens` (Metrics' Tokens column
        # excludes cache) so the UI can label budget token figures "incl. cache".
        "cache_tokens": 0,
        "runs": 0,
        "in_flight_runs": 0,
    }


def month_usage(cur, container_id: str, starts_at) -> dict:
    """{agent_id: usage} for every agent in the container with a run this month.

    `runs` = finished runs; `in_flight_runs` = still running (their cost is not known
    yet and they are never stopped by a budget). Finished runs split into metered (a
    dollar figure was reported) and unmetered (none was — never treated as $0)."""
    cur.execute(
        """SELECT wr.agent_id,
                  count(*) FILTER (WHERE wr.ended_at IS NULL) AS in_flight,
                  count(*) FILTER (WHERE wr.ended_at IS NOT NULL) AS runs,
                  count(*) FILTER (WHERE wr.ended_at IS NOT NULL
                                     AND wr.total_cost_usd IS NOT NULL) AS metered_runs,
                  COALESCE(sum(wr.total_cost_usd) FILTER (WHERE wr.ended_at IS NOT NULL), 0)
                      AS spend,
                  COALESCE(sum(COALESCE(wr.input_tokens, 0) + COALESCE(wr.output_tokens, 0)
                               + COALESCE(wr.cache_read_input_tokens, 0)
                               + COALESCE(wr.cache_creation_input_tokens, 0))
                           FILTER (WHERE wr.ended_at IS NOT NULL), 0) AS tokens,
                  COALESCE(sum(COALESCE(wr.cache_read_input_tokens, 0)
                               + COALESCE(wr.cache_creation_input_tokens, 0))
                           FILTER (WHERE wr.ended_at IS NOT NULL), 0) AS cache_tokens,
                  COALESCE(sum(COALESCE(wr.input_tokens, 0) + COALESCE(wr.output_tokens, 0)
                               + COALESCE(wr.cache_read_input_tokens, 0)
                               + COALESCE(wr.cache_creation_input_tokens, 0))
                           FILTER (WHERE wr.ended_at IS NOT NULL
                                     AND wr.total_cost_usd IS NULL), 0) AS unmetered_tokens
             FROM worker_runs wr JOIN agents a ON a.id = wr.agent_id
            WHERE a.container_id = %s AND wr.started_at >= %s
            GROUP BY wr.agent_id""",
        (container_id, starts_at),
    )
    usage: dict = {}
    for row in cur.fetchall():
        u = _empty_usage()
        runs = int(row["runs"])
        metered = int(row["metered_runs"])
        u.update(
            spend_usd=float(row["spend"]),
            metered_runs=metered,
            unmetered_runs=runs - metered,
            unmetered_tokens=int(row["unmetered_tokens"]),
            tokens=int(row["tokens"]),
            cache_tokens=int(row["cache_tokens"]),
            runs=runs,
            in_flight_runs=int(row["in_flight"]),
        )
        usage[str(row["agent_id"])] = u

    # Fallback (same as the Metrics aggregate): a finished run with EVERY usage column
    # NULL may still carry its terminal result record in the captured output. Parse only
    # those rows' 4KB tails; a run that reports a cost there moves from unmetered to
    # metered. Nothing found → it stays "not metered", never $0.
    tail_expr = sql.right("wr.output", OUTPUT_TAIL_BYTES)
    cur.execute(
        f"""SELECT wr.agent_id, {tail_expr} AS output_tail
             FROM worker_runs wr JOIN agents a ON a.id = wr.agent_id
            WHERE a.container_id = %s AND wr.started_at >= %s AND wr.ended_at IS NOT NULL
              AND wr.output IS NOT NULL
              AND wr.input_tokens IS NULL AND wr.output_tokens IS NULL
              AND wr.cache_read_input_tokens IS NULL AND wr.cache_creation_input_tokens IS NULL
              AND wr.total_cost_usd IS NULL""",
        (container_id, starts_at),
    )
    for row in cur.fetchall():
        parsed = parse_output_tail(row["output_tail"])
        if not parsed:
            continue
        u = usage.setdefault(str(row["agent_id"]), _empty_usage())
        toks = (parsed["tokens_in"] or 0) + (parsed["tokens_out"] or 0)
        u["tokens"] += toks
        if parsed["cost"] is not None:
            u["spend_usd"] += parsed["cost"]
            u["metered_runs"] += 1
            u["unmetered_runs"] -= 1
        else:
            u["unmetered_tokens"] += toks
    return usage


def _sum_usage(parts) -> dict:
    total = _empty_usage()
    for u in parts:
        for k in total:
            total[k] += u[k]
    return total


# --------------------------------------------------------------------------- #
# Evaluation (pure)
# --------------------------------------------------------------------------- #

def _ratio(used: float, limit) -> Optional[float]:
    if limit is None:
        return None
    limit = float(limit)
    if limit <= 0:
        # A zero budget allows nothing: reached immediately.
        return 1.0 if used <= 0 else float("inf")
    return used / limit


def evaluate(limit_usd, limit_tokens, usage: dict, override_active: bool) -> dict:
    """Pure threshold verdict for one budget scope.

    state: 'none' (no limit set) | 'ok' | 'warning' (>= 80% of any limit) |
    'exceeded' (>= 100% of any limit). `paused` = exceeded and no active override."""
    usd_ratio = _ratio(usage["spend_usd"], limit_usd)
    token_ratio = _ratio(usage["tokens"], limit_tokens)
    ratios = [r for r in (usd_ratio, token_ratio) if r is not None]
    if not ratios:
        state = "none"
    else:
        worst = max(ratios)
        state = "exceeded" if worst >= 1.0 else "warning" if worst >= WARN_RATIO else "ok"
    hit = []
    if usd_ratio is not None and usd_ratio >= 1.0:
        hit.append("usd")
    if token_ratio is not None and token_ratio >= 1.0:
        hit.append("tokens")
    return {
        "state": state,
        "usd_ratio": None if usd_ratio is None else _finite(usd_ratio),
        "token_ratio": None if token_ratio is None else _finite(token_ratio),
        "limits_reached": hit,
        "paused": state == "exceeded" and not override_active,
    }


def _finite(x: float) -> float:
    return round(x, 4) if x != float("inf") else 999.0


def _num(v):
    if v is None:
        return None
    return float(v) if isinstance(v, (Decimal, float, int)) else None


def fmt_usd(v: float) -> str:
    return f"${v:,.2f}"


def _compact(x: float) -> str:
    return f"{x:.1f}".rstrip("0").rstrip(".")


def fmt_tokens(v: int) -> str:
    if v >= 1_000_000:
        return f"{_compact(v / 1_000_000)}M tokens"
    if v >= 1_000:
        return f"{_compact(v / 1_000)}k tokens"
    return f"{v} tokens"


def _limit_text(scope: dict) -> str:
    """'$41.10 of $50.00' / '1.2M tokens of 1M tokens' — the limit(s) reached, else the
    one closest to its limit."""
    usd = f"{fmt_usd(scope['usage']['spend_usd'])} of {fmt_usd(scope['limits']['usd'])}" \
        if scope["limits"]["usd"] is not None else None
    tok = f"{fmt_tokens(scope['usage']['tokens'])} of {fmt_tokens(scope['limits']['tokens'])}" \
        if scope["limits"]["tokens"] is not None else None
    reached = scope.get("limits_reached") or []
    if reached:
        return " · ".join(t for k, t in (("usd", usd), ("tokens", tok)) if k in reached and t)
    ur, tr = scope.get("usd_ratio"), scope.get("token_ratio")
    if usd and (tr is None or (ur or 0) >= tr):
        return usd
    return tok or usd or ""


def _scope_payload(row, usage: dict, period: dict) -> dict:
    """One budget scope (an agent or the project) → the public status shape."""
    lim_usd = _num(row["monthly_limit_usd"]) if row else None
    lim_tok = int(row["monthly_limit_tokens"]) if row and row["monthly_limit_tokens"] is not None else None
    override_active = bool(row and row["override_period"] == period["period"])
    verdict = evaluate(lim_usd, lim_tok, usage, override_active)
    return {
        "limits": {"usd": lim_usd, "tokens": lim_tok},
        "usage": {**usage, "spend_usd": round(usage["spend_usd"], 6)},
        **verdict,
        "override": {
            "active": override_active,
            "granted_by": str(row["override_by"]) if override_active and row["override_by"] else None,
            "granted_at": row["override_at"].isoformat() if override_active and row["override_at"] else None,
            "note": row["override_note"] if override_active else None,
        },
        "updated_at": row["updated_at"].isoformat() if row and row["updated_at"] else None,
    }


def resets_label(period: dict) -> str:
    d = period.get("resets_at")
    if not d:
        return "next month"
    d = d.astimezone(timezone.utc)
    return f"{d:%b} {d.day}"


def budget_statuses(cur, container_id: str) -> dict:
    """Every AI agent's budget status + the project cap, for the current month.

    Returns {'period', 'starts_at', 'resets_at', 'project', 'agents': {aid: status}}.
    An agent is paused when ITS budget is exceeded without an override, OR when the
    project cap is exceeded without a project override (`blocked_by` says which)."""
    period = current_period(cur)
    usage = month_usage(cur, container_id, period["starts_at"])
    cur.execute(
        f"""SELECT a.id, a.alias, {', '.join('b.' + c.strip() for c in _BUDGET_COLS.split(','))},
                   (b.agent_id IS NOT NULL) AS has_budget
              FROM agents a LEFT JOIN agent_budgets b ON b.agent_id = a.id
             WHERE a.container_id = %s AND a.kind = 'ai' AND a.terminated_at IS NULL
             ORDER BY a.alias""",
        (container_id,),
    )
    agent_rows = cur.fetchall()
    cur.execute(
        f"SELECT {_BUDGET_COLS} FROM container_budgets WHERE container_id=%s",
        (container_id,),
    )
    project_row = cur.fetchone()
    project = _scope_payload(project_row, _sum_usage(usage.values()), period)
    project["reason"] = (
        f"Project monthly budget reached ({_limit_text(project)}) — every agent is paused "
        f"for new runs until {resets_label(period)}. Runs in progress were not stopped."
        if project["paused"] else None
    )
    agents = {}
    for row in agent_rows:
        aid = str(row["id"])
        st = _scope_payload(row if row["has_budget"] else None, usage.get(aid, _empty_usage()), period)
        st["agent_id"] = aid
        st["alias"] = row["alias"]
        own_paused = st["paused"]
        st["paused"] = own_paused or project["paused"]
        st["blocked_by"] = "agent" if own_paused else ("project" if project["paused"] else None)
        if own_paused:
            st["reason"] = (
                f"Monthly budget reached ({_limit_text(st)}) — paused for new runs until "
                f"{resets_label(period)}. Runs in progress were not stopped."
            )
        elif project["paused"]:
            st["reason"] = project["reason"]
        else:
            st["reason"] = None
        agents[aid] = st
    return {
        "period": period["period"],
        "starts_at": period["starts_at"].astimezone(timezone.utc).isoformat(),
        "resets_at": period["resets_at"].astimezone(timezone.utc).isoformat(),
        "project": project,
        "agents": agents,
        "_period": period,
        "_project_row": project_row,
        "_agent_rows": {str(r["id"]): r for r in agent_rows if r["has_budget"]},
    }


def _public(statuses: dict) -> dict:
    return {k: v for k, v in statuses.items() if not k.startswith("_")}


# --------------------------------------------------------------------------- #
# Notices (80% warning / 100% pause) — once per scope per month
# --------------------------------------------------------------------------- #

def _notice(cur, container_id: str, requester_id: str, payload: str, reason: str, detail: dict):
    """Put a Needs-you item in front of the human: an open `info` request from the agent
    to the actionable human — the SAME plumbing wake_backoff's breaker uses, so it renders
    in the existing Needs-you surface with zero frontend changes."""
    human_id = find_actionable_human(cur, container_id)
    if human_id is None:
        return None
    cur.execute(
        """INSERT INTO requests
                (container_id, type, requester_id, target_id, priority, status,
                 payload, expires_at, chain_depth)
           VALUES (%s, 'info', %s, %s, 100, 'open', %s, %s, 0)
           RETURNING id""",
        (container_id, requester_id, human_id, payload, sql.from_now(7 * 86400)),
    )
    rid = str(cur.fetchone()["id"])
    log_event(
        cur, container_id, "system", None, "request", rid, "created",
        {"type": "info", "target_alias": None, "priority": 100, "preview": payload[:120],
         "reason": reason, **detail},
    )
    publish_event(cur, container_id, human_id, "request_created",
                  {"request_id": rid, "type": "info", "from_agent_id": requester_id,
                   "preview": payload[:120]})
    publish_event(cur, container_id, None, "request_escalated",
                  {"request_id": rid, "reason": reason})
    return rid


def resolve_stale_notices(cur, container_id: str, *, period: str, reasons,
                          agent_id: Optional[str] = None, actor: Optional[str] = None,
                          why: str = "budget_resolved") -> list:
    """Close this scope's OPEN budget notices for `period` whose `reason` is in `reasons`.

    B26: a pause notice must leave Needs-you once the pause is lifted (override granted,
    budget raised / cleared), and a re-armed month must never stack a second copy. The
    scope is one agent (`agent_id`) or, with agent_id=None, the project cap. Notices are
    matched through their `created` audit event (reason + scope + period live there).
    Returns the closed request ids."""
    scope_sql = ("e.detail->>'agent_id' = %s" if agent_id is not None
                 else "e.detail->>'scope' = 'project'")
    params = [container_id, sql.list_param(reasons), period]
    if agent_id is not None:
        params.append(str(agent_id))
    cur.execute(
        f"""SELECT r.id, r.requester_id, r.target_id
              FROM requests r
              JOIN events e ON e.entity_type = 'request' AND e.event_type = 'created'
                           AND CAST(e.entity_id AS TEXT) = CAST(r.id AS TEXT)
             WHERE r.container_id = %s AND r.status IN ('open', 'escalated')
               AND {sql.in_list("e.detail->>'reason'")}
               AND e.detail->>'period' = %s
               AND {scope_sql}
             """ + sql.for_update(of="r"),
        params,
    )
    rows = cur.fetchall()
    closed = []
    for r in rows:
        rid = str(r["id"])
        cur.execute("UPDATE requests SET status='closed', closed_at=now() WHERE id=%s", (rid,))
        log_event(cur, container_id, "human" if actor else "system", actor, "request", rid,
                  "closed", {"reason": why, "period": period})
        if r["target_id"]:
            publish_event(cur, container_id, str(r["target_id"]), "request_closed",
                          {"request_id": rid, "reason": why})
        closed.append(rid)
    return closed


def _resolve_after_update(cur, container_id: str, statuses: dict, actor: str,
                          agent_id: Optional[str] = None) -> None:
    """After an owner edit: close the notices the scope's NEW state no longer warrants.
    Not paused (override granted or limit raised) → the pause notice goes; back under
    the warning line (ok / no limit) → the warning notice goes too."""
    pk = statuses["period"]
    if agent_id is not None:
        st = statuses["agents"].get(str(agent_id))
        if st is None:
            return
        own_paused = st["blocked_by"] == "agent"
        state = st["state"]
    else:
        st = statuses["project"]
        own_paused = st["paused"]
        state = st["state"]
    reasons = []
    if not own_paused:
        reasons.append("budget_paused")
    if state in ("none", "ok"):
        reasons.append("budget_warning")
    if reasons:
        resolve_stale_notices(cur, container_id, period=pk, reasons=reasons,
                              agent_id=agent_id, actor=actor)


def _pct(st: dict) -> int:
    ratios = [r for r in (st["usd_ratio"], st["token_ratio"]) if r is not None]
    return int(round(max(ratios) * 100)) if ratios else 0


def fire_threshold_notices(cur, container_id: str, statuses: dict) -> None:
    """Emit the 80% warning and the 100% pause notice at most once per scope per month."""
    period = statuses["_period"]
    pk = period["period"]
    for aid, row in statuses["_agent_rows"].items():
        st = statuses["agents"][aid]
        alias = st["alias"] or "The agent"
        if st["state"] == "exceeded" and row["paused_period"] != pk:
            if st["override"]["active"]:
                text = (f"{alias} passed its monthly budget ({_limit_text(st)}). A one-time "
                        "override is active, so it keeps running this month.")
            else:
                text = (f"{alias} reached its monthly budget ({_limit_text(st)}) and is paused "
                        f"for new runs until {resets_label(period)}. Runs already in progress "
                        f"were not stopped. Raise the budget or grant a one-time override in "
                        f"{alias} → Configuration → Budget.")
            log_event(cur, container_id, "system", None, "agent", aid, "budget_paused",
                      {"period": pk, "limits": st["limits"], "spend_usd": st["usage"]["spend_usd"],
                       "tokens": st["usage"]["tokens"], "override_active": st["override"]["active"]})
            resolve_stale_notices(cur, container_id, period=pk, reasons=["budget_paused"],
                                  agent_id=aid, why="superseded")
            _notice(cur, container_id, aid, text, "budget_paused", {"agent_id": aid, "period": pk})
            cur.execute("UPDATE agent_budgets SET paused_period=%s, warned_period=%s WHERE agent_id=%s",
                        (pk, pk, aid))
        elif st["state"] == "warning" and row["warned_period"] != pk:
            text = (f"{alias} has used {_pct(st)}% of its monthly budget ({_limit_text(st)}). "
                    "At 100% it will be paused for new runs.")
            log_event(cur, container_id, "system", None, "agent", aid, "budget_warning",
                      {"period": pk, "limits": st["limits"], "spend_usd": st["usage"]["spend_usd"],
                       "tokens": st["usage"]["tokens"], "percent": _pct(st)})
            resolve_stale_notices(cur, container_id, period=pk, reasons=["budget_warning"],
                                  agent_id=aid, why="superseded")
            _notice(cur, container_id, aid, text, "budget_warning", {"agent_id": aid, "period": pk})
            cur.execute("UPDATE agent_budgets SET warned_period=%s WHERE agent_id=%s", (pk, aid))

    prow = statuses["_project_row"]
    proj = statuses["project"]
    if prow is None or proj["state"] in ("none", "ok"):
        return
    # a project-level request needs a requester agent: the busiest AI agent this month
    ranked = sorted(statuses["agents"].values(), key=lambda s: -s["usage"]["runs"])
    requester = ranked[0]["agent_id"] if ranked else None
    if proj["state"] == "exceeded" and prow["paused_period"] != pk:
        text = (f"This project reached its monthly budget ({_limit_text(proj)}). Every agent is "
                f"paused for new runs until {resets_label(period)}; runs in progress were not "
                "stopped. Raise the project budget or grant a one-time override in Metrics.")
        log_event(cur, container_id, "system", None, "container", container_id, "budget_paused",
                  {"period": pk, "scope": "project", "limits": proj["limits"],
                   "spend_usd": proj["usage"]["spend_usd"], "tokens": proj["usage"]["tokens"],
                   "override_active": proj["override"]["active"]})
        if requester and not proj["override"]["active"]:
            resolve_stale_notices(cur, container_id, period=pk, reasons=["budget_paused"],
                                  why="superseded")
            _notice(cur, container_id, requester, text, "budget_paused", {"scope": "project", "period": pk})
        cur.execute("UPDATE container_budgets SET paused_period=%s, warned_period=%s WHERE container_id=%s",
                    (pk, pk, container_id))
    elif proj["state"] == "warning" and prow["warned_period"] != pk:
        text = (f"This project has used {_pct(proj)}% of its monthly budget ({_limit_text(proj)}). "
                "At 100% every agent will be paused for new runs.")
        log_event(cur, container_id, "system", None, "container", container_id, "budget_warning",
                  {"period": pk, "scope": "project", "limits": proj["limits"],
                   "spend_usd": proj["usage"]["spend_usd"], "percent": _pct(proj)})
        if requester:
            resolve_stale_notices(cur, container_id, period=pk, reasons=["budget_warning"],
                                  why="superseded")
            _notice(cur, container_id, requester, text, "budget_warning", {"scope": "project", "period": pk})
        cur.execute("UPDATE container_budgets SET warned_period=%s WHERE container_id=%s",
                    (pk, container_id))


# --------------------------------------------------------------------------- #
# The hard stop — called by the wake-scan before the notifier spawns anything
# --------------------------------------------------------------------------- #

def _any_budget(cur, container_id: str) -> bool:
    # Tolerate a database the budgets migration has not reached yet (the scan must never
    # break because of an optional feature): no table → no budgets → nothing to enforce.
    cur.execute(f"SELECT {sql.table_exists('agent_budgets')} AS ready")
    if not cur.fetchone()["ready"]:
        return False
    cur.execute(
        """SELECT EXISTS (SELECT 1 FROM agent_budgets WHERE container_id=%s)
               OR EXISTS (SELECT 1 FROM container_budgets WHERE container_id=%s) AS any""",
        (container_id, container_id),
    )
    return bool(cur.fetchone()["any"])


def apply_budget_gate(cur, container_id: str, candidates: list) -> list:
    """Withhold NEW runs from agents whose monthly budget (or the project cap) is reached.

    Runs on the wake-scan's own cursor/transaction (the caller commits). Fast path: a
    container with no budget rows pays one EXISTS query. Otherwise every candidate is
    annotated with `budget_paused` / `budget_reason`; a paused candidate that WOULD have
    woken gets should_wake=False (and `budget_held_wake=True`) — the daemon never spawns
    it. Never touches a running run, a lease, a task or an event."""
    if not _any_budget(cur, container_id):
        return candidates
    statuses = budget_statuses(cur, container_id)
    for candidate in candidates:
        st = statuses["agents"].get(candidate.get("agent_id"))
        paused = bool(st and st["paused"])
        candidate["budget_paused"] = paused
        candidate["budget_reason"] = st["reason"] if paused else None
        candidate["budget_held_wake"] = False
        if paused and candidate.get("should_wake"):
            candidate["should_wake"] = False
            candidate["budget_held_wake"] = True
            candidate["triage_hint"] = None
            candidate["reason"] = "budget: " + (st["reason"] or "monthly budget reached")
    fire_threshold_notices(cur, container_id, statuses)
    return candidates


def agent_budget_block(cur, container_id: str, aid: str) -> Optional[str]:
    """The hard-stop reason when `aid` may NOT start a new run (its own budget or the
    project cap is reached with no active override), else None.

    Shared by every entry point that can start new work — wake-scan (via
    apply_budget_gate), wake-claim and the /next task claim — so a caller that skips the
    scan cannot bypass the stop (KG-1 / B07 / PS-17). Fast path: one EXISTS query when
    the project has no budgets. Never touches in-flight runs."""
    if not _any_budget(cur, container_id):
        return None
    st = budget_statuses(cur, container_id)["agents"].get(str(aid))
    if st and st["paused"]:
        return st["reason"] or "monthly budget reached"
    return None


# --------------------------------------------------------------------------- #
# API
# --------------------------------------------------------------------------- #

class BudgetUpdate(BaseModel):
    """Partial update: a field left OUT is unchanged; an explicit null clears a limit."""

    actor_agent_id: Optional[str] = None
    monthly_limit_usd: Optional[float] = Field(default=None, ge=0, le=MAX_USD)
    monthly_limit_tokens: Optional[int] = Field(default=None, ge=0, le=MAX_TOKENS)
    override: Optional[Literal["grant", "revoke"]] = Field(
        default=None,
        description="'grant' lifts the hard stop for the rest of the current month only; "
        "'revoke' removes an active override.",
    )
    note: Optional[str] = Field(default=None, max_length=MAX_NOTE_LEN)


def _authorize_write(cur, request: Request, container_id: str, claimed_actor) -> str:
    """Owner-or-manage_autonomy, human only, never a viewer. Returns the acting human id."""
    enforce_grant(cur, request, container_id, "manage_autonomy")
    actor = trusted_actor(cur, request, container_id, claimed_actor)
    require_kind(cur, actor, ("human",))
    cur.execute(
        "SELECT member_role, container_id FROM agents WHERE id=%s AND terminated_at IS NULL",
        (actor,),
    )
    row = cur.fetchone()
    if not row or str(row["container_id"]) != str(container_id):
        raise HTTPException(403, "actor is not a live member of this project")
    if row["member_role"] == "viewer":
        raise HTTPException(403, "your role on this project is viewer — it is read-only")
    return str(actor)


def _apply_update(cur, table: str, key_col: str, key: str, container_id: str,
                  body: BudgetUpdate, actor: str, period: str, entity_type: str) -> list:
    """Upsert the budget row, apply the partial update, audit it. Returns changed fields."""
    if table == "agent_budgets":
        cur.execute(
            "INSERT INTO agent_budgets (agent_id, container_id, updated_by) VALUES (%s, %s, %s) "
            "ON CONFLICT (agent_id) DO NOTHING",
            (key, container_id, actor),
        )
    else:
        cur.execute(
            "INSERT INTO container_budgets (container_id, updated_by) VALUES (%s, %s) "
            "ON CONFLICT (container_id) DO NOTHING",
            (key, actor),
        )
    cur.execute(f"SELECT {_BUDGET_COLS} FROM {table} WHERE {key_col}=%s " + sql.for_update(), (key,))
    before = cur.fetchone()
    fields = body.model_fields_set
    sets, params, changed = [], [], {}
    limits_changed = False
    for col in ("monthly_limit_usd", "monthly_limit_tokens"):
        if col in fields:
            new = getattr(body, col)
            old = _num(before[col]) if col == "monthly_limit_usd" else before[col]
            if (new if new is None else float(new)) != (old if old is None else float(old)):
                sets.append(f"{col}=%s")
                params.append(new)
                changed[col] = {"from": old, "to": new}
                limits_changed = True
    if limits_changed:
        # New limits re-arm this month's 80% / 100% notices against the new numbers.
        sets += ["warned_period=NULL", "paused_period=NULL"]
    if body.override == "grant":
        sets += ["override_period=%s", "override_by=%s", "override_at=now()", "override_note=%s"]
        params += [period, actor, (body.note or "").strip() or None]
    elif body.override == "revoke":
        sets += ["override_period=NULL", "override_by=NULL", "override_at=NULL", "override_note=NULL"]
    if not sets:
        return []
    sets += ["updated_by=%s", "updated_at=now()"]
    params += [actor, key]
    cur.execute(f"UPDATE {table} SET {', '.join(sets)} WHERE {key_col}=%s", params)
    if changed:
        log_event(cur, container_id, "human", actor, entity_type, key, "budget_updated",
                  {"changes": changed, "period": period, "note": body.note})
    if body.override == "grant":
        log_event(cur, container_id, "human", actor, entity_type, key, "budget_override_granted",
                  {"period": period, "note": body.note})
    elif body.override == "revoke" and before["override_period"] == period:
        log_event(cur, container_id, "human", actor, entity_type, key, "budget_override_revoked",
                  {"period": period, "note": body.note})
    return list(changed) + ([f"override_{body.override}"] if body.override else [])


def _agent_container(cur, aid: str):
    if not valid_uuid(aid):
        raise HTTPException(400, "agent_id is not a valid UUID")
    cur.execute("SELECT id, container_id, kind, alias FROM agents WHERE id=%s", (aid,))
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, f"agent {aid} not found")
    return row


def _agent_response(statuses: dict, aid: str) -> dict:
    st = statuses["agents"].get(aid)
    if st is None:
        raise HTTPException(404, f"agent {aid} has no budget scope (retired or not an AI agent)")
    return {
        "period": statuses["period"],
        "starts_at": statuses["starts_at"],
        "resets_at": statuses["resets_at"],
        **st,
        "project": statuses["project"],
    }


@app.get("/api/agents/{aid}/budget")
def get_agent_budget(aid: str, request: Request):
    """One AI agent's monthly budget, month-to-date usage and hard-stop state.

    `state`: none | ok | warning (>= 80%) | exceeded (>= 100%). `paused` is true when the
    agent's own budget (`blocked_by`='agent') or the project cap (`blocked_by`='project') is
    exceeded with no active one-time override — the wake-scan then starts no NEW run for it
    (in-flight runs are never stopped). `usage.unmetered_runs` / `unmetered_tokens` are runs
    that reported no dollar figure: they are NOT counted as $0 of spend. Member-readable."""
    with db_cursor() as (_, cur):
        row = _agent_container(cur, aid)
        cid = str(row["container_id"])
        require_member_read(cur, request, cid)
        if row["kind"] != "ai":
            raise HTTPException(400, "budgets apply to AI agents — humans are never woken")
        return _agent_response(_public(budget_statuses(cur, cid)), aid)


@app.put("/api/agents/{aid}/budget")
def put_agent_budget(aid: str, body: BudgetUpdate, request: Request):
    """Set / clear an AI agent's monthly USD and/or token budget, or grant / revoke a
    one-time override (lifts the hard stop for the rest of the CURRENT month only).
    Human-authoritative: owner or `manage_autonomy`; viewers and AI agents are refused.
    Every change is audited (`budget_updated`, `budget_override_granted|revoked`)."""
    with db_cursor() as (conn, cur):
        row = _agent_container(cur, aid)
        cid = str(row["container_id"])
        actor = _authorize_write(cur, request, cid, body.actor_agent_id)
        if row["kind"] != "ai":
            raise HTTPException(400, "budgets apply to AI agents — humans are never woken")
        period = current_period(cur)["period"]
        _apply_update(cur, "agent_budgets", "agent_id", aid, cid, body, actor, period, "agent")
        statuses = budget_statuses(cur, cid)
        _resolve_after_update(cur, cid, statuses, actor, agent_id=aid)  # B26
        conn.commit()
        return _agent_response(_public(statuses), aid)


@app.get("/api/containers/{cid}/budgets")
def get_container_budgets(cid: str, request: Request):
    """Every AI agent's monthly budget status plus the optional project-wide cap, for the
    current UTC month (`period`, resets at `resets_at`). Agents with no budget read
    state='none' (their usage is still reported). Member-readable; project-isolated."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        require_member_read(cur, request, cid)
        st = _public(budget_statuses(cur, cid))
    return {**st, "agents": list(st["agents"].values())}


@app.put("/api/containers/{cid}/budget")
def put_container_budget(cid: str, body: BudgetUpdate, request: Request):
    """Set / clear the optional project-wide monthly cap (USD and/or tokens), or grant /
    revoke a one-time project override. Reaching the cap pauses EVERY AI agent for new
    runs. Same authority and audit rules as the per-agent budget."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (conn, cur):
        require_container(cur, cid)
        actor = _authorize_write(cur, request, cid, body.actor_agent_id)
        period = current_period(cur)["period"]
        _apply_update(cur, "container_budgets", "container_id", cid, cid, body, actor, period,
                      "container")
        statuses = budget_statuses(cur, cid)
        _resolve_after_update(cur, cid, statuses, actor)  # B26
        conn.commit()
        st = _public(statuses)
    return {**st, "agents": list(st["agents"].values())}
