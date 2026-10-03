-- Org chart: one reporting line per agent (AI or human) within its own project.
--
-- agents.reports_to_agent_id = the agent's MANAGER (another agent row in the SAME
-- container — enforced by the API, PUT /api/agents/{aid}/reports-to, which also refuses
-- cycles). Humans can be managers (and have managers). NULL = a root / unassigned.
-- Read by the escalation router (portal_backend/org_chart.py): an untargeted or
-- escalated ask walks the requester's manager chain to the nearest actionable human
-- before the existing fallback.
--
-- ADD-only: every existing agent keeps NULL (no reporting line); nothing is reset.
-- ON DELETE SET NULL is defensive only — agents are retired (terminated_at), never deleted.
ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS reports_to_agent_id UUID NULL
        REFERENCES agents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS agents_reports_to_idx
    ON agents (reports_to_agent_id)
    WHERE reports_to_agent_id IS NOT NULL;
