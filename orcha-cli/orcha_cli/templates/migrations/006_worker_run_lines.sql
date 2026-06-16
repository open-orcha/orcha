-- ISS-39: stream a worker's stream-json lines through the DB instead of tailing the
-- bind-mounted per-wake log from the portal. The daemon (host-side, zero mount lag) reads
-- its own log and POSTs new lines here; the SSE /stream endpoint tails THIS table, so the
-- live feed no longer depends on the portal seeing host appends through the macOS Docker
-- VirtioFS attribute cache (which lags 1-5s and dropped lines mid-window). Applied on portal
-- boot by the R1 runner (no wipe). ON DELETE CASCADE so lines vanish with their run.
CREATE TABLE IF NOT EXISTS worker_run_lines (
    run_id  uuid        NOT NULL REFERENCES worker_runs(run_id) ON DELETE CASCADE,
    seq     integer     NOT NULL,
    line    text        NOT NULL,
    ts      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, seq)
);
-- The PK (run_id, seq) already covers the SSE tail probe:
--   SELECT seq, line FROM worker_run_lines WHERE run_id=%s AND seq>%s ORDER BY seq.
