-- BRING AGENT CHANGES INTO MAIN / UPDATE FROM MAIN (migration 073).
--
-- GH #288: two new host-side worktree actions ride the existing agent_worktree_actions
-- request/claim/result loop (migration 067):
--   * bring_in          agent task worktree → the main checkout (apply as uncommitted changes,
--                       or merge the branch), rehearsed first (options.dry_run), with the
--                       human's choices in `options`: {dry_run, mode: apply|merge, stash,
--                       stash_message, allow_other_branch}
--   * update_from_main  the reverse: main's HEAD + uncommitted changes into the agent worktree
--                       ({dry_run, stash, stash_message})
-- Source of truth: portal_backend/agent_worktree_routes.py; the git work lives in
-- orcha_cli/worktree_bringin.py. ADD-only. Idempotent.

ALTER TABLE agent_worktree_actions DROP CONSTRAINT IF EXISTS agent_worktree_actions_action_check;
ALTER TABLE agent_worktree_actions ADD CONSTRAINT agent_worktree_actions_action_check
    CHECK (action IN ('remove', 'save_output', 'clean_up', 'refresh', 'bring_in', 'update_from_main'));
ALTER TABLE agent_worktree_actions ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '{}'::jsonb;
