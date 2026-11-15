-- A person's pause on one task (GH #343): who paused it, when, and why. Status is left
-- alone, so Resume returns the task exactly as it was. While paused_at is set, nothing
-- that wakes or starts an agent acts on the task (task_pause.py). Pausing a workflow
-- pauses every open task in it; paused_via_workflow marks those so the workflow's
-- Resume lifts only the pauses it set.

ALTER TABLE tasks ADD COLUMN paused_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN paused_by UUID REFERENCES agents(id);
ALTER TABLE tasks ADD COLUMN paused_reason TEXT;
ALTER TABLE tasks ADD COLUMN paused_via_workflow BOOLEAN NOT NULL DEFAULT false;
