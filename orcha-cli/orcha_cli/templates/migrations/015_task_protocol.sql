-- SPEC-4: per-task `protocol` — a free-text working agreement the assigned agent
-- reads on wake (review_chain, handoff_to, autonomy, notes). All four keys are
-- OPTIONAL free-text strings stored in one nullable JSONB blob; `autonomy` is FREE
-- TEXT for now and is deliberately NOT bound to an L1/L2/L3 enum (that waits on the
-- SPEC-1 autonomy design-call). NULL = no protocol set (uses container defaults).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS protocol JSONB;
