-- WORKTREES ALWAYS ON (SQLite twin of migration 072_worktrees_always_on.sql).
--
-- GH #288 retires the "Disable worktrees" toggle: every project is forced back to isolated
-- worktree routing. The column stays one release; nothing reads it. Idempotent.

UPDATE containers SET worktrees_disabled = 0 WHERE worktrees_disabled = 1;

INSERT OR IGNORE INTO schema_migrations (version) VALUES ('072_worktrees_always_on.sql');
