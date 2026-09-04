"""Aggregate per-container usage/cost metrics for the portal Metrics page."""

import json
from datetime import timedelta, timezone
from decimal import Decimal

from fastapi import HTTPException, Query, Request

from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container, valid_uuid
from portal_backend.identity_routes import require_member_read

# Cap how much captured stream-json we haul out of the DB per run row. The terminal
# `result` record rides the very END of the log (notifier_process._usage_from_log
# reads the same tail on the host), so 4KB of tail is plenty — a run row's full
# `output` can be megabytes and must never be shipped whole for an aggregate.
OUTPUT_TAIL_BYTES = 4096

# Codex (`codex exec --json`) has no Claude-style `result` event; its terminal
# turn event family (notifier_codex_events._codex_is_turn_end, recognized
# tolerantly because codex is unpinned) carries a `usage` object with token
# counts but never a USD cost.
_CODEX_TURN_END_TYPES = (
    "turn.completed", "turn.failed", "turn.done", "turn_complete",
    "turn_completed", "turn_failed", "turn_end", "task_complete",
    "task_completed", "task_finished",
)


def _num(value):
    """Coerce a JSON/DB scalar (int/float/NUMERIC) to float; absent/garbled → None."""
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        return None
    return float(value)


def _int(value):
    """Coerce a JSON/DB scalar (int/float/NUMERIC) to int; absent/garbled → None."""
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        return None
    return int(value)


def parse_output_tail(tail):
    """Extract {'cost','tokens_in','tokens_out'} from a captured stream-json tail.

    Scans the tail's lines newest-first. Unparseable lines are SKIPPED, not fatal:
    the SQL right() cut garbles the OLDEST line of the tail, and a mid-write crash
    can garble the newest — either way the terminal record, when present, still
    parses. Claude runs end in a `{"type":"result", ...}` record (total_cost_usd +
    usage); Codex runs end in a turn-terminal event whose usage has tokens but no
    cost. Absent / fully garbled / non-stream output → None (caller treats as
    "this run reported nothing", contributing 0 and staying out of the N-of-M
    cost-coverage count).
    """
    if not tail:
        return None
    for raw in reversed(tail.splitlines()):
        line = raw.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue                         # truncated/garbled line — keep scanning up
        if not isinstance(obj, dict):
            continue
        if obj.get("type") == "result":      # Claude terminal record
            usage = obj.get("usage") if isinstance(obj.get("usage"), dict) else {}
            return {
                "cost": _num(obj.get("total_cost_usd")),
                "tokens_in": _int(usage.get("input_tokens")),
                "tokens_out": _int(usage.get("output_tokens")),
            }
        msg = obj.get("msg") if isinstance(obj.get("msg"), dict) else {}
        for t in (obj.get("type"), msg.get("type")):
            if t in _CODEX_TURN_END_TYPES:   # Codex terminal record — tokens, no USD
                usage = obj.get("usage") if isinstance(obj.get("usage"), dict) else (
                    msg.get("usage") if isinstance(msg.get("usage"), dict) else {}
                )
                return {
                    "cost": None,
                    "tokens_in": _int(usage.get("input_tokens")),
                    "tokens_out": _int(usage.get("output_tokens")),
                }
    return None


def _run_measures(row):
    """One run row → (cost, tokens_in, tokens_out, has_cost).

    The daemon-recorded columns (mig 019, populated on /finish when the host
    parsed the wake log) are authoritative when present; the `output` tail parse
    is the fallback for rows that predate mig 019 or whose finish carried only
    raw output. has_cost is True only when EITHER source actually reported a
    dollar figure — it feeds the honest "estimated, N of M runs reported cost"
    caption.
    """
    cost = _num(row["total_cost_usd"])
    tokens_in = _int(row["input_tokens"])
    tokens_out = _int(row["output_tokens"])
    if cost is None and tokens_in is None and tokens_out is None:
        parsed = parse_output_tail(row["output_tail"])
        if parsed:
            cost = parsed["cost"]
            tokens_in = parsed["tokens_in"]
            tokens_out = parsed["tokens_out"]
    return cost, tokens_in, tokens_out, cost is not None


def _run_seconds(row):
    """A finished run's wall-clock seconds, else 0.0 (running/clock-garbled rows)."""
    if row["started_at"] is None or row["ended_at"] is None:
        return 0.0
    return max(0.0, (row["ended_at"] - row["started_at"]).total_seconds())


def _is_failed(row):
    """A terminal run that did not exit cleanly (running rows are neither ok nor failed)."""
    if row["status"] in ("killed", "failed", "rate_limited"):
        return True
    return row["status"] == "exited" and (row["exit_code"] or 0) != 0


@app.get("/api/containers/{cid}/metrics")
def container_metrics(
    cid: str, request: Request, days: int = Query(default=7, ge=1, le=90)
):
    """Usage/cost visibility per agent for the portal /metrics page.

    One windowed pass over worker_runs (joined to agents for the container) with the
    heavy `output` column capped to its last OUTPUT_TAIL_BYTES via SQL right() —
    the terminal result record lives at the tail, so the aggregate never hauls a
    multi-megabyte log per row. Cost/token extraction prefers the daemon-recorded
    mig-019 columns and falls back to parsing that tail (see _run_measures);
    absent/garbled degrades to 0, and `totals.runs_with_cost` counts how many runs
    actually reported a dollar figure so the UI can label the total honestly.

    Returns:
      totals    — runs, sandbox_seconds (finished wake_kind='sandbox' wall-clock),
                  est_cost_usd, tokens_in/out, runs_with_cost, tasks_completed
                  (completed_at in window) and tasks_verified (human 'verified'
                  audit events in window).
      per_agent — one row per agent that ran in the window, sorted by cost desc.
      daily     — one bucket per UTC day covering the whole window, gaps zero-filled.

    Untyped dict → no response_model → the OpenAPI surface documents a NEW read
    path with zero drift risk (same convention as /token-usage).
    """
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        # Access model: reads are project-isolated (trusted non-member 403).
        require_member_read(cur, request, cid)
        cur.execute(
            """SELECT wr.run_id, wr.agent_id, wr.wake_kind, wr.status, wr.exit_code,
                      wr.started_at, wr.ended_at,
                      wr.input_tokens, wr.output_tokens, wr.total_cost_usd,
                      right(wr.output, %s) AS output_tail,
                      a.alias, a.model
                 FROM worker_runs wr JOIN agents a ON a.id = wr.agent_id
                WHERE a.container_id = %s
                  AND wr.started_at >= now() - make_interval(days => %s)""",
            (OUTPUT_TAIL_BYTES, cid, days),
        )
        runs = cur.fetchall()
        cur.execute(
            """SELECT count(*) AS n FROM tasks
                WHERE container_id = %s AND status = 'completed'
                  AND completed_at >= now() - make_interval(days => %s)""",
            (cid, days),
        )
        tasks_completed = int(cur.fetchone()["n"])
        cur.execute(
            """SELECT count(*) AS n FROM events
                WHERE container_id = %s AND entity_type = 'task'
                  AND event_type = 'verified'
                  AND COALESCE(detail->>'approved', 'true') = 'true'
                  AND created_at >= now() - make_interval(days => %s)""",
            (cid, days),
        )
        tasks_verified = int(cur.fetchone()["n"])
        cur.execute("SELECT now() AS db_now")
        db_now = cur.fetchone()["db_now"]

    totals = {
        "runs": 0, "sandbox_seconds": 0.0, "est_cost_usd": 0.0,
        "tokens_in": 0, "tokens_out": 0, "runs_with_cost": 0,
        "tasks_completed": tasks_completed, "tasks_verified": tasks_verified,
    }
    agents: dict = {}
    # Zero-fill every UTC day of the window up-front, so quiet days render as
    # honest zero bars instead of silently vanishing from the sparkline.
    today = db_now.astimezone(timezone.utc).date()
    day_keys = [(today - timedelta(days=i)).isoformat() for i in range(days - 1, -1, -1)]
    daily = {
        d: {"date": d, "runs": 0, "est_cost_usd": 0.0, "sandbox_seconds": 0.0}
        for d in day_keys
    }

    for row in runs:
        cost, tokens_in, tokens_out, has_cost = _run_measures(row)
        seconds = _run_seconds(row) if row["wake_kind"] == "sandbox" else 0.0
        totals["runs"] += 1
        totals["sandbox_seconds"] += seconds
        totals["est_cost_usd"] += cost or 0.0
        totals["tokens_in"] += tokens_in or 0
        totals["tokens_out"] += tokens_out or 0
        totals["runs_with_cost"] += 1 if has_cost else 0

        aid = str(row["agent_id"])
        agent = agents.setdefault(aid, {
            "agent_id": aid, "alias": row["alias"], "model": row["model"],
            "runs": 0, "ok_runs": 0, "failed_runs": 0, "sandbox_seconds": 0.0,
            "est_cost_usd": 0.0, "tokens_in": 0, "tokens_out": 0,
            "last_active": None,
        })
        agent["runs"] += 1
        if _is_failed(row):
            agent["failed_runs"] += 1
        elif row["status"] == "exited":
            agent["ok_runs"] += 1
        agent["sandbox_seconds"] += seconds
        agent["est_cost_usd"] += cost or 0.0
        agent["tokens_in"] += tokens_in or 0
        agent["tokens_out"] += tokens_out or 0
        last = row["ended_at"] or row["started_at"]
        if last is not None and (
            agent["last_active"] is None or last.isoformat() > agent["last_active"]
        ):
            agent["last_active"] = last.isoformat()

        if row["started_at"] is not None:
            day = row["started_at"].astimezone(timezone.utc).date().isoformat()
            bucket = daily.get(day)
            if bucket is not None:
                bucket["runs"] += 1
                bucket["est_cost_usd"] += cost or 0.0
                bucket["sandbox_seconds"] += seconds

    for agg in (totals, *agents.values(), *daily.values()):
        agg["est_cost_usd"] = round(agg["est_cost_usd"], 6)
        if "sandbox_seconds" in agg:
            agg["sandbox_seconds"] = round(agg["sandbox_seconds"], 3)

    per_agent = sorted(
        agents.values(),
        key=lambda a: (-a["est_cost_usd"], -a["runs"], a["alias"] or ""),
    )
    return {
        "container_id": cid,
        "days": days,
        "totals": totals,
        "per_agent": per_agent,
        "daily": [daily[d] for d in day_keys],
    }
