-- #294 (SETTINGS epic): per-container, per-use-case universal-client model selection.
-- The universal LLM client (#290) hardcodes a default model per use-case (Haiku for wake
-- triage, Sonnet for onboarding) in USE_CASE_DEFAULTS. This store lets an operator OVERRIDE
-- the model per container, per use-case, from the SETTINGS page (SPEC-SETTINGS §2/§6) so the
-- cost/quality of a backend chore (e.g. whether a wake is worth the spend) is tunable.
--
-- Shape (SPEC-SETTINGS §6 recommended keyed table — "new use-case = a row insert"):
--   (container_id, use_case_key) PK, with {provider, model} the override and set_at for audit.
-- A ROW present = that use-case is OVERRIDDEN (the page's ● "set to X"); a row ABSENT = unset
-- (the page's ○ "using shipped default"), and #290's resolve_spec falls back to USE_CASE_DEFAULTS.
-- The override is ADVISORY: the shipped default is always intact (issue Constraint), so a missing
-- store, a retired model, or any read failure degrades to the hardcoded default — never a crash.
--
-- Migration number: 022, not 021 — #298's autonomy engine (PR #317, building in parallel) has
-- already publicly claimed 021 on token_efficiency. A numbering GAP is harmless (migrations run
-- in lexical order, tracked individually in schema_migrations); a DUPLICATE 021 would collide at
-- merge. Helm can renumber at merge if #317 lands or is dropped.
--
-- New table, no change to existing rows: every container starts with zero override rows (all
-- use-cases on shipped defaults), so this is a pure additive, zero-behaviour-change migration
-- applied on portal boot by the R1 migration runner (no wipe).
CREATE TABLE IF NOT EXISTS container_model_settings (
    container_id UUID        NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    use_case_key TEXT        NOT NULL,
    provider     TEXT        NOT NULL,
    model        TEXT        NOT NULL,
    set_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (container_id, use_case_key)
);
