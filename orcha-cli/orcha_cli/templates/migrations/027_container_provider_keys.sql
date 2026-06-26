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
-- The Anthropic key in containers.llm_api_key_enc (migration 020) is left in place and remains
-- the source of truth for provider='anthropic' (zero change to that tested path); this table backs
-- the OTHER providers. The read path resolves a provider's key from here (env override still wins,
-- via secret_box.resolve_llm_key). ADD-only; applied on portal boot by the R1 migration runner.
CREATE TABLE IF NOT EXISTS container_provider_keys (
    container_id UUID        NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    provider     TEXT        NOT NULL,
    key_enc      TEXT        NOT NULL,
    key_hint     TEXT,
    set_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (container_id, provider)
);
