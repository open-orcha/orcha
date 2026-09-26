-- 038_device_tokens.sql — per-device bearer tokens (Orcha Cloud device auth).
-- After GitHub OAuth in the iOS app's browser sheet, the portal mints a token tied
-- to the signed-in member (/auth/device → POST /api/device-tokens). The perimeter's
-- forward_auth lane validates presented tokens via GET /api/auth/check and forwards
-- the member's github_login upstream as X-Auth-Request-User — phone requests carry
-- the same verified identity browsers get from oauth2-proxy.
--   token_hash    — sha256 hex of the raw token. The raw token is shown ONCE at mint
--                   and never stored; a DB leak leaks no usable credentials.
--   agent_id      — the human member this device acts as (attribution + revocation).
--   container_id  — the project the identity resolved in when minted (audit).
--   last_used_at  — stamped by /api/auth/check, throttled to ≥60s between writes.
--   revoked_at    — set by DELETE /api/device-tokens/{id}; a revoked token is dead.
-- ADD-only; applied on portal boot by the R1 migration runner.
CREATE TABLE IF NOT EXISTS device_tokens (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    container_id  UUID NOT NULL REFERENCES containers(id),
    agent_id      UUID NOT NULL REFERENCES agents(id),
    token_hash    TEXT NOT NULL UNIQUE,
    label         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at  TIMESTAMPTZ,
    revoked_at    TIMESTAMPTZ
);

-- The list/revoke endpoints scan by owner; the check endpoint hits token_hash's
-- unique index directly.
CREATE INDEX IF NOT EXISTS device_tokens_agent_idx ON device_tokens (agent_id);
