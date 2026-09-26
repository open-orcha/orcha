-- HOST-side roster analysis (Orcha Cloud local run): the desktop app spawns the
-- user's local `claude` CLI to produce a RICHER project analysis than the fast
-- workspace-scan suggester (roster_suggest_routes.py / roster_signals.py) can —
-- a project summary plus recommended agents with rationale, informed by a real
-- model reading the actual codebase, not file-presence heuristics. This table is
-- where that analysis is stored so any UI (desktop Fleet step, portal onboarding)
-- can show it, independent of which process produced it.
--
-- One row per container (upsert semantics) — a fresh analysis replaces the prior
-- one wholesale; there is no history here, only "the latest analysis for this
-- project":
--   * summary      — free-text project summary (<= 4000 chars, enforced at the
--                    route layer).
--   * suggestions  — jsonb array of {alias, role, focus, is_main?, rationale?}
--                    (<= 8 entries, enforced at the route layer) — mirrors the
--                    shape roster_suggest_routes/roster_signals already produce,
--                    plus an optional rationale a model can supply that a pure
--                    heuristic scan cannot.
--   * source       — who/what produced this analysis, e.g. 'claude-local' (the
--                    host-side desktop analyzer). Free text, not an enum: new
--                    analyzers should not need a migration to identify themselves.
--   * model        — the model id used, when the source is model-backed (NULL
--                    otherwise, e.g. a future non-LLM analyzer).
--
-- ADD-only; applied on portal boot by the R1 migration runner.
CREATE TABLE IF NOT EXISTS roster_analysis (
    container_id UUID        PRIMARY KEY REFERENCES containers(id) ON DELETE CASCADE,
    summary      TEXT        NOT NULL,
    suggestions  JSONB        NOT NULL,
    source       TEXT        NOT NULL,
    model        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
