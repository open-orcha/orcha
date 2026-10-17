-- PER-AGENT MONTHLY BUDGETS WITH HARD STOPS (+ an optional project-wide cap).
--
-- Semantics (portal_backend/budget_routes.py is the single source of truth):
--   * A budget is an OPTIONAL monthly limit in the SAME units the Metrics page already uses:
--     recorded USD (worker_runs.total_cost_usd, the mig-019 column) and — optionally — a token
--     cap over input + output + cache-read + cache-creation tokens (the quota doctrine of the
--     #289 token meter). A run that recorded NO dollar figure (subscription billing, Codex,
--     unpriced model) is "not metered": it is NEVER counted as $0 of spend. The owner may add a
--     token cap to bound such runs too.
--   * Budget month = UTC calendar month. Spend is attributed by worker_runs.started_at.
--     Rollover resets by construction: usage is recomputed per month, and every period-scoped
--     marker below (override / warned / paused) only applies while it equals the current
--     'YYYY-MM'.
--   * >= 80%  -> one `budget_warning` event + one Needs-you notice per month.
--     >= 100% -> the agent (or, for the project cap, every AI agent) is PAUSED FOR NEW RUNS:
--               the wake-scan withholds should_wake. An in-flight run is never killed.
--   * An owner / manage_autonomy member may raise the limit or grant a ONE-TIME override that
--     lifts the hard stop for the rest of the current month only (audited in `events`).
--
-- ADD-only: two new tables, no change to existing ones. Applied on portal boot by the R1 runner.

CREATE TABLE IF NOT EXISTS agent_budgets (
    agent_id              UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    container_id          UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    monthly_limit_usd     NUMERIC(14, 4) CHECK (monthly_limit_usd IS NULL OR monthly_limit_usd >= 0),
    monthly_limit_tokens  BIGINT CHECK (monthly_limit_tokens IS NULL OR monthly_limit_tokens >= 0),
    -- one-time override: active only while override_period = the current 'YYYY-MM'
    override_period       TEXT,
    override_by           UUID REFERENCES agents(id) ON DELETE SET NULL,
    override_at           TIMESTAMPTZ,
    override_note         TEXT,
    -- notice de-duplication: the month for which the 80% / 100% notice already fired
    warned_period         TEXT,
    paused_period         TEXT,
    updated_by            UUID REFERENCES agents(id) ON DELETE SET NULL,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_budgets_container ON agent_budgets (container_id);

CREATE TABLE IF NOT EXISTS container_budgets (
    container_id          UUID PRIMARY KEY REFERENCES containers(id) ON DELETE CASCADE,
    monthly_limit_usd     NUMERIC(14, 4) CHECK (monthly_limit_usd IS NULL OR monthly_limit_usd >= 0),
    monthly_limit_tokens  BIGINT CHECK (monthly_limit_tokens IS NULL OR monthly_limit_tokens >= 0),
    override_period       TEXT,
    override_by           UUID REFERENCES agents(id) ON DELETE SET NULL,
    override_at           TIMESTAMPTZ,
    override_note         TEXT,
    warned_period         TEXT,
    paused_period         TEXT,
    updated_by            UUID REFERENCES agents(id) ON DELETE SET NULL,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
