-- Orcha QA onboarding (docs/orcha-qa-plan.md, "Onboarding"): one row per project, the phases a
-- project goes through to enter QA (the "We found" sheet, the code map, the tests, the live pass,
-- coverage, bringing tests in, the first run). `found`, `options` and `phases` are JSON; the
-- background thread that advances the phases writes them.
-- ADD-only: a new table, no change to existing ones.

CREATE TABLE qa_onboarding (
    container_id UUID PRIMARY KEY NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    phase TEXT NOT NULL DEFAULT 'found',
    state TEXT NOT NULL DEFAULT 'idle',
    found JSONB NOT NULL DEFAULT '{}',
    options JSONB NOT NULL DEFAULT '{}',
    phases JSONB NOT NULL DEFAULT '{}',
    error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    updated_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    CONSTRAINT qa_onboarding_phase_check CHECK (phase IN ('found', 'code_map', 'tests', 'live', 'coverage', 'bring_in', 'first_run', 'done')),
    CONSTRAINT qa_onboarding_state_check CHECK (state IN ('idle', 'running', 'waiting', 'failed', 'done'))
);

INSERT OR IGNORE INTO schema_migrations (version)
VALUES ('024_qa_onboarding.sql'), ('094_qa_onboarding.sql');
