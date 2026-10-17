-- Routines: recurring scheduled work. Additive only.
--
-- A routine never does work itself: when due, the scheduler creates a NORMAL task through
-- the existing task-creation path (POST /api/containers/{cid}/tasks semantics), so plan
-- approval, verification, autonomy and any budget gates apply exactly as for a
-- human-created task. routine_runs is the per-routine history (and the audit trail of
-- what the scheduler did and why).
--
-- Agent/task references are ON DELETE SET NULL so the project-reset wipe
-- (container_lifecycle_routes) keeps working unchanged: a routine whose author was wiped
-- stays listed and its next run fails honestly until a member re-saves it.

CREATE TABLE IF NOT EXISTS routines (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    container_id        UUID NOT NULL REFERENCES containers(id),
    title               TEXT NOT NULL,
    description         TEXT,
    definition_of_done  TEXT NOT NULL,
    assignee_agent_id   UUID REFERENCES agents(id) ON DELETE SET NULL, -- NULL = normal assignment
    priority            INT  NOT NULL DEFAULT 100,        -- same scale as tasks.priority
    cron                TEXT NOT NULL,                    -- 5-field cron on the local wall clock
    timezone            TEXT NOT NULL DEFAULT 'UTC',      -- IANA zone name
    enabled             BOOLEAN NOT NULL DEFAULT true,
    skip_if_open        BOOLEAN NOT NULL DEFAULT true,
    next_run_at         TIMESTAMPTZ,                      -- NULL while disabled
    last_run_at         TIMESTAMPTZ,
    created_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL, -- who set it up
    updated_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL, -- tasks are created as
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    archived_at         TIMESTAMPTZ                       -- deleted routines keep their history
);

CREATE INDEX IF NOT EXISTS idx_routines_container ON routines (container_id)
    WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_routines_due ON routines (next_run_at)
    WHERE enabled AND archived_at IS NULL;

CREATE TABLE IF NOT EXISTS routine_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    routine_id      UUID NOT NULL REFERENCES routines(id),
    container_id    UUID NOT NULL REFERENCES containers(id),
    trigger         TEXT NOT NULL CHECK (trigger IN ('schedule', 'catch_up', 'manual')),
    scheduled_for   TIMESTAMPTZ,                 -- the slot fired (NULL for a manual run)
    missed_count    INT NOT NULL DEFAULT 0,      -- catch_up: slots missed while Orcha was down
    outcome         TEXT NOT NULL CHECK (outcome IN ('pending', 'created', 'skipped', 'failed')),
    task_id         UUID REFERENCES tasks(id) ON DELETE SET NULL,
    detail          TEXT,
    actor_agent_id  UUID REFERENCES agents(id) ON DELETE SET NULL, -- who the task was created as / who clicked
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_routine_runs_routine ON routine_runs (routine_id, created_at DESC);
-- A scheduled slot fires at most once, even under concurrent scheduler passes.
CREATE UNIQUE INDEX IF NOT EXISTS uq_routine_runs_slot ON routine_runs (routine_id, scheduled_for)
    WHERE scheduled_for IS NOT NULL;

-- When the scheduler last checked this project (truthful "is anything firing?" signal).
CREATE TABLE IF NOT EXISTS routine_scheduler_state (
    container_id  UUID PRIMARY KEY REFERENCES containers(id),
    last_tick_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
