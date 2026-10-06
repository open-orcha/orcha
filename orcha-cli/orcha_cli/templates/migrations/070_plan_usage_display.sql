-- PLAN USAGE DISPLAY SETTING (migration 070).
--
-- One portal-wide switch for the plan-usage summary (the desktop sidebar's Usage row, the
-- web sidebar row and the mobile Home card): whether it shows at all, and which providers.
-- Off by default. portal_backend/plan_usage_routes.py is the source of truth
-- (GET/PUT /api/plan-usage/display). Desktop, web and mobile all read and write this row,
-- so turning it on anywhere turns it on everywhere for this stack.
--
-- ADD-only: one new single-row table. Idempotent.

CREATE TABLE IF NOT EXISTS plan_usage_display (
    id          SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    show        BOOLEAN NOT NULL DEFAULT false,
    providers   TEXT NOT NULL DEFAULT 'both' CHECK (providers IN ('both', 'claude', 'codex')),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
