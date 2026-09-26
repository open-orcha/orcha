-- 045: Orcha Code Space Phase 1 — line-anchored threads on code.
--
-- Design: docs/orcha-code-space-design.md ("Phase 1 — line-anchored threads").
-- Humans and agents meet ON the code: a thread anchors to (repo, ref-resolved sha, path,
-- start_line, end_line) AT CREATION TIME. Threads pin to that resolved sha forever — honesty
-- over magic (see the design doc's "outdated — pinned to <sha7>" contract, computed at read
-- time by code_space_routes against the browse module's blob-sha cache, no column needed for
-- it here). Cross-sha hunk remapping is explicitly out of scope (v1 non-goal).
--
-- One conversation, two views: tagging @agent on a thread creates a directed request through
-- the EXISTING requests/agent_events wake rails (request_creation_routes.create_request is
-- called in-process, never re-implemented) — request_id is stored here purely so a thread can
-- be traced back to the request that woke its tagged agent; the request's own lifecycle
-- (open -> answered -> closed) is independent of code_threads.status, which has its OWN
-- state machine (open -> answered -> resolved) driven by code_space_routes directly:
--   * open       — created, nobody has replied yet (or a note/no tag was set).
--   * answered   — the TAGGED agent's first reply landed (their reply also rides the normal
--                  request/respond lifecycle so the request itself flips to 'answered' too).
--   * resolved   — a human explicitly resolved it via POST .../messages {resolve:true}.
-- ADD-only; applied on portal boot by the migration runner (no wipe), exactly like 044.
CREATE TABLE IF NOT EXISTS code_threads (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    container_id        UUID NOT NULL REFERENCES containers(id),
    repo                TEXT NOT NULL,          -- "owner/name", mirrors containers.github_repo at creation time
    ref                 TEXT NOT NULL,          -- the caller-supplied ref (branch/tag/sha) the anchor was resolved FROM
    sha                 TEXT NOT NULL,          -- the resolved blob-tree commit sha the anchor is PINNED to (immutable)
    path                TEXT NOT NULL,          -- repo-relative file path
    start_line          INT  NOT NULL,
    end_line            INT  NOT NULL,
    kind                TEXT NOT NULL DEFAULT 'note'
                          CHECK (kind IN ('question', 'why', 'teach', 'note')),
        -- question templates (design doc): "How does this work?" / "Why this decision?" /
        -- "Teach me this concept" set kind accordingly; 'note' is the plain freeform default.
        -- 'teach'/'why' threads feed the Phase 4 learning library (no code here reads that yet).
    status              TEXT NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open', 'answered', 'resolved')),
    created_by_agent_id UUID NOT NULL REFERENCES agents(id),
    tagged_agent_id     UUID REFERENCES agents(id),   -- NULL = a plain note/observation, no directed request
    request_id          UUID REFERENCES requests(id), -- the directed request created when tagged_agent_id was set
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (end_line >= start_line)
);

CREATE INDEX IF NOT EXISTS code_threads_container_ref_path_idx ON code_threads (container_id, ref, path);
CREATE INDEX IF NOT EXISTS code_threads_container_status_idx ON code_threads (container_id, status);
CREATE INDEX IF NOT EXISTS code_threads_request_id_idx ON code_threads (request_id) WHERE request_id IS NOT NULL;

-- One conversation, N messages. The thread's own first message is inserted alongside the
-- thread row (creation body); every reply after that appends here. `author_agent_id` NULL +
-- `is_human` true would be a contradiction for an agent-authored row, so `is_human` is kept
-- as an explicit flag (not derived from agents.kind) so a message survives even if the
-- authoring agent row is later deleted/anonymized — mirrors task_messages' shape.
CREATE TABLE IF NOT EXISTS code_thread_messages (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id         UUID NOT NULL REFERENCES code_threads(id),
    author_agent_id   UUID REFERENCES agents(id),
    is_human          BOOLEAN NOT NULL DEFAULT false,
    body              TEXT NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS code_thread_messages_thread_id_idx ON code_thread_messages (thread_id, created_at);
