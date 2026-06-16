CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid() (built-in on PG13+, harmless here)

-- ============ CONTAINERS ============
CREATE TABLE containers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    description     TEXT,
    status          TEXT NOT NULL DEFAULT 'active',  -- active | paused | completed | failed
    root_task_id    UUID,                            -- FK set after root task created
    -- guardrails (requirement #11, runaway control)
    max_auto_agents INT  NOT NULL DEFAULT 3,
        -- Originally "cap on agents an agent could auto-spawn." Current design has no
        -- auto-spawn (agents never create agents); this now caps total agents per
        -- container, enforced when the human accepts an agent-suggestion (Phase 3).
    max_tasks       INT  NOT NULL DEFAULT 200,
    -- execution policy (requirement #12)
    execution_mode  TEXT NOT NULL DEFAULT 'human',   -- human | agent  (who decides seq/parallel)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ
);

-- Orcha#28/#29: stack:db:container is 1:1:1 by design (see README §"How it works").
-- One Postgres per stack, one container per DB. Enforced by a partial unique index on
-- a constant expression — Postgres allows at most one row to satisfy `(true)`.
-- To "make a new container" you must `orcha down -v && orcha init` (wipes the volume).
CREATE UNIQUE INDEX containers_singleton ON containers ((true));

-- ============ AGENTS ============
CREATE TABLE agents (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    container_id     UUID NOT NULL REFERENCES containers(id),
    alias            TEXT NOT NULL,                  -- "Max", "Kedar"
    role             TEXT NOT NULL,                  -- "product/research", "architect"
    -- Orcha#30: humans and AI are both agents. `kind` distinguishes them so
    -- the API can gate authoritative endpoints (verify, decide-suggestion,
    -- pause/...) on kind='human' and the agent-loop endpoint (next) on kind='ai'.
    -- 'ai' (not 'agent') keeps the table name semantically honest — a human
    -- IS an agent too; what differs is whether the principal is an LLM or a person.
    kind             TEXT NOT NULL DEFAULT 'ai'
                       CHECK (kind IN ('ai', 'human')),
    system_prompt    TEXT,                            -- the prompt that defines this agent;
                                                      -- NULL for kind='human' (no LLM, no prompt)
    status           TEXT NOT NULL DEFAULT 'idle',
        -- idle | working | blocked | awaiting_request | awaiting_human | terminated
        -- (humans set their own status; agents are auto-derived by recompute_agent_status)
    is_auto_created  BOOLEAN NOT NULL DEFAULT false,
        -- ALWAYS false in the current design (agents never spawn agents — humans do).
        -- Kept for back-compat. Phase 3's agent-suggestion path may set this true to
        -- mean "human accepted an agent's suggestion to create this one." The human
        -- is still the actor; the column only records that another agent prompted it.
    parent_agent_id  UUID REFERENCES agents(id),
        -- The agent that *suggested* creating this one (when set). NULL = pure
        -- human-initiated. Audit trail, not lineage or control relationship.
    turn_budget      INT  NOT NULL DEFAULT 50,        -- max LLM turns before forced human review;
                                                      -- effectively ignored for kind='human'
    turns_used       INT  NOT NULL DEFAULT 0,         -- incremented each LLM call; cost guardrail
    last_heartbeat_at TIMESTAMPTZ,                   -- liveness for the portal
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    terminated_at    TIMESTAMPTZ,
    UNIQUE (container_id, alias)
);

-- Orcha#30: fast lookup for "find the human in this container to escalate to."
CREATE INDEX idx_agents_container_kind ON agents (container_id, kind);

-- ============ TASKS ============
CREATE TABLE tasks (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    container_id     UUID NOT NULL REFERENCES containers(id),
    title            TEXT NOT NULL,
    description      TEXT,
    definition_of_done TEXT NOT NULL,                -- explicit completion criteria (see §6)
    status           TEXT NOT NULL DEFAULT 'pending',
        -- pending | ready | in_progress | blocked | needs_verification | completed | cancelled
    priority         INT  NOT NULL DEFAULT 100,      -- lower = higher priority
    is_root          BOOLEAN NOT NULL DEFAULT false,
    created_by_agent_id UUID REFERENCES agents(id),  -- null = created by human
    result           JSONB,                          -- final output/artifact of the task
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at       TIMESTAMPTZ,
    completed_at     TIMESTAMPTZ
);

-- ============ TASK DAG (edges) ============
CREATE TABLE task_dependencies (
    task_id          UUID NOT NULL REFERENCES tasks(id),   -- this task ...
    depends_on_id    UUID NOT NULL REFERENCES tasks(id),   -- ... needs this one done first
    PRIMARY KEY (task_id, depends_on_id),
    CHECK (task_id <> depends_on_id)
    -- enforce acyclicity in app code on insert (reject edges that create a cycle)
);

-- ============ AGENT <-> TASK (M:N) ============
CREATE TABLE agent_tasks (
    agent_id         UUID NOT NULL REFERENCES agents(id),
    task_id          UUID NOT NULL REFERENCES tasks(id),
    assignment_status TEXT NOT NULL DEFAULT 'assigned', -- assigned | accepted | working | done
    assigned_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (agent_id, task_id)
);

-- ============ REQUESTS (agent-to-agent bus) ============
CREATE TABLE requests (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    container_id     UUID NOT NULL REFERENCES containers(id),
    type             TEXT NOT NULL,                  -- 'info' | 'task'
    requester_id     UUID NOT NULL REFERENCES agents(id),
    target_id        UUID REFERENCES agents(id),     -- null = escalated to human
    priority         INT  NOT NULL DEFAULT 100,
    status           TEXT NOT NULL DEFAULT 'open',
        -- open | accepted | rejected | answered | converted_to_task | closed
    payload          TEXT NOT NULL,                  -- the question / the task ask
    response         TEXT,                            -- the answer (info) or accept note
    rejection_reason TEXT,                            -- why a task request was refused
    spawned_task_id  UUID REFERENCES tasks(id),      -- if converted_to_task
    expires_at       TIMESTAMPTZ,                     -- if still 'open' past this, auto-escalate to human (deadlock guard)
    -- ============ REQUEST CHAINS (Orcha#1) ============
    parent_request_id UUID REFERENCES requests(id),  -- if set, this request was made in service of answering parent_request_id
                                                      -- (i.e. the requester is also the target of parent_request_id and needs THIS request's answer to make progress on it)
                                                      -- NULL = top-level / standalone request; immutable after insert.
    chain_depth      INT  NOT NULL DEFAULT 0,         -- 0 for root; parent.chain_depth + 1 otherwise. Exposed for visibility into runaway chains; not enforced.
    -- ============ STRUCTURED ESCALATION (Orcha#5, Phase 3) ============
    detail           JSONB,                            -- structured payload for non-text request data:
                                                       --   - task requests: {title, definition_of_done, priority}
                                                       --   - agent-suggestion escalations: {proposed_alias, proposed_role,
                                                       --     proposed_prompt, rationale} + optional human_decision
                                                       --     {kind:create|reassign|refuse, target_alias?, reason?}
                                                       -- NULL for plain info requests.
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    responded_at     TIMESTAMPTZ,
    closed_at        TIMESTAMPTZ,
    CHECK (id <> parent_request_id)                   -- trivial self-loop guard
);

-- ============ TASK COLLABORATION THREAD ============
-- when multiple agents work one task together, they post here (append-only)
-- this avoids two agents overwriting tasks.result and losing each other's work
CREATE TABLE task_messages (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id     UUID NOT NULL REFERENCES tasks(id),
    author_id   UUID REFERENCES agents(id),          -- null = human comment
    body        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ AUDIT LOG (append-only, requirement #13) ============
CREATE TABLE events (
    id          BIGSERIAL PRIMARY KEY,
    container_id UUID NOT NULL REFERENCES containers(id),
    actor_type  TEXT NOT NULL,                       -- 'agent' | 'human' | 'system'
    actor_id    UUID,                                -- agent id or null
    entity_type TEXT NOT NULL,                       -- 'task' | 'request' | 'agent' | 'container'
    entity_id   UUID,
    event_type  TEXT NOT NULL,                       -- 'created' | 'status_changed' | 'answered' ...
    detail      JSONB,                               -- full before/after snapshot
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- helpful indexes for the polling queries
CREATE INDEX idx_requests_target_open    ON requests (target_id, status, priority);
CREATE INDEX idx_requests_requester      ON requests (requester_id, status);          -- outbox / "my asks"
CREATE INDEX idx_requests_parent         ON requests (parent_request_id);              -- chain walks
CREATE INDEX idx_agent_tasks_agent       ON agent_tasks (agent_id, assignment_status);
CREATE INDEX idx_tasks_container_status  ON tasks (container_id, status, priority);

-- ============ AGENT EVENTS (Orcha#25 — durable event bus) ============
-- The event bus was an in-process ring buffer (_event_buf) in portal/main.py:
-- lost on every portal restart, so any event published while no agent held an
-- open long-poll simply vanished. This table makes the bus durable.
--
--   * _publish_event() INSERTs a row here in the SAME transaction as the
--     mutating endpoint that emits it, so an event becomes visible atomically
--     with the state change it describes (no event without its cause, and none
--     lost to a crash between the two writes).
--   * _wait_for_event() polls this table instead of memory, so events survive a
--     portal restart and a reconnecting agent replays everything it missed.
--
-- event_key is what a waiter subscribes on: the target agent's id (as text) for
-- agent-addressed events, or 'c:<container_id>' for container-wide ones. A single
-- publish to an agent inside a container writes one row per key (mirrors the old
-- two-bucket fan-out), so container SSE still observes agent-addressed events.
--
-- ts is epoch seconds (DOUBLE PRECISION) to stay byte-identical with the
-- `?since_ts=` float cursor the /wait + /events endpoints already accept: a
-- waiter returns the first row with ts > since_ts, ordered (ts, id).
CREATE TABLE agent_events (
    id            BIGSERIAL PRIMARY KEY,
    container_id  UUID REFERENCES containers(id),
    target_id     UUID REFERENCES agents(id),   -- NULL for container-wide events
    event_key     TEXT NOT NULL,                -- '<agent_id>' or 'c:<container_id>'
    event_name    TEXT NOT NULL,                -- request_created | task_verified | ...
    ts            DOUBLE PRECISION NOT NULL,    -- epoch seconds; matches ?since_ts= cursor
    payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hot path: "first event for this key newer than my cursor", ordered for replay.
CREATE INDEX idx_agent_events_key_ts ON agent_events (event_key, ts, id);

-- ============ EPIC A: WAKE & SELF-MOVEMENT ============
-- A persistent, NON-AI notifier daemon (`orcha notifier`) watches agent_events
-- (the durable bus above) and wakes idle agents out-of-band so they resume work
-- without a human nudge — the platform's #1-pain fix. Two tables support it.
--
-- agent_reachability — how to reach an agent's Claude session to wake it. 1:1
--   with an agent, volatile (the tmux pane changes every session, so it's
--   refreshed at SessionStart). A side table keeps the hot `agents` row small.
--   Wake is ON by default; wake_enabled=false is the documented opt-out.
CREATE TABLE agent_reachability (
    agent_id       UUID PRIMARY KEY REFERENCES agents(id),
    wake_enabled   BOOLEAN NOT NULL DEFAULT true,   -- ON by default; false = opt-out
    tmux_target    TEXT,        -- "session:window.pane" for live send-keys wakes
    headless_cwd   TEXT,        -- project dir for out-of-band `claude -p` wakes
    headless_flags TEXT,        -- extra flags for the headless invocation
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- agent_wake_state — the daemon's per-agent delivery cursor + last-wake audit, so
--   a restart (or the phase-0 cron stopgap, which is exactly one daemon tick)
--   never re-wakes for events already delivered, and the cooldown debounce
--   survives across process restarts.
CREATE TABLE agent_wake_state (
    agent_id        UUID PRIMARY KEY REFERENCES agents(id),
    delivered_ts    DOUBLE PRECISION NOT NULL DEFAULT 0,  -- max agent_events.ts already woken-for
    last_woken_at   TIMESTAMPTZ,                          -- cooldown debounce anchor
    last_wake_kind  TEXT,                                 -- tmux | headless | unreachable | skipped
    last_wake_event TEXT                                  -- event_name / reason of the last wake
);
-- ============ EPIC C: PER-AGENT MEMORY DIGEST (D3) ============
-- Snapshots of an agent's WORK/REASONING state so a brand-new tab re-binding the
-- same alias days later reconstructs not just task rows but the agent's decisions,
-- learnings, current focus and open threads. This is the gap the existing DB never
-- captured: reasoning lived only in the ephemeral Claude conversation and was lost
-- on tab close.
--
-- OWNERSHIP BOUNDARY (locked with Dock's D3 spec — see docs/epic-c-agent-digest-plan.md):
--   * Claude Code file-memory (MEMORY.md + typed frontmatter facts, lives OUTSIDE the
--     repo under ~/.claude/projects/.../memory) owns durable USER/PROJECT/feedback/
--     reference facts — private, local, agent-blind, human-authored. Orcha never reads
--     or writes it.
--   * THIS table owns per-AGENT work/reasoning state — shared Postgres, agent_id-keyed,
--     portal-visible, rehydratable by any re-binding tab.
--   They are PARALLEL injectors at SessionStart with non-overlapping content and NO
--   bidirectional sync (avoids drift).
--
-- The server never SYNTHESISES a digest (reasoning isn't derivable from rows): the
-- agent composes + POSTs it (on /orcha-done and on a cadence). Append-only history —
-- the latest snapshot per agent is the live view; older rows give the portal a
-- reasoning timeline and a cheap audit trail.
--
-- container_id is the Orcha "workspace" (the D1 container->workspace rename is parked;
-- this FK renames atomically with D1 later).
CREATE TABLE agent_memory_digests (
    id            BIGSERIAL PRIMARY KEY,
    container_id  UUID NOT NULL REFERENCES containers(id),
    agent_id      UUID NOT NULL REFERENCES agents(id),
    snapshot_ts   DOUBLE PRECISION NOT NULL,            -- epoch seconds; matches agent_events.ts convention
    current_focus TEXT,                                  -- one-liner: what this agent is doing right now
    decisions     JSONB NOT NULL DEFAULT '[]'::jsonb,    -- [{text, ts?}] choices made + rationale
    learnings     JSONB NOT NULL DEFAULT '[]'::jsonb,    -- [{text, ts?}] facts discovered this run
    open_threads  JSONB NOT NULL DEFAULT '[]'::jsonb,    -- [{text, ref?}] loose ends to resume
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hot path: "the latest digest for this agent" (rehydrate + portal read the newest row).
CREATE INDEX idx_digest_agent_ts ON agent_memory_digests (agent_id, snapshot_ts DESC);
