-- No-progress wake circuit breaker (INCIDENT: quantal-health, 2026-08-03 — ~4,300 wakes
-- over 3 days at ~40s cadence for a `task_created_unassigned` candidate the orchestrator kept
-- receiving and never acting on; each spawned worker ran ~5-80s, changed nothing, exited;
-- billed invisibly against the operator's Claude subscription. An in-memory daemon-side
-- suppression died on every deploy restart — the fix has to be SERVER-side and DB-backed so
-- it survives daemon/portal restarts and lives where the wake DECISION already lives
-- (wake_scan_routes / wake_candidate_builder — see #266/#288's "server owns should_wake").
--
-- One row per (agent, wake_key) the wake-scan keeps re-emitting with NO progress: the agent's
-- most recent COMPLETED worker_run shares the candidate's wake_kind/wake_event family, ended
-- recently, and the SAME candidate is still here next scan (nothing changed). `wake_key` is the
-- candidate identity string (mirrors notifier_wake_facade.derive_wake_event's precedence —
-- latest_event | auto_start | self_wake | auto_wake — e.g. 'task_created_unassigned'), NOT a
-- worker_runs.wake_kind (transport: ephemeral|tmux|resident|sandbox) — different axis, same name
-- collision the wake_event column already had before mig 010's rename, so the doc comment here
-- is deliberately explicit.
--
-- strikes: consecutive no-progress ticks (upserted, ++ on repeat, reset to a fresh row when the
-- candidate disappears — see wake_backoff.py). suppressed_until: while in the future, the wake-
-- scan filters this (agent, wake_key) OUT of its candidates response — the daemon never sees it,
-- zero daemon-side changes required. first_strike_at/last_strike_at are audit/debugging fields
-- (when did this trigger start looping, when did it last fire).
--
-- The breaker NEVER cancels work or changes task state — it only slows the WAKE CADENCE for a
-- trigger nobody is consuming. Human release valve (DELETE .../wake-backoff/{wake_key}) always
-- wins and clears the row outright — resume is immediate, not "wait out the timer".
CREATE TABLE IF NOT EXISTS wake_backoff (
    container_id      UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    agent_id          UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    wake_key          TEXT NOT NULL,
    strikes           INT NOT NULL DEFAULT 0,
    suppressed_until  TIMESTAMPTZ,
    last_strike_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    first_strike_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    notified_at       TIMESTAMPTZ,          -- set once the tier>=10 needs-you artifact is created,
                                             -- so the human ping fires ONCE per (agent, wake_key)
                                             -- strike-streak, not every tick past the threshold.
    PRIMARY KEY (agent_id, wake_key)
);

-- The scan's per-tick lookup is "this container's active suppressions" (filter) and
-- "this agent's row for this wake_key" (strike/reset) — the PK already covers the latter;
-- this covers the former plus the GET .../wake-backoff listing.
CREATE INDEX IF NOT EXISTS idx_wake_backoff_container ON wake_backoff (container_id);
