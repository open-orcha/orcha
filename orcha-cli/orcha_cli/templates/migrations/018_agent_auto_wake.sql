-- #266: clock-driven AUTO-WAKE. A per-agent opt-in heartbeat cadence — wake-scan fires a
-- "scheduled" wake when now()-last_woken_at >= this interval, even with NO pending events or
-- ready tasks (a recurring poll, not event-driven). NULL = disabled (opt-in default: nothing
-- self-wakes until a human enables it via PATCH /api/agents/{aid}/auto-wake). The 60s floor
-- (CHECK) guards against a tight-loop spend footgun (>> the 15s cooldown / 30s min-idle gates).
-- Auto-wake is STRICTLY SUBORDINATE to the wakes_enabled kill-switch + lease/idle/cooldown gates
-- (all reused unchanged in wake-scan) and is additionally gated on turns_used<turn_budget, so the
-- single existing cost ceiling finally bites the one path that can runaway-spend (clock self-wakes).
-- ADD-only + nullable: existing agents keep NULL (zero behaviour change). Applied on portal boot
-- by the R1 runner (no wipe).
-- NOTE: numbered 018 per Helm's cross-PR sequencing call — Anvil's #240/#171 STOP (PR #282) lands
-- FIRST and keeps 017 (worker_runs.stop_requested_at), this auto-wake column lands SECOND as 018.
-- Self-contained (one ALTER), so the renumber was a one-file rename.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS auto_wake_interval_secs INT
    CHECK (auto_wake_interval_secs IS NULL OR auto_wake_interval_secs >= 60);
