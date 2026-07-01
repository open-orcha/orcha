-- GH #27: scheduled tasks — a task that re-fires on a fixed interval.
-- A scheduled task runs like any other, but `schedule_interval_secs` seconds after it
-- COMPLETES it is re-armed back to 'ready' (and its assignment re-opened) so it runs again.
-- The cadence is measured from each completion (no overlap: it never re-fires while still
-- in_progress / needs_verification), so a long run just delays the next fire rather than
-- piling up. `last_fired_at` is observability only — the due check keys off completed_at.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS schedule_interval_secs INT
    CHECK (schedule_interval_secs IS NULL OR schedule_interval_secs >= 60);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS last_fired_at TIMESTAMPTZ;

-- Partial index for the per-tick re-arm scan: only scheduled tasks are ever candidates.
CREATE INDEX IF NOT EXISTS idx_tasks_scheduled
    ON tasks (container_id, completed_at)
    WHERE schedule_interval_secs IS NOT NULL;
