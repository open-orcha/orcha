-- BRING AGENT CHANGES INTO MAIN / UPDATE FROM MAIN (SQLite twin of 073_worktree_bring_in.sql).
--
-- SQLite cannot alter a CHECK constraint or add a column with a JSON default in place, so the
-- agent_worktree_actions table is rebuilt (same columns + `options`, same constraint names).

CREATE TABLE agent_worktree_actions__new (
    id UUID PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    container_id UUID NOT NULL,
    action TEXT NOT NULL,
    path TEXT,
    branch TEXT,
    keep_branch BOOLEAN NOT NULL DEFAULT 0,
    confirm_unmerged BOOLEAN NOT NULL DEFAULT 0,
    include_output BOOLEAN NOT NULL DEFAULT 1,
    unmerged_paths JSONB NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'requested',
    requested_by UUID,
    claimed_by TEXT,
    result JSONB,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'),
    claimed_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    options JSONB NOT NULL DEFAULT '{}',
    CONSTRAINT agent_worktree_actions_action_check CHECK ((action IN ('remove', 'save_output', 'clean_up', 'refresh', 'bring_in', 'update_from_main'))),
    CONSTRAINT agent_worktree_actions_status_check CHECK ((status IN ('requested', 'claimed', 'done', 'failed'))),
    CONSTRAINT agent_worktree_actions_container_id_fkey FOREIGN KEY (container_id) REFERENCES containers(id) ON DELETE CASCADE,
    CONSTRAINT agent_worktree_actions_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES agents(id) ON DELETE SET NULL
);

INSERT INTO agent_worktree_actions__new (id, container_id, action, path, branch, keep_branch, confirm_unmerged, include_output, unmerged_paths, status, requested_by, claimed_by, result, error, created_at, claimed_at, finished_at)
    SELECT id, container_id, action, path, branch, keep_branch, confirm_unmerged, include_output, unmerged_paths, status, requested_by, claimed_by, result, error, created_at, claimed_at, finished_at FROM agent_worktree_actions;

DROP TABLE agent_worktree_actions;

ALTER TABLE agent_worktree_actions__new RENAME TO agent_worktree_actions;

CREATE INDEX idx_agent_worktree_actions_open ON agent_worktree_actions (container_id, created_at) WHERE status IN ('requested', 'claimed');

CREATE INDEX idx_agent_worktree_actions_recent ON agent_worktree_actions (container_id, created_at DESC);

-- This file's own row plus its Postgres twin's, so a fresh SQLite DB, one the runner
-- migrated, and one converted from Postgres all report the same history.
INSERT OR IGNORE INTO schema_migrations (version) VALUES ('003_worktree_bring_in.sql'), ('073_worktree_bring_in.sql');
