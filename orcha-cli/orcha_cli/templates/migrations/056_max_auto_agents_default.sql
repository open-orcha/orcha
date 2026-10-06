-- Agent limit: raise the DEFAULT for containers.max_auto_agents from 3 to 12.
-- ADDITIVE ONLY: changes the column default, so only projects created AFTER this
-- migration start at 12. Existing rows keep whatever value they have — an owner
-- raises (or lowers) theirs from Settings → Execution (PUT /api/containers/{cid}/limits).
--
-- The limit caps live AI agents created FROM suggestions (agents.is_auto_created); see
-- portal_backend/agent_suggestion_routes.py. 3 was so low that approving a proposed agent
-- on any real team hit the cap immediately.

ALTER TABLE containers ALTER COLUMN max_auto_agents SET DEFAULT 12;
