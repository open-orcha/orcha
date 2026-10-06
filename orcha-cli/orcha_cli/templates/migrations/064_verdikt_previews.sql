-- VERDIKT PREVIEW ENVIRONMENTS (migration 064).
--
-- Verdikt only tests something already running at a target. Without this, "Run in Verdikt"
-- tested whatever happened to be at the configured URL, not the agent's change. Now a project
-- can set a PREVIEW COMMAND; a Verdikt run for a task then first asks the host notifier daemon
-- (it owns the agent worktrees on the host — the portal runs in Docker and can't run host
-- commands) to build + serve the task's worktree/branch on a free port, and hands Verdikt that
-- URL. portal_backend/verdikt_preview.py and orcha_cli/notifier_preview.py are the source of
-- truth; docs/verdikt-integration.md §7 documents it.
--
--   * container_verdikt_settings gains the preview settings (owner / manage_repo, like the rest):
--       preview_command          shell command, run by the notifier as ITS user in the task's
--                                worktree. Placeholders {port} {worktree} {branch} (the only
--                                values ever substituted — never task text). NULL = no preview:
--                                Verdikt tests the configured URL exactly as before.
--       preview_ready_path       path polled on the preview until it answers (default '/')
--       preview_timeout_seconds  how long the preview may take to answer the ready check
--       preview_ttl_minutes      the notifier stops a preview after this long no matter what
--   * verdikt_previews: one row per preview request (one per preview-backed Verdikt run):
--       requested → starting (a notifier claimed it) → ready (URL known, Verdikt handed off)
--       → stopped;  or → failed (plain reason + the last log lines).
--
-- ADD-only: nullable/defaulted columns + one new table. Idempotent.

ALTER TABLE container_verdikt_settings ADD COLUMN IF NOT EXISTS preview_command TEXT;
ALTER TABLE container_verdikt_settings ADD COLUMN IF NOT EXISTS preview_ready_path TEXT NOT NULL DEFAULT '/';
ALTER TABLE container_verdikt_settings ADD COLUMN IF NOT EXISTS preview_timeout_seconds INT NOT NULL DEFAULT 120;
ALTER TABLE container_verdikt_settings ADD COLUMN IF NOT EXISTS preview_ttl_minutes INT NOT NULL DEFAULT 60;

CREATE TABLE IF NOT EXISTS verdikt_previews (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id             UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    container_id        UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    verdikt_run_id      UUID REFERENCES verdikt_runs(id) ON DELETE CASCADE,
    status              TEXT NOT NULL CHECK (status IN ('requested', 'starting', 'ready', 'failed', 'stopped')),
    command             TEXT NOT NULL,
    ready_path          TEXT NOT NULL DEFAULT '/',
    timeout_seconds     INT NOT NULL DEFAULT 120,
    ttl_minutes         INT NOT NULL DEFAULT 60,
    worktree            TEXT,
    branch              TEXT,
    base_cwd            TEXT,
    port                INT CHECK (port IS NULL OR port BETWEEN 1024 AND 65535),
    verdikt_url         TEXT,
    error               TEXT,
    log_tail            TEXT,
    claimed_by          TEXT,
    stop_reason         TEXT,
    stop_requested_at   TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    claimed_at          TIMESTAMPTZ,
    ready_at            TIMESTAMPTZ,
    last_seen_at        TIMESTAMPTZ,
    stopped_at          TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_verdikt_previews_run ON verdikt_previews (verdikt_run_id);
CREATE INDEX IF NOT EXISTS idx_verdikt_previews_open ON verdikt_previews (container_id, status)
    WHERE status IN ('requested', 'starting', 'ready');
