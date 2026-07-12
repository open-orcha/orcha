-- GH #144: worker-run -> task attribution was ONE-TASK-ONLY. `worker_runs.task_id` is a single
-- column, so a continuous worker session that finishes task A and then hops onto task B could be
-- attributed to only ONE task — the OTHER task's run feed (its thread narration) went silent.
-- Commit ec197e8 correctly refuses to silently MOVE a run's pin from A to B, but the single column
-- then leaves B with nothing. This join table records EVERY task a run touches, so the per-task run
-- FEED becomes many-to-many and each task a session spans narrates correctly.
--
-- The concept is SPLIT (see the plan on GH #144):
--   * `worker_runs.task_id` stays the single "current task" PIN — the GH #340 activity label and the
--     GH #126 live-run wake guard (main.py) both read it and want exactly one task. ec197e8's
--     no-overwrite guarantee (test_accept_task_does_not_overwrite_existing_run_task) is unchanged:
--     the pin never silently moves off the task the session started on.
--   * `worker_run_tasks(run_id, task_id)` is the FEED membership — one row per (run, task) the run
--     touched. The per-task run feeds read it instead of the pin.
--
-- Additive + idempotent per the 019/030 convention (CREATE TABLE / CREATE INDEX IF NOT EXISTS +
-- CREATE OR REPLACE + a re-runnable backfill): the R1 migration runner applies it on portal boot to
-- a LIVE db (no wipe), and conftest's `0*.sql` glob applies it to the test db. Ships APPLIED, not
-- `.pending` (029 is the only `.pending` — an irreversible data UPDATE; 030/019 are additive and
-- already applied to live). Because it always ships applied there is NO runtime existence-guard or
-- fallback path in the API — the table and trigger are guaranteed present.

CREATE TABLE IF NOT EXISTS worker_run_tasks (
    run_id     UUID NOT NULL REFERENCES worker_runs(run_id) ON DELETE CASCADE,
    task_id    UUID NOT NULL REFERENCES tasks(id)           ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, task_id)
);
-- The per-task run FEED reads membership by task_id (newest run first); index that lookup.
CREATE INDEX IF NOT EXISTS worker_run_tasks_task ON worker_run_tasks (task_id);

-- Keep membership in lockstep with the pin. Every place that SETS worker_runs.task_id — run-start
-- with a task, GH #83 lazy attribution at start, the /finish backstop — flows through an INSERT or
-- an UPDATE OF task_id, so a single AFTER trigger maintains the join with zero API-call-site edits
-- and covers direct SQL inserts (tests, backfills) too. The accept-task HOP is the one path the
-- trigger cannot cover: there the pin is already set to A (kept, per the no-overwrite guard) so
-- task_id never changes, and the API inserts B's membership explicitly (main.py
-- _attribute_token_run_to_task). ON CONFLICT DO NOTHING makes every path idempotent.
CREATE OR REPLACE FUNCTION sync_worker_run_task() RETURNS trigger AS $$
BEGIN
    IF NEW.task_id IS NOT NULL THEN
        INSERT INTO worker_run_tasks (run_id, task_id)
        VALUES (NEW.run_id, NEW.task_id)
        ON CONFLICT DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS worker_run_task_sync ON worker_runs;
CREATE TRIGGER worker_run_task_sync
    AFTER INSERT OR UPDATE OF task_id ON worker_runs
    FOR EACH ROW EXECUTE FUNCTION sync_worker_run_task();

-- Backfill existing attributions so already-attributed runs keep their feed after the read-site
-- switch (re-runnable: ON CONFLICT DO NOTHING).
INSERT INTO worker_run_tasks (run_id, task_id)
SELECT run_id, task_id FROM worker_runs WHERE task_id IS NOT NULL
ON CONFLICT DO NOTHING;
