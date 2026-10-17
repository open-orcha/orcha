-- PROOF-OF-WORK EVIDENCE PACKS + VERDIKT HANDOFF (migration 058).
--
-- Semantics (portal_backend/evidence_pack.py and portal_backend/verdikt_integration.py are
-- the single source of truth):
--   * task_evidence_packs: ONE current evidence pack per task, built from what the task's own
--     runs recorded when it reaches needs_verification (tests that ran + their parsed counts,
--     the changed files + risk flags, the DoD checklist). `basis` is a signature of the inputs
--     (task status/DoD/result + the round's run ids/statuses); a read whose basis differs
--     rebuilds the pack, so a run that finishes after /done (the usual case: the agent calls
--     /done mid-run, the diff is captured at reap) is picked up. The pack is evidence for a
--     human; it never changes task status.
--   * container_verdikt_settings: per-project Verdikt connection (base URL, Verdikt project
--     slug, what to test and when). Owner-managed.
--   * verdikt_runs: every Verdikt handoff for a task (manual or automatic), with the Verdikt
--     request/run ids, per-criterion verdicts, screenshot/recording/report links and honest
--     failure states (unavailable / failed / timeout). A Verdikt verdict never verifies a task:
--     the human still decides.
--
-- ADD-only: three new tables, no change to existing ones. Idempotent.

CREATE TABLE IF NOT EXISTS task_evidence_packs (
    task_id       UUID PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    container_id  UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    basis         TEXT NOT NULL,
    pack          JSONB NOT NULL,
    built_reason  TEXT NOT NULL DEFAULT 'read',
    built_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_evidence_packs_container ON task_evidence_packs (container_id);

CREATE TABLE IF NOT EXISTS container_verdikt_settings (
    container_id     UUID PRIMARY KEY REFERENCES containers(id) ON DELETE CASCADE,
    enabled          BOOLEAN NOT NULL DEFAULT false,
    base_url         TEXT,
    verdikt_project  TEXT,
    target_kind      TEXT NOT NULL DEFAULT 'web' CHECK (target_kind IN ('web', 'ios', 'android')),
    target_locator   TEXT,
    trigger_mode     TEXT NOT NULL DEFAULT 'manual' CHECK (trigger_mode IN ('manual', 'ui_changes', 'always')),
    timeout_minutes  INT NOT NULL DEFAULT 30 CHECK (timeout_minutes BETWEEN 1 AND 240),
    updated_by       UUID REFERENCES agents(id) ON DELETE SET NULL,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS verdikt_runs (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id              UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    container_id         UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    trigger              TEXT NOT NULL CHECK (trigger IN ('manual', 'auto')),
    triggered_by         UUID REFERENCES agents(id) ON DELETE SET NULL,
    status               TEXT NOT NULL CHECK (status IN
                           ('queued', 'running', 'completed', 'failed', 'cancelled', 'timeout', 'unavailable')),
    verdict              TEXT CHECK (verdict IS NULL OR verdict IN
                           ('pass', 'fail', 'blocked', 'warning', 'unprocessable', 'running')),
    base_url             TEXT NOT NULL,
    verdikt_project_id   TEXT,
    verdikt_scenario_id  TEXT,
    verdikt_request_id   TEXT,
    verdikt_run_id       TEXT,
    target_kind          TEXT NOT NULL,
    locator              TEXT NOT NULL,
    handoff              JSONB NOT NULL DEFAULT '{}'::jsonb,
    criteria             JSONB NOT NULL DEFAULT '[]'::jsonb,
    screenshots          JSONB NOT NULL DEFAULT '[]'::jsonb,
    reason               TEXT,
    report_url           TEXT,
    video_url            TEXT,
    error                TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_polled_at       TIMESTAMPTZ,
    finished_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_verdikt_runs_task ON verdikt_runs (task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_verdikt_runs_open ON verdikt_runs (status) WHERE status IN ('queued', 'running');
