-- Identify the unregistered launch independently of the worker it replaces.
ALTER TABLE agent_wake_state ADD COLUMN wake_claim_id TEXT;
ALTER TABLE agent_wake_state ADD COLUMN conv_claim_id TEXT;

INSERT OR IGNORE INTO schema_migrations (version)
VALUES ('032_wake_claim_identity.sql'), ('102_wake_claim_identity.sql');
