-- GH#89: per-agent CLOCK-WAKE snooze. A human can suppress the NEXT scheduled (auto_wake_interval)
-- wake without disabling auto-wake entirely: wake-scan skips the clock-driven term while
-- now() < snooze_until. Event-triggered wakes are unaffected (they never read this column).
-- Epoch seconds (matches agent_events.ts / delivered_ts convention). NULL = not snoozed.
-- ADD-only + nullable: existing rows keep NULL (zero behaviour change). Applied on portal boot
-- by the R1 runner (no wipe).
ALTER TABLE agent_wake_state ADD COLUMN IF NOT EXISTS snooze_until DOUBLE PRECISION;
