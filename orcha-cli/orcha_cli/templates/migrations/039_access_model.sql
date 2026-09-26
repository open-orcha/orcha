-- 039_access_model.sql — customer access model: the 'viewer' role + granular grants.
--   agents.member_role gains 'viewer' — a read-only project role: viewers can look at
--     everything a member sees but every write is refused server-side.
--   agents.grants — additive permission grants layered on top of member/viewer
--     (JSONB array of strings). Recognized grants (identity_routes.GRANTS):
--       manage_keys, manage_members, manage_repo, manage_autonomy, manage_agents,
--       assign_reviewers.
--     Owners hold every grant implicitly, so grants are meaningless on owner rows.
-- ADD-only + tolerant re-apply; applied on portal boot by the R1 migration runner.

-- Extend the role CHECK tolerantly: drop the 036 two-value constraint if present,
-- then add the three-value one (swallowing the duplicate on a re-run race).
DO $$
BEGIN
    ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_member_role_check;
    ALTER TABLE agents ADD CONSTRAINT agents_member_role_check
        CHECK (member_role IN ('owner', 'member', 'viewer'));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE agents ADD COLUMN IF NOT EXISTS grants JSONB NOT NULL DEFAULT '[]';
