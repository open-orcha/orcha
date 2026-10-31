-- GH #391: an agent can save a workflow DRAFT when a person asks. The person owns the
-- workflow (owner_human_id / created_by_human_id stay a human); this column records the
-- agent that drafted it so the detail and history can say "Drafted by <agent> for <person>".
-- NULL for every workflow a person created themselves.
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS drafted_by_agent_id UUID REFERENCES agents(id);
