-- R2.4: single-flight wake guard (applied by the R1 migration runner to a LIVE DB, no wipe).
-- Root cause of the runaway: no per-agent bound on concurrent headless workers, and no global
-- off-switch. This adds both.

-- Per-agent wake LEASE: "a worker is live for this agent until this time, don't spawn another".
-- Set (with a TTL) when the daemon claims a wake; cleared on the worker's clean exit; the TTL
-- auto-expires it on crash so the agent is never stuck unwakeable (death -> re-wake continuity).
ALTER TABLE agent_wake_state ADD COLUMN IF NOT EXISTS wake_lease_until TIMESTAMPTZ;

-- GLOBAL wake kill-switch (surgical: stops ALL wakes without pausing the whole container the way
-- /orcha-pause does). The runaway needed per-agent whack-a-mole to stop; this is one switch.
ALTER TABLE containers ADD COLUMN IF NOT EXISTS wakes_enabled BOOLEAN NOT NULL DEFAULT true;
