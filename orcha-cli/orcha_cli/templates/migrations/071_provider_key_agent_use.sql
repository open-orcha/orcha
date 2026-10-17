-- AGENT RUNS ON AN API KEY (migration 071).
--
-- For users with NO Claude/ChatGPT subscription: a per-project, per-provider opt-in that bills
-- every agent run to the project's stored provider key instead of the CLI's own login.
--
--   * use_for_agents — when true, the notifier daemon injects this row's key into the agent
--                      subprocess env for the matching runtime:
--                        anthropic -> Claude runtime (ANTHROPIC_API_KEY)
--                        openai    -> Codex runtime  (CODEX_API_KEY + OPENAI_API_KEY)
--                      Other providers may carry the flag but nothing reads it.
--                      Default false: subscription first, nothing injected (unchanged behaviour).
--
-- The key itself stays sealed in key_enc; it rides the daemon's wake-scan as ciphertext
-- (agent_keys_enc) and is only opened in daemon memory at spawn time. Replacing a key keeps the
-- flag; deleting the key deletes the row and with it the flag.
-- portal_backend/provider_key_routes.py is the source of truth
-- (GET .../settings/provider-keys, PUT .../settings/provider-keys/{provider}/agent-use).
--
-- ADD-only. Idempotent.

ALTER TABLE container_provider_keys
    ADD COLUMN IF NOT EXISTS use_for_agents BOOLEAN NOT NULL DEFAULT false;
