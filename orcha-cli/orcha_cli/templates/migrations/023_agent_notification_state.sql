-- #247 KEYSTONE (per-agent typed notification registry): the OPERATOR read-cursor.
--
-- The #247 registry classifies the EXISTING durable bus (agent_events) into typed,
-- ranked notifications at READ time (see main.py _classify_notification) — there is NO
-- parallel notifications table, because every event already persists atomically with the
-- state change it announces (a dual-write would only re-introduce drift). The ONE thing
-- the bus lacks is per-recipient read-state, which this table supplies.
--
-- read_through_ts = the max agent_events.ts the RECIPIENT has VIEWED in their notification
-- center. A notification row is "read" iff its ts <= read_through_ts. The cursor is advanced
-- monotonically by POST /api/agents/{aid}/notifications/read (omit through_ts = "mark all
-- read"; supply it = "mark read up to here"); it never moves backward.
--
-- DELIBERATELY SEPARATE from agent_wake_state.delivered_ts: that is the notifier DAEMON's
-- wake-ack cursor (what it has already woken the agent for); THIS is the human OPERATOR's
-- view cursor. They track different concerns and must never cross-clear — draining a wake
-- must not silently mark the human feed read, and viewing the feed must not suppress a wake.
--
-- Migration number: 023 (021 = #298 autonomy_level, 022 = #294 model-settings are both on
-- token_efficiency). New table, zero rows on create, no change to any existing table → a pure
-- additive, zero-behaviour-change migration applied on portal boot by the R1 migration runner.
CREATE TABLE IF NOT EXISTS agent_notification_state (
    agent_id        UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    read_through_ts DOUBLE PRECISION NOT NULL DEFAULT 0,   -- max notif ts the recipient has viewed
    updated_at      TIMESTAMPTZ      NOT NULL DEFAULT now()
);
