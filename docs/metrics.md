# Metrics page — usage & cost visibility per agent

The portal's `/metrics` page answers "what is this workspace burning, and on
whom": estimated spend, runs, sandbox compute time, and token throughput per
agent, over a 7- or 30-day window.

## What it shows

- **Stat cards** — est. total cost (with an honest coverage caption, see below),
  runs in the window, humanized sandbox compute time (wall-clock of finished
  `wake_kind='sandbox'` runs), and tasks completed / human-verified.
- **Daily activity** — a CSS bar sparkline, one column per UTC day of the window,
  quiet days rendered as honest zero columns (each column's tooltip carries the
  date, run count, and cost).
- **Cost & activity by agent** — avatar/alias, embodiment model tag, runs with an
  ok/failed split, compute time, compact token in/out figures, and est. cost with
  a pure-CSS proportion bar (scaled to the most expensive agent).

An empty window shows an explicit empty state — no fabricated numbers.

## The endpoint

`GET /api/containers/{cid}/metrics?days=7` (1–90; the page offers 7/30) returns:

```json
{
  "container_id": "…", "days": 7,
  "totals":    { "runs": 6, "sandbox_seconds": 8100.0, "est_cost_usd": 3.5,
                 "tokens_in": 1200, "tokens_out": 45000, "runs_with_cost": 4,
                 "tasks_completed": 5, "tasks_verified": 3 },
  "per_agent": [ { "agent_id": "…", "alias": "…", "model": "…", "runs": 4,
                   "ok_runs": 3, "failed_runs": 1, "sandbox_seconds": 8100.0,
                   "est_cost_usd": 3.0, "tokens_in": 1000, "tokens_out": 40000,
                   "last_active": "2026-07-31T01:00:00+00:00" } ],
  "daily":     [ { "date": "2026-07-25", "runs": 0, "est_cost_usd": 0.0,
                   "sandbox_seconds": 0.0 } ]
}
```

`per_agent` is sorted by cost desc; `daily` covers every day of the window with
gaps zero-filled. As everywhere, the OpenAPI spec (`/openapi.json`) is the
contract of record.

## Where cost comes from (and why it says "estimated")

Per run, in order:

1. **Daemon-recorded columns** (migration 019): when the notifier parsed the
   wake log on `/finish`, `worker_runs.total_cost_usd` / `input_tokens` /
   `output_tokens` are authoritative.
2. **Output-tail parse**: otherwise the endpoint parses the LAST terminal record
   out of the run's captured stream-json `output` — Claude's
   `{"type":"result", "total_cost_usd": …, "usage": {…}}`, or a Codex
   turn-terminal event (tokens only; Codex reports no USD). Only the last 4KB of
   the column is read per row (SQL `right()`), because the terminal record rides
   the tail — an aggregate must never haul multi-megabyte logs.
3. **Nothing parseable** (pre-019 kill rows, garbled tails, non-stream output):
   the run contributes 0 and is *excluded* from `runs_with_cost`.

`runs_with_cost` is surfaced so the UI can label the total honestly:
"estimated · N of M runs reported cost". The dollar figure is a floor, not an
invoice.

## Tests

- `tests/test_metrics_endpoint.py` — parser + endpoint math on seeded rows
  (tail parsing incl. garbled/truncated, window filtering, per-agent totals,
  daily gap-fill, sandbox attribution, N-of-M coverage, task counters).
- `node tests/portal/metrics_page.test.js` — page skeleton/registration and the
  payload → HTML render (cards, table, sparkline, empty state, escaping).
