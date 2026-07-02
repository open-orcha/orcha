-- Issue #103: portal-visible notifier health + one-click restart.
-- The notifier is a HOST daemon (orcha-cli/notifier.py); the portal runs in a container and
-- cannot see or signal it. Flipping the top-bar switch to Running only sets containers.wakes_enabled
-- — it does NOT prove a daemon is polling. Result: a silent "wakes on but nothing waking agents"
-- failure. This table is the shared channel the daemon writes and the portal reads.
--
-- One row per container (the daemon is a per-container singleton). The daemon UPSERTs a heartbeat
-- each loop; the portal derives running/stale/offline from last_seen_at age. A human's "Restart
-- notifier" click records restart_requested_at (intent only — the API can't signal host PIDs, same
-- pattern as WorkerRunStop/#240); a LIVE daemon reads it back on its next heartbeat and re-execs,
-- then a fresh heartbeat whose started_at post-dates the request clears it (restart_acked_at).

CREATE TABLE IF NOT EXISTS notifier_health (
    container_id          UUID PRIMARY KEY REFERENCES containers(id) ON DELETE CASCADE,
    pid                   INTEGER,                            -- host PID of the daemon (diagnostic)
    host_cwd              TEXT,                               -- project dir the daemon runs from
    version               TEXT,                               -- orcha-cli version (staleness after `orcha update`)
    started_at            TIMESTAMPTZ,                        -- daemon boot time (self-reported); restart-ack anchor
    last_seen_at          TIMESTAMPTZ NOT NULL DEFAULT now(), -- last heartbeat; drives running/stale/offline
    last_error            TEXT,                               -- last tick error, if any (surfaced in the portal)
    state                 TEXT NOT NULL DEFAULT 'running',    -- running | stopped (graceful-shutdown marker)
    restart_requested_at  TIMESTAMPTZ,                        -- human clicked "Restart notifier"
    restart_requested_by  UUID,                               -- the acting human agent (audit)
    restart_acked_at      TIMESTAMPTZ                         -- a post-request restart was observed
);
