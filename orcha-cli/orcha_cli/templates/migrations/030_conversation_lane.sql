-- GH #91 + #90: split the single embodiment lease into a CONVERSATION lane and a WORK lane so a
-- resident chat and a background task worker can be live for the same agent at the same time
-- without stepping on each other, and add a per-process capability token that makes it structurally
-- impossible for the conversation lane to silently OWN task work (it can only DISPATCH a task).
--
-- Two independent lane concepts, both introduced here (see the plan on GH #91):
--   1. agent_wake_state gets a parallel CONVERSATION column-set beside the existing (now WORK-lane)
--      lease columns, so the two lanes have two slots on the one per-agent row (no PK rewrite).
--   2. worker_runs.lane tags every run so the single-flight belt, wake gates and orphan reaper can
--      be scoped per lane (a warm conversation run must not suppress / cross-orphan a work run).
--   3. embodiment_tokens is a per-PROCESS capability minted BEFORE spawn and bound to the run row;
--      the WORK-lane-only task endpoints (/next, accept->working, /tasks/{id}/done, release) require
--      a valid non-revoked WORK token, so a conversation/live-but-mislabeled process cannot claim or
--      complete a task. Dispatch endpoints (create task, create/answer/close request, post thread)
--      stay UNGATED — that is the whole point of #91/#90.
--
-- Lane VALUES are standardized to 'work' | 'conversation' across BOTH worker_runs.lane and
-- embodiment_tokens.lane (the plan's earlier rounds used 'conv' for the token table; a single
-- spelling avoids a cross-table mismatch footgun). Idempotent ADD COLUMN IF NOT EXISTS per the
-- 009/011 convention; sorts after 029; 029_*.sql.pending is excluded by the runner's 0*.sql glob.
-- Applied by the R1 runner on portal boot to a LIVE db (no wipe); 001-029 untouched.

-- ── 1. CONVERSATION-lane slot on agent_wake_state (parallel to the existing WORK-lane columns) ──
-- The existing wake_lease_until / lease_kind / preempt_* / delivered_ts / last_woken_at columns are
-- reinterpreted as the WORK lane. These conv_* columns are the CONVERSATION lane's own slot, so a
-- warm resident lease no longer occupies the one slot a work worker needs.
ALTER TABLE agent_wake_state ADD COLUMN IF NOT EXISTS conv_lease_until          TIMESTAMPTZ;
ALTER TABLE agent_wake_state ADD COLUMN IF NOT EXISTS conv_lease_kind           TEXT;
ALTER TABLE agent_wake_state ADD COLUMN IF NOT EXISTS conv_preempt_requested_at TIMESTAMPTZ;
ALTER TABLE agent_wake_state ADD COLUMN IF NOT EXISTS conv_preempt_for          TEXT;
-- Lane-scoped cursor + cooldown: a conversation ack must not advance the work cursor (event
-- swallow) nor put the work lane in cooldown (dispatch latency). Work lane keeps the existing
-- delivered_ts / last_woken_at; conversation lane uses these.
ALTER TABLE agent_wake_state ADD COLUMN IF NOT EXISTS conv_delivered_ts         DOUBLE PRECISION;
ALTER TABLE agent_wake_state ADD COLUMN IF NOT EXISTS conv_last_woken_at        TIMESTAMPTZ;
-- Lane-scoped heartbeats: a conversation renew bumps agent-wide agents.last_heartbeat_at, which
-- would keep the WORK-lane idle gate permanently non-idle. Each lane now beats its own column and
-- the wake/reaper idle gate reads the lane column, not agents.last_heartbeat_at.
ALTER TABLE agent_wake_state ADD COLUMN IF NOT EXISTS work_last_heartbeat_at    TIMESTAMPTZ;
ALTER TABLE agent_wake_state ADD COLUMN IF NOT EXISTS conv_last_heartbeat_at    TIMESTAMPTZ;

-- ── 2. worker_runs.lane — every run is tagged so the guards can be lane-scoped ──
-- add -> backfill legacy rows -> DEFAULT 'work' -> NOT NULL -> CHECK, so a missing/invalid lane is
-- impossible at the DB (the API also validates at the single insert choke point).
ALTER TABLE worker_runs ADD COLUMN IF NOT EXISTS lane TEXT;
UPDATE worker_runs
   SET lane = CASE WHEN wake_event = 'conversation_turn' THEN 'conversation' ELSE 'work' END
 WHERE lane IS NULL;
ALTER TABLE worker_runs ALTER COLUMN lane SET DEFAULT 'work';
ALTER TABLE worker_runs ALTER COLUMN lane SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'worker_runs_lane_chk') THEN
    ALTER TABLE worker_runs
      ADD CONSTRAINT worker_runs_lane_chk CHECK (lane IN ('work', 'conversation'));
  END IF;
END $$;

-- ── 3. embodiment_tokens — per-process capability minted before spawn, bound to the run row ──
-- run_token: the secret presented as X-Orcha-Run-Token on WORK-lane-only endpoints.
-- lane: capability gate ('work' may claim/work/complete tasks; 'conversation' may only dispatch).
-- kind: 'headless' | 'resident' | 'live' (informational; no CHECK).
-- run_id: bound at run-create so revocation survives daemon turnover (the server revokes on every
-- run-terminal transition — finish/orphan/sweep — even for a token this daemon never held).
CREATE TABLE IF NOT EXISTS embodiment_tokens (
    run_token   TEXT PRIMARY KEY,
    agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    lane        TEXT NOT NULL CHECK (lane IN ('work', 'conversation')),
    kind        TEXT NOT NULL,
    run_id      UUID REFERENCES worker_runs(run_id) ON DELETE CASCADE,
    pid         INTEGER,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at  TIMESTAMPTZ
);
-- Live-token lookups (verify a presented token) hit agent_id + still-valid; index the live set.
CREATE INDEX IF NOT EXISTS embodiment_tokens_agent_live
    ON embodiment_tokens (agent_id) WHERE revoked_at IS NULL;
-- Server revoke-on-terminal keys on run_id; index the unbound/live set for the terminal sweep.
CREATE INDEX IF NOT EXISTS embodiment_tokens_run_live
    ON embodiment_tokens (run_id) WHERE revoked_at IS NULL;
