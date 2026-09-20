-- GH #249: pin the read-only file browser to the exact filesystem state whose
-- diff was captured for a worker run. The notifier writes a private immutable
-- Git commit and stores its SHA here; older runs remain readable in diff-only
-- mode rather than silently falling back to a mutable branch.
ALTER TABLE worker_runs ADD COLUMN IF NOT EXISTS snapshot_ref TEXT;
