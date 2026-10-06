-- 063_notification_prefs.sql — fine-grained, SERVER-READ notification preferences.
--
-- Unlike user_prefs (mig 040, cosmetic-only by construction — nothing server-side reads
-- it), these rows ARE read on every delivery path: the bell feed
-- (agent_notification_routes), the mobile push outbox (push_outbox / push_routes claim),
-- the Slack webhook ping (slack_notify) and the desktop host's OS notifications (via
-- POST /api/containers/{cid}/notification-prefs/check). The one decision function is
-- portal_backend/notification_prefs.should_notify.
--
--   notification_pref_defaults — ONE row per person (identity-level, like user_prefs):
--     identity_key — the member's lowercased github_login, or '__local__' on a self-host
--       stack (the single-operator sentinel user_pref_routes also uses).
--     prefs        — {rules: {category: {scope, channels}}, pause, quiet_hours}.
--       pause and quiet hours live HERE only: they are about the person's time, not a
--       project.
--
--   notification_prefs — ONE row per human MEMBER per project (agents row is the member):
--     prefs — {rules: {category: …} (PARTIAL: only the categories this project
--       overrides), muted: bool}. A missing row = the project inherits the defaults.
--
-- Muting only suppresses ALERTS: the Needs-you queue is computed from live task/request
-- state (state/attention.ts, desktop attention.ts) and never reads these tables.
--
-- ADD-only; applied on portal boot by the R1 migration runner. Deleting a member (agents
-- row) or project cascades its override row away.

CREATE TABLE IF NOT EXISTS notification_pref_defaults (
    identity_key TEXT PRIMARY KEY,
    prefs        JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_prefs (
    member_agent_id UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    container_id    UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    prefs           JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Delivery paths resolve every member of one project at once (push audience, Slack gate).
CREATE INDEX IF NOT EXISTS notification_prefs_container_idx
    ON notification_prefs (container_id);
