-- AGENT WORKTREE CLEAN-UP (migration 067).
--
-- The notifier creates a git worktree per wake (`orcha/wk-*`), per agent+task (`orcha/task-*`),
-- per resident conversation and per live terminal under <project>/.orcha-worktrees. They were
-- almost never removed: Embodent's own scaffolding copied into each one (runtime overlay, skills,
-- wake logs, the .orcha stack folder) made every worktree look "dirty". Worktrees live on the
-- HOST, so — like the Verdikt previews (064) — the portal records settings and requests, and
-- the host notifier (orcha_cli/notifier_worktree_gc.py + worktree_gc.py) does the git work and
-- reports back. portal_backend/agent_worktree_routes.py is the API.
--
--   * containers gains the per-project settings (owner / manage_autonomy, like the other
--     execution controls):
--       worktree_auto_cleanup   default ON (existing projects too): the notifier removes clean
--                               worktrees and, after the grace period, ones whose output it
--                               saved; unmerged commits are never removed automatically.
--       worktree_grace_days     how long a worktree with output is kept after its task is
--                               completed/cancelled (default 7, 0..90).
--   * agent_worktree_inventory: the latest inventory the host reported (one row per project).
--   * agent_worktree_actions: requests from Settings › Agent worktrees
--       requested → claimed (a notifier took it) → done | failed (with the result).
--
-- ADD-only: defaulted columns + two new tables. Idempotent.

ALTER TABLE containers ADD COLUMN IF NOT EXISTS worktree_auto_cleanup BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE containers ADD COLUMN IF NOT EXISTS worktree_grace_days INT NOT NULL DEFAULT 7;

CREATE TABLE IF NOT EXISTS agent_worktree_inventory (
    container_id   UUID PRIMARY KEY REFERENCES containers(id) ON DELETE CASCADE,
    host           TEXT,
    base_cwd       TEXT,
    items          JSONB NOT NULL DEFAULT '[]'::jsonb,
    scanned_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_worktree_actions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    container_id      UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    action            TEXT NOT NULL CHECK (action IN ('remove', 'save_output', 'clean_up', 'refresh')),
    path              TEXT,
    branch            TEXT,
    keep_branch       BOOLEAN NOT NULL DEFAULT false,
    confirm_unmerged  BOOLEAN NOT NULL DEFAULT false,
    include_output    BOOLEAN NOT NULL DEFAULT true,
    unmerged_paths    JSONB NOT NULL DEFAULT '[]'::jsonb,
    status            TEXT NOT NULL DEFAULT 'requested'
                      CHECK (status IN ('requested', 'claimed', 'done', 'failed')),
    requested_by      UUID REFERENCES agents(id) ON DELETE SET NULL,
    claimed_by        TEXT,
    result            JSONB,
    error             TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    claimed_at        TIMESTAMPTZ,
    finished_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_agent_worktree_actions_open
    ON agent_worktree_actions (container_id, created_at)
    WHERE status IN ('requested', 'claimed');
CREATE INDEX IF NOT EXISTS idx_agent_worktree_actions_recent
    ON agent_worktree_actions (container_id, created_at DESC);
