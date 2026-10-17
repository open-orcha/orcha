-- WORKTREES ALWAYS ON (migration 072).
--
-- GH #288 retires the "Disable worktrees" project toggle (migration 049). Agents always work in
-- their own worktree; the explicit "Bring changes into main" action replaces the implicit carry
-- that the toggle put on the worker-start path. The column stays one release so a downgrade
-- still reads; nothing reads it any more, and every project is forced back to isolated routing.
--
-- Source of truth for the replacement: portal_backend/agent_worktree_routes.py (bring-in actions).
-- ADD-only (data fix). Idempotent.

UPDATE containers SET worktrees_disabled = false WHERE worktrees_disabled = true;
