-- B0 / G1: the shared human-decision record. ONE auditable table behind every
-- approval surface (task verify/reject, decision-checkpoint, plan/prompt approval,
-- authoritative-close), so a decision + its REASON is persisted once and routed
-- back to the agent — not just a yes/no. Applied by the R1 migration runner to a
-- LIVE DB (no wipe); 001/002 untouched.
--
-- subject_type/subject_id are intentionally generic (free text + text id) so a
-- single endpoint/contract serves every surface; B3 (requests) and B4 (verify +
-- checkpoint) reuse this without a schema change.
CREATE TABLE IF NOT EXISTS decisions (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    container_id     UUID REFERENCES containers(id),
    subject_type     TEXT NOT NULL,                       -- e.g. 'dummy','task_verify','request','checkpoint'
    subject_id       TEXT NOT NULL,                       -- the thing being decided (task/request/etc id)
    decision         TEXT NOT NULL CHECK (decision IN ('approve','reject')),
    reason           TEXT,                                -- REQUIRED on reject (API + DB enforced), optional on approve
    actor_agent_id   UUID NOT NULL REFERENCES agents(id), -- the human who decided (kind='human', enforced by the API)
    target_agent_id  UUID REFERENCES agents(id),          -- the agent that consumes {decision,reason} on next wake
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Core invariant: a reject MUST carry a non-blank reason. The API blocks this
    -- first (clear error), but the DB refuses it too so no path — backfill, a future
    -- caller, manual psql — can persist a reason-less reject. Approve may omit one.
    CONSTRAINT decisions_reject_needs_reason
        CHECK (decision <> 'reject' OR (reason IS NOT NULL AND length(btrim(reason)) > 0))
);

-- Audit lookups: "every decision on this subject" and "what was routed to this agent".
CREATE INDEX IF NOT EXISTS idx_decisions_subject ON decisions (subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_decisions_target  ON decisions (target_agent_id);
