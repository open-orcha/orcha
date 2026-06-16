-- #240 + #171/ISS-72: human-requested GRACEFUL STOP of a worker run / resident turn.
-- Server-RECORDED, daemon-ENFORCED. The API runs in Docker and CANNOT signal host PIDs; only
-- the host notifier holds the Popen handle. POST /api/runs/{run_id}/stop records the intent
-- HERE; the signal then rides the EXISTING per-tick wake-renew response (zero new poll); the
-- daemon reaps the run via the SAME graceful teardown the stall/hard-cap watchdog already uses
-- (SIGTERM -> grace -> SIGKILL, dirty worktree PRESERVED, lease released). A mid-turn resident
-- aborts the TURN but keeps its conversation active so a human can redirect it.
--   stop_requested_at  — when the stop was requested (NULL = never stopped).
--   stop_requested_by  — the requesting human's agent_id (TEXT; surfaced as an alias on renew).
-- ADD-only + nullable: pre-existing rows and runs that are never stopped keep NULL. Applied to a
-- LIVE db by the R1 runner on portal boot — existing rows survive (no wipe).
--
-- NOTE (migration number): Ledger #266 (auto-awake-at-frequency) ALSO drafts a `017` on
-- overnight_612. Whoever lands SECOND renumbers their file to the next free int (018) — this
-- migration is self-contained (two ADD COLUMN IF NOT EXISTS), so a rename is a one-file edit.
ALTER TABLE worker_runs ADD COLUMN IF NOT EXISTS stop_requested_at TIMESTAMPTZ;
ALTER TABLE worker_runs ADD COLUMN IF NOT EXISTS stop_requested_by TEXT;
