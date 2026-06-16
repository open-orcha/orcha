-- ISS-69(b): terminal-preempts-an-idle-resident handoff. A human opening a live terminal
-- (&preempt=1) while the agent holds an IDLE warm RESIDENT lease should make that resident
-- YIELD — snapshot-on-yield (#145) → release the single-flight lease → the terminal claims 'live'.
-- The resident process + snapshot seam live in the host daemon (notifier.service_residents), NOT
-- the bridge, so the bridge cannot reach them directly. Instead wake-claim records a YIELD REQUEST
-- on the held row; the daemon reads it back on its per-tick wake-renew heartbeat and, only if the
-- resident is idle (not mid-turn), closes it gracefully + releases the lease. The bridge retries.
--   preempt_requested_at — when a live-terminal claim asked the current holder to yield (NULL = none).
--   preempt_for          — the lease_kind that requested the yield (e.g. 'live'); audit/diagnostic.
-- Both are CLEARED on a fresh claim and on lease release, so a stale flag can never linger.
-- Applied by the R1 runner to a LIVE DB; 001–010 untouched. Idempotent.
ALTER TABLE agent_wake_state ADD COLUMN IF NOT EXISTS preempt_requested_at TIMESTAMPTZ;
ALTER TABLE agent_wake_state ADD COLUMN IF NOT EXISTS preempt_for          TEXT;
