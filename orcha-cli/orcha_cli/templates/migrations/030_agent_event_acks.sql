-- GH #58: per-(agent, event) handled-set so an ALREADY-AWAKE run drains every notification it
-- CAN handle in one pass — acking each by id — instead of one fresh wake per notification.
--
-- Before this, the wake cursor was a single high-water mark (agent_wake_state.delivered_ts): a
-- wake acked the cursor forward past EVERY event below the mark, so the only safe way to avoid
-- mis-acking a notification a run could NOT handle (one bound to a DIFFERENT task than the run is
-- carrying) was to wake one run per notification and ack exactly one. That is the #58 waste: a
-- fresh model load + context rehydrate + protocol injection per event.
--
-- The fix is a per-event ack: each (agent_id, event_id) the run actually handles is recorded here,
-- so the drain can mark several handled in one pass while LEAVING a cross-task / fresh-protocol
-- event UNACKED for the next ephemeral. delivered_ts stops being the source of truth and becomes a
-- CONTIGUOUS FLOOR the server recomputes from this table (the ts just below the OLDEST still-unhandled
-- waking event) — so an unhandled event sitting BELOW the high-water mark still re-surfaces rather
-- than being skipped (the cursor-hole the old GREATEST(max_ts) jump had).
--
-- Migration number: 030 (029 = close_accepted_requests, PARKED .pending — untouched here). Pure
-- ADDITIVE: a new table, no backfill, no change to any existing row. Applied on portal boot by the
-- R1 migration runner. Reversibility: dropping this table reverts to the delivered_ts-only cursor.
CREATE TABLE IF NOT EXISTS agent_event_acks (
    agent_id    UUID        NOT NULL REFERENCES agents(id)       ON DELETE CASCADE,
    event_id    BIGINT      NOT NULL REFERENCES agent_events(id) ON DELETE CASCADE,
    handled_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (agent_id, event_id)
);

-- The hot read is the wake-scan's "is THIS pending event already handled by THIS agent?" anti-join
-- and the contiguous-floor recompute (both keyed agent_id -> event_id); the PK index already serves
-- agent_id-leading lookups. A reverse index on event_id keeps the ON DELETE CASCADE from an
-- agent_events purge cheap.
CREATE INDEX IF NOT EXISTS idx_agent_event_acks_event ON agent_event_acks (event_id);
