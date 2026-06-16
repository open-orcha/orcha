-- E1: embodiment lease kind. The single-flight wake lease (agent_wake_state.wake_lease_until)
-- now also records WHICH embodiment holds it: 'ephemeral' (a one-shot headless wake worker) or
-- 'resident' (a live conversation session — the resident-worker model, E3/E4). This enforces the
-- ONE-embodiment-per-agent invariant via the existing single-flight lease: a live resident lease
-- blocks ephemeral headless spawns (wake-scan sees the lease and suppresses should_wake), and a
-- live ephemeral lease blocks a resident claim — handoff is graceful-release-then-claim (E3).
-- NULL when no lease is held (no embodiment). Applied by the R1 runner to a LIVE DB; 001–008 untouched.
ALTER TABLE agent_wake_state ADD COLUMN IF NOT EXISTS lease_kind TEXT;
