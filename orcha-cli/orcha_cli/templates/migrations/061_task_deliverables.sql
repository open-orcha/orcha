-- 061_task_deliverables.sql
--
-- Non-code deliverables: a task can produce files (markdown / text / CSV / JSON /
-- PDF / images) that are not code changes — a report, a spreadsheet export, a
-- research memo. They reach Orcha two ways:
--   * run_output — the notifier collects what the agent wrote to its run's
--                  outputs folder (<cwd>/.orcha/outputs/) and uploads each file
--                  with the run_id that produced it;
--   * attached   — a human (or an agent via the API) attaches a file directly.
--
-- A deliverable is keyed by its logical path within the task (e.g. "report.md",
-- "data/q3.csv"). A later upload of the same path appends a VERSION (only when
-- the bytes changed — identical content is deduplicated by sha256), so the
-- verification gate can show a text diff between versions.
--
-- Bytes live on disk under the attachment store (<attachments>/deliverables/...),
-- never as DB blobs; rows carry only metadata. ADD-only: new tables, no rewrite.

CREATE TABLE IF NOT EXISTS task_deliverables (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    container_id    UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    task_id         UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    path            TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 255),
    kind            TEXT NOT NULL,
    latest_version  INTEGER NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (task_id, path)
);
CREATE INDEX IF NOT EXISTS idx_task_deliverables_task
    ON task_deliverables (task_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS task_deliverable_versions (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deliverable_id   UUID NOT NULL REFERENCES task_deliverables(id) ON DELETE CASCADE,
    version          INTEGER NOT NULL CHECK (version >= 1),
    source           TEXT NOT NULL CHECK (source IN ('run_output', 'attached')),
    run_id           UUID REFERENCES worker_runs(run_id) ON DELETE SET NULL,
    author_agent_id  UUID REFERENCES agents(id) ON DELETE SET NULL,
    stored_name      TEXT NOT NULL,
    size_bytes       BIGINT NOT NULL CHECK (size_bytes >= 0),
    sha256           TEXT NOT NULL,
    content_type     TEXT NOT NULL,
    note             TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (deliverable_id, version)
);
CREATE INDEX IF NOT EXISTS idx_task_deliverable_versions_run
    ON task_deliverable_versions (run_id) WHERE run_id IS NOT NULL;
