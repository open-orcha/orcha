-- 044: Slack trigger seam — the two additive columns the Slack integration reads/writes.
-- The Slack seam only TRIGGERS and OBSERVES Orcha (slash-command start, needs_verification
-- ping); verification/merge gates stay in Orcha. Both columns are nullable, no backfill:
-- an existing stack simply has no Slack link/webhook until an owner configures one, and the
-- whole feature is OFF at the process level unless SLACK_SIGNING_SECRET + SLACK_BOT_TOKEN are
-- both set (slack_routes._slack_enabled). ADD-only; applied on portal boot by the migration
-- runner (no wipe), exactly like 035 (github_repo) and 042 (git_email).
--
--   * agents.slack_user_id — the Slack user id (e.g. "U012ABC") a HUMAN member is linked to,
--     so an inbound `/orcha ...` slash command maps the Slack caller back to a project member
--     (slack_routes maps slack_user_id -> agents row, then reuses the SAME start internals the
--     GitHub hub uses). NULL = not linked; an unlinked/unknown Slack caller gets an ephemeral
--     "link your Slack in Settings" reply and never acts. Lives on the members table (agents
--     with kind='human'), mirroring github_login (036) / git_email (042).
--
--   * containers.slack_webhook_url — a container-level Slack Incoming Webhook URL. When set,
--     the task -> needs_verification transition POSTs a compact Block Kit "Verify in Orcha"
--     message to it, non-fatally (a POST failure never breaks the transition). NULL = no
--     outbound Slack for this container (the default). Mirrors containers.github_repo (035).
ALTER TABLE agents ADD COLUMN IF NOT EXISTS slack_user_id TEXT;

ALTER TABLE containers ADD COLUMN IF NOT EXISTS slack_webhook_url TEXT;

-- One Slack account maps to at most one member per container (case-insensitive is
-- unnecessary — Slack ids are opaque, case-stable). Partial unique index so multiple rows
-- may carry NULL. Mirrors 036_collab's agents_container_github_login_uq.
CREATE UNIQUE INDEX IF NOT EXISTS agents_container_slack_user_uq
    ON agents (container_id, slack_user_id)
    WHERE slack_user_id IS NOT NULL;
