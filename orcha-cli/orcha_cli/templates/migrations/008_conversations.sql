-- E3 persistence half / V1 prereq: the human<->agent conversation thread STORE.
-- A resident-session agent (spec docs/orcha-conversation-model.md §4) reads human turns
-- and posts ONE agent turn per stream-json 'result' event (E2 spike findings). FINAL
-- turns live here; the live token stream stays in worker_run_lines (ISS-39) referenced
-- by conversation_turns.run_id (one worker_run per turn). Applied by the R1 runner to a
-- LIVE DB (no wipe); 001-007 untouched.

CREATE TABLE IF NOT EXISTS conversations (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    container_id  UUID NOT NULL REFERENCES containers(id),
    agent_id      UUID NOT NULL REFERENCES agents(id),   -- the agent being conversed with
    started_by    UUID NOT NULL REFERENCES agents(id),   -- the human who opened it
    status        TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'idle', 'ended')),
    session_id    UUID,                                  -- the claude --session-id (pin/resume the resident)
    title         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_turn_at  TIMESTAMPTZ,
    ended_at      TIMESTAMPTZ
);

-- At most ONE active conversation per agent — the ONE-embodiment invariant (spec §3):
-- ephemeral and resident are mutually-exclusive modes of the same single agent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_one_active
    ON conversations (agent_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS conversation_turns (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    seq             BIGINT NOT NULL,                       -- per-conversation, server-assigned, monotonic
    role            TEXT NOT NULL CHECK (role IN ('human', 'agent')),
    author_agent_id UUID NOT NULL REFERENCES agents(id),   -- the human, or the AI agent
    content         TEXT NOT NULL,
    -- One worker_run per agent turn (per-turn run_id): the turn's live token stream is
    -- exactly that run's worker_run_lines (ISS-39). NULL for human turns.
    run_id          UUID REFERENCES worker_runs(run_id) ON DELETE SET NULL,
    meta            JSONB NOT NULL DEFAULT '{}'::jsonb,     -- light annotations (subtype, num_turns, E4 meta.type)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (conversation_id, seq)
);

-- Ordered replay for history injection (V1) + the portal panel.
CREATE INDEX IF NOT EXISTS idx_turns_conversation_seq ON conversation_turns (conversation_id, seq);
