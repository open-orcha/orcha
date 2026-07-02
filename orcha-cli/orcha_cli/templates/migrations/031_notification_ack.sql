-- GH #89: per-event human acknowledge — "I've seen this, the agent must not act on it".
-- A per-ROW marker, deliberately NOT a cursor advance: acking one event must never swallow an
-- unacked neighbor, and it must veto BOTH lanes' pending queries (work delivered_ts and
-- conversation conv_delivered_ts are cursors this column never touches). Every "should the agent
-- act on this?" query adds AND human_acked_at IS NULL; max_ts/ack-through stay over ALL events so
-- cursors still advance past acked rows and they never linger uncounted.
ALTER TABLE agent_events ADD COLUMN IF NOT EXISTS human_acked_at TIMESTAMPTZ;

-- GH #89: clock-wake snooze — suppress the *scheduled* (auto_wake_interval_secs) wake until this
-- instant without disabling auto-wake permanently. TIMESTAMPTZ (not epoch DOUBLE PRECISION):
-- every comparison is against now() in SQL, same as the lease columns beside it. Only the
-- auto_wake_due term in wake_scan reads it — event wakes, ready-task wakes and owed-task-request
-- wakes fire normally during a snooze.
ALTER TABLE agent_wake_state ADD COLUMN IF NOT EXISTS snooze_until TIMESTAMPTZ;

-- No index on human_acked_at: every consuming query already narrows by
-- (event_key, ts) through the existing idx_agent_events_key_ts index, and acked rows are a tiny
-- fraction of the band that survives that range scan.
