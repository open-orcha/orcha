-- GH #122: ephemeral task workers can schedule a one-shot wake tied to the
-- task they are actively working. One row is kept per (agent, task), so
-- rescheduling the same task replaces the wake while different blocked tasks do
-- not clobber one another.

CREATE TABLE IF NOT EXISTS agent_self_wake (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id   UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    task_id    UUID NOT NULL REFERENCES tasks(id)  ON DELETE CASCADE,
    resume_at  TIMESTAMPTZ NOT NULL,
    context    TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT agent_self_wake_context_nonempty CHECK (btrim(context) <> ''),
    UNIQUE (agent_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_self_wake_due
    ON agent_self_wake (resume_at);
