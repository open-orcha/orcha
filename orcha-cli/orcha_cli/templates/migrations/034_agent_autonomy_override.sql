-- PER-AGENT AUTONOMY OVERRIDES — extend the #298 autonomy SLIDER (mig 021, containers.autonomy_level)
-- from ONE container-wide level to a per-agent grant a trusted agent can be handed WITHOUT moving the
-- whole container. The safety floor is unchanged: this only lets a container grant a single agent what
-- it could already grant EVERYONE by moving the slider. The needs_verification gate + human merge
-- authority are untouched — an override can never widen a container past what its own level allows.
--
--   * agents.autonomy_override — NULL | 'plan' | 'pr' | 'full':
--       NULL (default)   -> INHERIT the container's autonomy_level (today's behavior; zero change).
--       'plan'|'pr'|'full' -> this agent's EFFECTIVE level is the override, not the container level.
--     The effective level drives the SAME ONE engine gate as the container level (task completion in
--     task_done_routes) but per ACTING agent: an agent with override='full' auto-completes its /done
--     while a sibling at container 'plan' still parks at needs_verification. The gh/git rules agents key
--     off the effective level stay advisory (not engine checks), exactly as for the container level.
--     The CHECK refuses any value outside the enum (an unvalidated free-text override must never reach
--     the hard gate). Humans carry NO override (they never mark tasks done) — enforced at the API layer.
--
--   * containers.autonomy_enforced — BOOLEAN NOT NULL DEFAULT false:
--       false (default) -> per-agent overrides APPLY (effective = override or container level).
--       true            -> per-agent overrides are IGNORED — the container level governs EVERY agent
--                          ("override for everyone" / lock switch). Set by the human who owns the slider.
--     DEFAULT false keeps existing containers on inherit-semantics: an override, once set, applies until
--     an operator flips enforce on.
--
-- The single effective-level rule (see portal_backend/autonomy.py, the one shared helper EVERY consumer
-- routes through):  effective = container.autonomy_level  if container.autonomy_enforced
--                                else (agent.autonomy_override or container.autonomy_level)
--
-- ADD-only, both columns. Applied on portal boot by the R1 migration runner (no wipe).
ALTER TABLE agents ADD COLUMN IF NOT EXISTS autonomy_override TEXT NULL;

-- N2 (round-1 review, hardening): the enum CHECK lives in its OWN named, guarded ADD CONSTRAINT
-- rather than riding on the ADD COLUMN above. Postgres silently SKIPS an inline CHECK when
-- `ADD COLUMN IF NOT EXISTS` no-ops on a pre-existing column (e.g. a half-applied prior run),
-- which would leave the column present but UNCONSTRAINED. Adding the constraint separately —
-- guarded by a pg_constraint lookup so re-running the migration is idempotent — makes the enum
-- tooth present regardless of how the column came to exist. (The migration runner's
-- schema_migrations gate makes a half-apply unreachable via the supported path, but this is
-- defence in depth for the safety-critical enum on the completion gate.)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'agents_autonomy_override_check'
    ) THEN
        ALTER TABLE agents ADD CONSTRAINT agents_autonomy_override_check
            CHECK (autonomy_override IN ('plan', 'pr', 'full'));
    END IF;
END $$;

ALTER TABLE containers ADD COLUMN IF NOT EXISTS autonomy_enforced BOOLEAN NOT NULL DEFAULT false;
