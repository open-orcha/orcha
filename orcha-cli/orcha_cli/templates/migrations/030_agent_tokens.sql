-- Auth v1 (#271): capability tokens.
--
-- agent_tokens: one row per minted credential. The server stores ONLY the
-- sha256 hash — the plaintext is returned once at mint time and never persisted.
-- `issuer` is 'local' for v1; a future OIDC exchange mints rows with
-- issuer='oidc:<provider>' (same storage, different provenance).
--
-- agents.email: nullable; used by evidence exports and the OIDC v2 match rule.
-- events.credential_id: which credential authenticated the request that logged
-- the event (NULL for unauthenticated warn/off-mode requests and system actors)
-- — turns "claimed actor X" into "authenticated actor X via credential Y".

CREATE TABLE IF NOT EXISTS agent_tokens (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    token_hash    TEXT NOT NULL UNIQUE,
    label         TEXT NOT NULL DEFAULT '',
    issuer        TEXT NOT NULL DEFAULT 'local',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at  TIMESTAMPTZ,
    revoked_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_tokens_agent ON agent_tokens(agent_id);

ALTER TABLE agents ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS credential_id UUID;
