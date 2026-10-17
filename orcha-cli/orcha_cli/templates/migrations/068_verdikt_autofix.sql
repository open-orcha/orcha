-- VERDIKT AUTO-FIX LOOP (migration 068).
--
-- Send it to Verdikt → it fails → send it back to the agent → the agent reworks → send it to
-- Verdikt → … until it passes, a stop condition fires, or a human steps in.
-- portal_backend/verdikt_autofix.py is the source of truth; docs/verdikt-integration.md §8
-- documents it.
--
--   * container_verdikt_settings gains (owner / manage_repo, like the rest):
--       autofix_enabled        "When Verdikt fails, send it back to the agent automatically"
--                              (default OFF). Takes effect only when trigger_mode is
--                              'ui_changes' or 'always'.
--       autofix_max_attempts   how many Verdikt checks one loop may make, the first included
--                              (default 3, 1..10). Attempt N of M.
--   * verdikt_runs.autofix: the run was auto-triggered while auto-fix applied to its task —
--     only such runs drive the loop (a run started before auto-fix was switched on never does).
--     verdikt_runs.autofix_done_at: when the loop judged the finished run (exactly once).
--   * verdikt_task_autofix: the per-task override ('on' / 'off'; no row = inherit the project).
--   * verdikt_autofix_loops: one row per loop. 'running' while the agent and Verdikt go back
--     and forth; 'stopped' with a stop_kind + a plain-words stop_reason (pass, attempt limit,
--     no progress, a non-fail outcome, budget / paused agent, a human acted, Stop auto-fix,
--     turned off). At most one running loop per task. A loop NEVER completes a task: it stops
--     with the task in needs_verification for a human.
--   * verdikt_autofix_attempts: one row per Verdikt run the loop judged (attempt N). UNIQUE on
--     the Verdikt run → evaluating the same finished run twice (two pollers, a retry) can never
--     send the task back twice.
--
-- ADD-only: defaulted columns + three new tables. Idempotent.

ALTER TABLE container_verdikt_settings ADD COLUMN IF NOT EXISTS autofix_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE container_verdikt_settings ADD COLUMN IF NOT EXISTS autofix_max_attempts INT NOT NULL DEFAULT 3;
DO $$ BEGIN
    ALTER TABLE container_verdikt_settings ADD CONSTRAINT container_verdikt_settings_autofix_max_chk
        CHECK (autofix_max_attempts BETWEEN 1 AND 10);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE verdikt_runs ADD COLUMN IF NOT EXISTS autofix BOOLEAN NOT NULL DEFAULT false;
-- when the loop judged this (finished) run — set exactly once, so the background check and a
-- person's "Check now" never both act on it
ALTER TABLE verdikt_runs ADD COLUMN IF NOT EXISTS autofix_done_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_verdikt_runs_autofix_pending ON verdikt_runs (task_id)
    WHERE autofix AND autofix_done_at IS NULL;

CREATE TABLE IF NOT EXISTS verdikt_task_autofix (
    task_id       UUID PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    container_id  UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    mode          TEXT NOT NULL CHECK (mode IN ('on', 'off')),
    updated_by    UUID REFERENCES agents(id) ON DELETE SET NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS verdikt_autofix_loops (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id       UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    container_id  UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    status        TEXT NOT NULL CHECK (status IN ('running', 'stopped')),
    max_attempts  INT NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
    stop_kind     TEXT CHECK (stop_kind IS NULL OR stop_kind IN
                    ('pass', 'attempt_limit', 'no_diff', 'same_failure', 'non_fail', 'budget',
                     'agent_paused', 'human', 'stopped_by_human', 'turned_off', 'no_assignee')),
    stop_reason   TEXT,
    stopped_by    UUID REFERENCES agents(id) ON DELETE SET NULL,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    stopped_at    TIMESTAMPTZ,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_verdikt_autofix_loops_task ON verdikt_autofix_loops (task_id, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_verdikt_autofix_loops_running ON verdikt_autofix_loops (task_id)
    WHERE status = 'running';

CREATE TABLE IF NOT EXISTS verdikt_autofix_attempts (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    loop_id           UUID NOT NULL REFERENCES verdikt_autofix_loops(id) ON DELETE CASCADE,
    task_id           UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    attempt           INT NOT NULL CHECK (attempt >= 1),
    verdikt_run_id    UUID NOT NULL UNIQUE REFERENCES verdikt_runs(id) ON DELETE CASCADE,
    outcome           TEXT NOT NULL,          -- pass | fail | the non-fail status/verdict
    action            TEXT NOT NULL CHECK (action IN ('reworked', 'stopped', 'passed')),
    failure_signature TEXT,
    change_signature  TEXT,
    failed            JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{text, expected, actual}]
    changes           JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {summary, files, href, run_ids[]}
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_verdikt_autofix_attempts_loop ON verdikt_autofix_attempts (loop_id, attempt);
