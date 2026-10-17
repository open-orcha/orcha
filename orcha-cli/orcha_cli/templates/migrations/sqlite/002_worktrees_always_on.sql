-- WORKTREES ALWAYS ON (SQLite twin of migration 072_worktrees_always_on.sql).
--
-- GH #288 retires the "Disable worktrees" toggle: every project is forced back to isolated
-- worktree routing. The column stays one release; nothing reads it. Idempotent.

UPDATE containers SET worktrees_disabled = 0 WHERE worktrees_disabled = 1;

-- This file's own row plus its Postgres twin's, so a fresh SQLite DB, one the runner
-- migrated, and one converted from Postgres all report the same history.
INSERT OR IGNORE INTO schema_migrations (version) VALUES ('002_worktrees_always_on.sql'), ('072_worktrees_always_on.sql');
