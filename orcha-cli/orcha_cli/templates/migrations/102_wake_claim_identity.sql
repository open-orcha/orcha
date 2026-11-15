-- Identify the unregistered launch independently of the worker it replaces.
-- Exact failure cleanup must survive a lost reply without releasing another launch.
ALTER TABLE agent_wake_state ADD COLUMN wake_claim_id TEXT;
ALTER TABLE agent_wake_state ADD COLUMN conv_claim_id TEXT;
