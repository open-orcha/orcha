-- General (non-code) project mode + industry templates. ADDITIVE ONLY.
-- Migration 060; runs after 059 (portable templates), whose project_dod_presets store it writes to.
--
--   containers.project_mode  'code' (default — every existing project stays exactly as it
--                            is) | 'general' (non-code work: the portal hides the Code and
--                            GitHub tabs and words work as deliverables, not PRs). It is a
--                            presentation/intent flag: no server-side gate reads it, so
--                            plan approval, verification and autonomy are unchanged.
--   (DoD presets are NOT stored here: applying a template writes them into the shared
--    project_dod_presets store from migration 059 — portable templates — with
--    source='template_import', so the project has ONE preset list.)
--   containers.template_key  the last template applied (informational; NULL = none).
--   project_template_applications
--                            the audit trail of every template application: exactly what
--                            the human confirmed (plan) and what was created (result).
--
-- Agent references are ON DELETE SET NULL so the project-reset wipe keeps working.

ALTER TABLE containers ADD COLUMN IF NOT EXISTS project_mode TEXT NOT NULL DEFAULT 'code';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'containers_project_mode_chk'
    ) THEN
        ALTER TABLE containers ADD CONSTRAINT containers_project_mode_chk
            CHECK (project_mode IN ('code', 'general'));
    END IF;
END $$;

ALTER TABLE containers ADD COLUMN IF NOT EXISTS template_key TEXT NULL;

CREATE TABLE IF NOT EXISTS project_template_applications (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    container_id        UUID NOT NULL REFERENCES containers(id),
    template_key        TEXT NOT NULL,
    template_version    INT  NOT NULL,
    applied_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    plan                JSONB NOT NULL,   -- what the human confirmed (the preview)
    result              JSONB NOT NULL,   -- what was actually created / skipped / failed
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_template_applications_container
    ON project_template_applications (container_id, created_at DESC);
