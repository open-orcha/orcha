-- A2 (ISS-17 follow-on): persist each headless wake worker's run so the portal (B1) can
-- render its progress. The notifier records a row on spawn (status=running) and finishes
-- it on reap (exited|killed + exit_code + the captured stream-json output). Applied to a
-- LIVE db by the R1 runner on portal boot — existing rows survive (ADD-only, no wipe).
CREATE TABLE IF NOT EXISTS worker_runs (
    run_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    task_id     UUID REFERENCES tasks(id) ON DELETE SET NULL,   -- nullable: a wake may just drain events
    wake_kind   TEXT,                                           -- headless | tmux | ...
    wake_event  TEXT,                                           -- the event/reason that triggered the wake
    status      TEXT NOT NULL DEFAULT 'running',                -- running | exited | killed
    exit_code   INT,
    log_path    TEXT,                                           -- host path of the per-wake stream-json log (A1)
    output      TEXT,                                           -- captured stream-json text (what the read endpoint returns)
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at    TIMESTAMPTZ
);

-- Read path is "this agent's runs, newest first" (B1) — index for it.
CREATE INDEX IF NOT EXISTS idx_worker_runs_agent_started ON worker_runs (agent_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_worker_runs_task ON worker_runs (task_id);
