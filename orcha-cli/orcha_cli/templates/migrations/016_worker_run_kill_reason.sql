-- #270 (residual of #251): persist a STRUCTURED kill reason on a worker run reaped as 'killed'
-- by the stall/hard-cap watchdog (reap_workers). A small JSON diagnostic — cause
-- (stalled|hard_cap), how long the log had been silent, the _worker_is_live verdict, and the
-- last stream-json event type — so a killed run on the portal/API explains WHY it was reaped
-- instead of just surfacing exit code -1. ADD-only + nullable: clean exits and pre-#270 rows
-- keep NULL. Applied on portal boot by the R1 runner (no wipe).
ALTER TABLE worker_runs ADD COLUMN IF NOT EXISTS kill_reason TEXT;
