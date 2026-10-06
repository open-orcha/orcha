-- Goal ancestry: an explicit "parent task" link so every task can say WHY it exists.
--
-- A task's goal chain is  project objective -> parent task(s) -> this task.
-- Parents come from two REAL sources only (see portal_backend/goal_ancestry.py):
--   1. tasks.parent_task_id (this column) — set explicitly by a member or by an agent that
--      participates in the task, via PUT /api/tasks/{tid}/parent. Validated: same project,
--      never the root task (the root IS the objective), never the task itself, never a cycle.
--   2. derived — the task was spawned by accepting a task REQUEST whose originating_task_id
--      (mig 028) names the task the requester was working on. No column needed for that.
-- The objective is containers.description (falling back to the root task's description when it
-- differs from the project name). Nothing is guessed or backfilled.
--
-- Migration 062. ADD-only: a nullable column + index,
-- existing rows get NULL, nothing is rewritten. ON DELETE SET NULL: deleting a parent
-- leaves the child with no explicit parent rather than cascading.
ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS parent_task_id UUID NULL
        REFERENCES tasks(id) ON DELETE SET NULL;

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_parent_not_self;
ALTER TABLE tasks
    ADD CONSTRAINT tasks_parent_not_self CHECK (parent_task_id IS NULL OR parent_task_id <> id);

CREATE INDEX IF NOT EXISTS idx_tasks_parent_task ON tasks (parent_task_id)
    WHERE parent_task_id IS NOT NULL;
