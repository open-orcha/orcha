-- Project-level worktree routing preference.
--
-- false (the default) preserves the existing isolated task/agent worktree behavior for every
-- existing and new project.  true tells every notifier and live-terminal execution lane to use
-- the project's main checkout instead.  This is deliberately ADD-only: enabling the preference
-- never removes, migrates, or otherwise mutates worktrees that already exist.
ALTER TABLE containers ADD COLUMN IF NOT EXISTS worktrees_disabled BOOLEAN NOT NULL DEFAULT false;
