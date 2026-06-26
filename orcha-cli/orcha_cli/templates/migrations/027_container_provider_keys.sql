-- Per-provider universal-client API keys (multi-provider settings, follow-on to #294 Item 1).
-- Migration 020 added a SINGLE per-container key (containers.llm_api_key_enc), implicitly the
-- Anthropic key. With more than one live provider in the #290 catalog (Anthropic + xAI/Grok),
-- one key slot is not enough: a user who points a use-case at xAI has nowhere to store an xAI
-- key. This table holds one sealed key PER (container, provider) so each provider the catalog
-- offers can be configured independently from the SETTINGS page.
--
--   * key_enc   — the key SEALED by secret_box ("v1:<base64>"); NEVER plaintext. The master key
--                 lives in ORCHA_SECRET_KEY off-row, so the row alone is not a usable credential.
--   * key_hint  — last 4 chars of the plaintext, for the masked "sk-...1234" display. Not reversible.
--   * set_at    — when it was last stored, for the SETTINGS "configured on" banner.
--
-- This table is the SINGLE source of truth for ALL provider keys, Anthropic included. The legacy
-- containers.llm_api_key_enc columns (migration 020) are RETIRED: their Anthropic key is backfilled
-- into this table (provider='anthropic') below, after which every read/write goes through here. The
-- old columns are left in place (unused) for rollback safety — a later migration can drop them once
-- this has shipped. The read path resolves a provider's key from here (env override still wins, via
-- secret_box.resolve_llm_key). ADD-only; applied on portal boot by the R1 migration runner.
CREATE TABLE IF NOT EXISTS container_provider_keys (
    container_id UUID        NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    provider     TEXT        NOT NULL,
    key_enc      TEXT        NOT NULL,
    key_hint     TEXT,
    set_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (container_id, provider)
);

-- Backfill the existing per-container Anthropic key (migration 020) into the unified table so the
-- new read path is the only one needed. Idempotent: ON CONFLICT keeps an already-migrated row.
INSERT INTO container_provider_keys (container_id, provider, key_enc, key_hint, set_at)
SELECT id, 'anthropic', llm_api_key_enc, llm_api_key_hint, COALESCE(llm_api_key_set_at, now())
FROM containers
WHERE llm_api_key_enc IS NOT NULL
ON CONFLICT (container_id, provider) DO NOTHING;
