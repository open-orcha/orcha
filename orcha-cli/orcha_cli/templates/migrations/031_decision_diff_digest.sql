-- Approval–diff binding: a task-verify decision records the canonical digest of the
-- exact worker-run diff(s) the human reviewed (see GET /api/tasks/{tid}/diff). NULL for
-- decisions on subjects without a captured diff (research tasks, requests, checkpoints)
-- and for pre-binding history. Turns "a human typed approve" into "this human saw
-- exactly this diff" — the keystone the evidence pack and git attestation build on.
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS diff_digest TEXT;
