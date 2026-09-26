"""Report measured worker-run token consumption for a container."""

import os
from typing import Optional

from fastapi import HTTPException, Request

from portal_backend.application import app
from portal_backend.database import db_cursor
from portal_backend.guards import require_container, valid_uuid
from portal_backend.identity_routes import require_member_read

MEASURED_USAGE = (
    "(wr.input_tokens IS NOT NULL OR wr.output_tokens IS NOT NULL "
    "OR wr.cache_read_input_tokens IS NOT NULL OR wr.cache_creation_input_tokens IS NOT NULL "
    "OR wr.total_cost_usd IS NOT NULL)"
)


def quota_env(name: str) -> Optional[int]:
    """Return a positive operator-configured quota, or None when it is unavailable."""
    raw = os.environ.get(name)
    if not raw:
        return None
    try:
        value = int(raw)
    except ValueError:
        return None
    return value if value > 0 else None


def usage_window(row, quota):
    total = int(row["it"] + row["ot"] + row["crt"] + row["cct"])
    return {
        "input_tokens": int(row["it"]),
        "output_tokens": int(row["ot"]),
        "cache_read_input_tokens": int(row["crt"]),
        "cache_creation_input_tokens": int(row["cct"]),
        "total_tokens": total,
        "total_cost_usd": float(row["cost"]),
        "runs": int(row["runs"]),
        "quota_tokens": quota,
        "pct_of_quota": round(total / quota * 100, 2) if quota else None,
    }


@app.get("/api/containers/{cid}/token-usage")
def container_token_usage(cid: str, request: Request):
    """#289 (EFFICIENCY epic, measurement backbone): the tokens-vs-quota METER. Aggregates the
    per-wake token usage the daemon now records on worker_runs (mig 019) into rolling windows so
    we can SEE what the fleet is burning and prove a fix moved the number.

    The accounting that matters: a wake's load against the plan QUOTA is input + output +
    cache-CREATION + cache-READ tokens. Cache reads are nearly free in dollars yet still count
    against the quota — that is exactly the burn that hid behind a small dollar figure — so
    `total_tokens` sums all four, and the dollar figure (`total_cost_usd`) is surfaced
    separately, never as the quota signal.

    Windows: `5h` (the rolling session quota window), `7d` (the weekly quota), and `all` (since
    the container was created). Each carries the four token kinds, their sum, dollar cost, the
    run (wake) count, and — only when the matching ORCHA_QUOTA_* env is pinned — a pct-of-quota.
    Also returns a per-agent all-time breakdown (who is burning) and the single most-recent wake
    (per-wake number). Untyped dict → no response_model → zero OpenAPI drift on a NEW read path.

    NOTE: only wakes that recorded usage (finished post-mig-019, with a parseable result event)
    contribute; older / still-running / usage-less rows are simply absent (NULLs treated as 0)."""
    if not valid_uuid(cid):
        raise HTTPException(400, "container_id is not a valid UUID")
    quota_5h = quota_env("ORCHA_QUOTA_5H_TOKENS")
    quota_7d = quota_env("ORCHA_QUOTA_WEEKLY_TOKENS")
    with db_cursor() as (_, cur):
        require_container(cur, cid)
        # Access model: reads are project-isolated (trusted non-member 403).
        require_member_read(cur, request, cid)
        cur.execute(
            f"""WITH r AS (
                   SELECT wr.ended_at,
                          COALESCE(wr.input_tokens,0)                 AS it,
                          COALESCE(wr.output_tokens,0)                AS ot,
                          COALESCE(wr.cache_read_input_tokens,0)      AS crt,
                          COALESCE(wr.cache_creation_input_tokens,0)  AS cct,
                          COALESCE(wr.total_cost_usd,0)               AS cost
                     FROM worker_runs wr JOIN agents a ON a.id = wr.agent_id
                    WHERE a.container_id=%s AND wr.ended_at IS NOT NULL
                      AND {MEASURED_USAGE}
               )
               SELECT %s AS win,
                      count(*) FILTER (WHERE ended_at >= now() - interval '5 hours')  AS runs,
                      COALESCE(sum(it)  FILTER (WHERE ended_at >= now() - interval '5 hours'),0) AS it,
                      COALESCE(sum(ot)  FILTER (WHERE ended_at >= now() - interval '5 hours'),0) AS ot,
                      COALESCE(sum(crt) FILTER (WHERE ended_at >= now() - interval '5 hours'),0) AS crt,
                      COALESCE(sum(cct) FILTER (WHERE ended_at >= now() - interval '5 hours'),0) AS cct,
                      COALESCE(sum(cost) FILTER (WHERE ended_at >= now() - interval '5 hours'),0) AS cost
                 FROM r
               UNION ALL
               SELECT '7d',
                      count(*) FILTER (WHERE ended_at >= now() - interval '7 days'),
                      COALESCE(sum(it)  FILTER (WHERE ended_at >= now() - interval '7 days'),0),
                      COALESCE(sum(ot)  FILTER (WHERE ended_at >= now() - interval '7 days'),0),
                      COALESCE(sum(crt) FILTER (WHERE ended_at >= now() - interval '7 days'),0),
                      COALESCE(sum(cct) FILTER (WHERE ended_at >= now() - interval '7 days'),0),
                      COALESCE(sum(cost) FILTER (WHERE ended_at >= now() - interval '7 days'),0)
                 FROM r
               UNION ALL
               SELECT 'all', count(*),
                      COALESCE(sum(it),0), COALESCE(sum(ot),0), COALESCE(sum(crt),0),
                      COALESCE(sum(cct),0), COALESCE(sum(cost),0)
                 FROM r""",
            (cid, "5h"),
        )
        rows = {row["win"]: row for row in cur.fetchall()}
        windows = {
            "5h": usage_window(rows["5h"], quota_5h),
            "7d": usage_window(rows["7d"], quota_7d),
            "all": usage_window(rows["all"], None),
        }

        cur.execute(
            f"""SELECT a.id AS agent_id, a.alias,
                      count(wr.*) AS runs,
                      COALESCE(sum(COALESCE(wr.input_tokens,0)+COALESCE(wr.output_tokens,0)
                               +COALESCE(wr.cache_read_input_tokens,0)
                               +COALESCE(wr.cache_creation_input_tokens,0)),0) AS total_tokens,
                      COALESCE(sum(wr.total_cost_usd),0) AS total_cost_usd
                 FROM agents a
                 JOIN worker_runs wr ON wr.agent_id = a.id AND wr.ended_at IS NOT NULL
                      AND {MEASURED_USAGE}
                WHERE a.container_id=%s
                GROUP BY a.id, a.alias
                ORDER BY total_tokens DESC""",
            (cid,),
        )
        per_agent = [
            {
                "agent_id": str(row["agent_id"]),
                "alias": row["alias"],
                "runs": int(row["runs"]),
                "total_tokens": int(row["total_tokens"]),
                "total_cost_usd": float(row["total_cost_usd"]),
            }
            for row in cur.fetchall()
        ]
        cur.execute(
            f"""SELECT wr.run_id, a.alias, wr.ended_at, wr.total_cost_usd,
                      COALESCE(wr.input_tokens,0)+COALESCE(wr.output_tokens,0)
                        +COALESCE(wr.cache_read_input_tokens,0)
                        +COALESCE(wr.cache_creation_input_tokens,0) AS total_tokens
                 FROM worker_runs wr JOIN agents a ON a.id = wr.agent_id
                WHERE a.container_id=%s AND wr.ended_at IS NOT NULL
                      AND {MEASURED_USAGE}
                ORDER BY wr.ended_at DESC LIMIT 1""",
            (cid,),
        )
        last_row = cur.fetchone()

    last_wake = None
    if last_row:
        last_wake = {
            "run_id": str(last_row["run_id"]),
            "agent_alias": last_row["alias"],
            "ended_at": last_row["ended_at"].isoformat()
            if last_row["ended_at"]
            else None,
            "total_tokens": int(last_row["total_tokens"]),
            "total_cost_usd": float(last_row["total_cost_usd"])
            if last_row["total_cost_usd"] is not None
            else None,
        }
    return {
        "container_id": cid,
        "windows": windows,
        "per_agent": per_agent,
        "last_wake": last_wake,
    }
