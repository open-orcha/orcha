-- PORTABLE PROJECT TEMPLATES (migration 059).
--
-- A project template is a versioned JSON bundle (format "orcha.project-template", v1) that
-- carries a project's reusable SETUP — AI roster (roles, prompts, models, autonomy
-- overrides, reporting lines), routines, definition-of-done presets, skills and, opt-in,
-- budgets — with secrets / keys / tokens / member identities scrubbed. Export + import
-- live in portal_backend/project_export_routes.py (logic: project_export_bundle.py).
--
-- Two of those sections had no store yet, so this migration adds them. ADD-only: two new
-- tables, nothing existing is touched. Deleting a preset / skill archives it
-- (archived_at), so an import can never resurrect or clash with history silently.
--
--   * project_dod_presets — named, reusable definition-of-done texts for a project
--     ("Web feature done", "Doc reviewed"...). A preset is plain text: whoever writes a
--     task / routine copies it into the task's own definition_of_done; editing a preset
--     never rewrites an existing task.
--   * project_skills — named markdown playbooks (instructions) the project keeps for its
--     agents ("release-checklist", "write-changelog"). Stored and carried in templates.
--     NB: nothing injects them into agent runs yet (wake context is a separate change) —
--     the UI says so rather than implying agents already read them.
--
-- Actor columns are ON DELETE SET NULL so the project-reset wipe keeps working.

CREATE TABLE IF NOT EXISTS project_dod_presets (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    container_id        UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    name                TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    body                TEXT NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
    source              TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'template_import')),
    created_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    updated_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    archived_at         TIMESTAMPTZ
);
-- one LIVE preset per name per project (case-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_dod_presets_name
    ON project_dod_presets (container_id, lower(name)) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS project_skills (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    container_id        UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    name                TEXT NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
    description         TEXT CHECK (description IS NULL OR length(description) <= 300),
    body                TEXT NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 20000),
    source              TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'template_import')),
    created_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    updated_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    archived_at         TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_skills_name
    ON project_skills (container_id, name) WHERE archived_at IS NULL;
