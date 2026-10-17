-- Agent config history + rollback. ADDITIVE ONLY: one new table,
-- one index, one immutability trigger; no existing table/column is touched.
--
-- Every change to an agent's human-controlled configuration (alias, role, system_prompt,
-- model, reasoning_effort, auto_wake_interval_secs, autonomy_override) appends ONE immutable
-- row here, written by the SAME transaction as the config UPDATE
-- (portal_backend/agent_config_history_routes.record_config_change). A restore never
-- rewrites history — it re-applies an old snapshot through the normal authorized routes,
-- which append NEW rows tagged kind='restore' + restored_from.
--
-- Backfill: the per-agent 'initial' row is written lazily (first read of the history, or
-- the first recorded change — from the pre-change state) by the Python layer, so secret
-- redaction lives in exactly one place. No SQL backfill here on purpose.
--
-- Secrets: `snapshot`/`changes` only ever hold the whitelisted fields above (never keys,
-- tokens, PATs, grants); secret-looking substrings inside free text (e.g. a key pasted
-- into a prompt) are replaced before insert and listed in `redacted_fields`.

CREATE TABLE IF NOT EXISTS agent_config_revisions (
    id               BIGSERIAL PRIMARY KEY,
    agent_id         UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    container_id     UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    revision_no      INT  NOT NULL CHECK (revision_no >= 1),   -- per-agent #1..N
    kind             TEXT NOT NULL CHECK (kind IN ('initial', 'change', 'restore')),
    source           TEXT NOT NULL,          -- write path: profile | model | reasoning_effort | auto_wake | backfill
    snapshot         JSONB NOT NULL,         -- full captured config AFTER this revision
    changes          JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{field, before, after}]
    actor_agent_id   UUID NULL,              -- no FK: history must outlive/ignore roster edits
    actor_kind       TEXT NULL CHECK (actor_kind IS NULL OR actor_kind IN ('human', 'ai')),
    actor_alias      TEXT NULL,              -- alias AT THE TIME (a later rename doesn't rewrite it)
    restored_from    INT  NULL,              -- revision_no this restore re-applied
    reason           TEXT NULL,
    redacted_fields  JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (agent_id, revision_no)
);

CREATE INDEX IF NOT EXISTS agent_config_revisions_agent_idx
    ON agent_config_revisions (agent_id, revision_no DESC);

-- Immutability: a revision row can never be edited. (DELETE stays possible only through the
-- agents/containers ON DELETE CASCADE — Orcha never hard-deletes agents; retire is a flag.)
CREATE OR REPLACE FUNCTION agent_config_revisions_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'agent_config_revisions rows are immutable (history is append-only)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_config_revisions_no_update ON agent_config_revisions;
CREATE TRIGGER agent_config_revisions_no_update
    BEFORE UPDATE ON agent_config_revisions
    FOR EACH ROW EXECUTE FUNCTION agent_config_revisions_immutable();
