-- PLAN USAGE SNAPSHOTS (migration 069).
--
-- The Embodent desktop app computes Claude / Codex plan limits locally (Keychain OAuth +
-- Anthropic usage API; Codex logs). A phone can do neither, so the desktop PUBLISHES a
-- privacy-safe snapshot to each portal it is connected to, and the mobile apps READ it.
-- portal_backend/plan_usage_routes.py is the source of truth (PUT/GET /api/plan-usage).
--
-- One row per desktop machine (host), upserted. payload carries ONLY plan names, window
-- labels / used % / reset times and today's token count + estimated cost — never tokens,
-- credentials, file paths, prompts or account emails (enforced by the strict Pydantic model).
--
-- ADD-only: one new table. Idempotent.

CREATE TABLE IF NOT EXISTS plan_usage_snapshots (
    host         TEXT PRIMARY KEY,
    payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
    captured_at  TIMESTAMPTZ NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_plan_usage_snapshots_updated ON plan_usage_snapshots (updated_at DESC);
