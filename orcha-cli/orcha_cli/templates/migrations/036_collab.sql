-- 036_collab.sql — collab v1: GitHub-identity mapping, member roles, task reviewers.
--   agents.github_login    — the VERIFIED GitHub username this human maps to (the OAuth
--                            proxy forwards it as X-Auth-Request-User; the portal binds it
--                            via /api/me). NULL for AI agents and unmapped humans.
--                            Matched case-insensitively.
--   agents.member_role     — 'owner' | 'member'. Owners invite/remove members, change
--                            roles, and assign task reviewers. Multiple owners supported.
--   tasks.reviewer_agent_id — the human an owner asked to verify this task (NULL =
--                            anyone). ADVISORY: /verify stays permissive (any human CAN
--                            verify — the existing state machine); the portal only
--                            de-emphasizes other people's review items client-side.
-- ADD-only; applied on portal boot by the R1 migration runner.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS github_login TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS member_role TEXT NOT NULL DEFAULT 'member';

-- Tolerant CHECK add — Postgres has no ADD CONSTRAINT IF NOT EXISTS, so swallow the
-- duplicate when the runner re-applies against a DB that already carries it.
DO $$
BEGIN
    ALTER TABLE agents ADD CONSTRAINT agents_member_role_check
        CHECK (member_role IN ('owner', 'member'));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- One mapped GitHub login per container, case-insensitively; unmapped rows (NULL) free.
CREATE UNIQUE INDEX IF NOT EXISTS agents_container_github_login_uq
    ON agents (container_id, lower(github_login))
    WHERE github_login IS NOT NULL;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reviewer_agent_id UUID REFERENCES agents(id);

-- Backfill: per container, the FIRST human agent (earliest created, kind='human',
-- skipping retired rows so the promoted owner is actually usable) becomes its owner —
-- existing single-human containers keep working through the new owner gates unchanged.
UPDATE agents SET member_role = 'owner'
 WHERE id IN (
     SELECT DISTINCT ON (container_id) id
       FROM agents
      WHERE kind = 'human' AND terminated_at IS NULL
      ORDER BY container_id, created_at ASC, id ASC
 )
   AND member_role <> 'owner';
