-- #298: the autonomy SLIDER — a per-container engine-enforced autonomy level. One column drives
-- the ONE hard, server-side gate (task completion) and is the single source of truth the engine
-- EXPOSES (get_container / snapshot / /next) so agents key their loosely-hardened gh/git behavior
-- off it (recorded in docs/orcha-project-preferences.md, read by agents — not engine checks).
--   * autonomy_level — 'plan' | 'pr' | 'full':
--       plan  (Plan-only)   -> /done stops at needs_verification (a human verifies). Agent refuses
--                              `gh pr create` until its plan is approved on the task thread.
--       pr    (Build-to-PR) -> /done stops at needs_verification. Agent may `gh pr create` but
--                              refuses `gh pr merge`.
--       full  (Full)        -> /done AUTO-COMPLETES the task (no needs_verification) via the shared
--                              _complete_and_unblock path. Agent may `gh pr merge` to the target.
-- Only the completion gate (plan|pr -> needs_verification, full -> completed) is engine-enforced;
-- the gh/git rules are agent behaviors keyed off this value, not server checks.
-- NOT NULL DEFAULT 'plan': every existing container inherits today's behavior (always stop at
-- needs_verification), so this is zero behaviour change until an operator moves the slider.
-- The CHECK refuses any value outside the enum (a free-text autonomy can never reach the hard gate).
-- ADD-only. Applied on portal boot by the R1 migration runner (no wipe).
ALTER TABLE containers ADD COLUMN IF NOT EXISTS autonomy_level TEXT NOT NULL DEFAULT 'plan'
    CHECK (autonomy_level IN ('plan', 'pr', 'full'));
