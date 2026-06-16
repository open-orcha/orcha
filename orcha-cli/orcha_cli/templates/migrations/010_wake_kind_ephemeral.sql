-- Terminology fix: the stored wake_kind/transport VALUE 'headless' is renamed to 'ephemeral'.
-- A RESIDENT conversation session is ALSO headless (`claude -p`, no tty), so 'headless | resident'
-- was the wrong axis — the real distinction is ephemeral | resident (matching agent_wake_state.
-- lease_kind from migration 009). Code now writes 'ephemeral' for one-shot wakes; this backfills
-- existing rows so old and new agree. 'tmux' and 'resident' are unchanged. Idempotent.
UPDATE worker_runs        SET wake_kind      = 'ephemeral' WHERE wake_kind      = 'headless';
UPDATE agent_wake_state   SET last_wake_kind = 'ephemeral' WHERE last_wake_kind = 'headless';
