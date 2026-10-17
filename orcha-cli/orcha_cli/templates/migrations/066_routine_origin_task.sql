-- Routines remember the task they were copied from ("Make recurring…" on a task). Additive only.
--
-- The routine is a COPY of the task as a template: the task itself is never converted or
-- changed. origin_task_id is provenance only — the routine shows "Created from task #…" and
-- the task shows a "Recurring" link back (GET /api/containers/{cid}/routines?origin_task_id=).
-- ON DELETE SET NULL like every other task reference on routines (054), so the project-reset
-- wipe keeps working unchanged.

ALTER TABLE routines
    ADD COLUMN IF NOT EXISTS origin_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_routines_origin_task ON routines (origin_task_id)
    WHERE origin_task_id IS NOT NULL AND archived_at IS NULL;
