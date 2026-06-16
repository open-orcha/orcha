-- #294 (SETTINGS epic, Item 1): per-container encrypted Anthropic API key.
-- The universal LLM client (#290) currently needs ORCHA_LLM_API_KEY exported in the host/portal
-- environment. This stores a per-container key in the DB so an operator can configure it from the
-- SETTINGS UI instead. Three ADD-only nullable columns on `containers`:
--   * llm_api_key_enc    — the key SEALED by secret_box (authenticated encryption, "v1:<base64>").
--                          NEVER the plaintext; the row alone is not a usable credential (the master
--                          key lives in ORCHA_SECRET_KEY, off-row). NULL = no key stored.
--   * llm_api_key_hint   — last 4 chars of the plaintext, for the masked "sk-...1234" display in
--                          GET .../settings/llm-key. Cheap to store, never reversible to the key.
--   * llm_api_key_set_at — when it was last stored, for the SETTINGS "configured on" banner.
-- The READ PATH (env override > this stored key > none) lives in secret_box.resolve_llm_key; the
-- triage call-site wiring is downstream (#288/#290) and deliberately NOT in this change.
-- ADD-only + nullable: every existing container keeps NULL (zero behaviour change). Applied on
-- portal boot by the R1 migration runner (no wipe).
ALTER TABLE containers ADD COLUMN IF NOT EXISTS llm_api_key_enc    TEXT;
ALTER TABLE containers ADD COLUMN IF NOT EXISTS llm_api_key_hint   TEXT;
ALTER TABLE containers ADD COLUMN IF NOT EXISTS llm_api_key_set_at TIMESTAMPTZ;
