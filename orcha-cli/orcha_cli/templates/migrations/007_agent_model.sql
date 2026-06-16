-- D7: per-agent model. The portal create-agent surface shows a model dropdown
-- (default Opus 4.8); the read path (GET /api/containers/{cid}) exposes agent.model
-- so the redesign can render it. There is no live "list models" API from the CLI —
-- the available set is a curated static list the portal maintains; this column just
-- records the choice made at registration. Applied by the R1 runner to a LIVE DB
-- (no wipe); 001–006 untouched.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS model TEXT;

-- Backfill existing rows + set the default for new inserts to the current default
-- model (Opus 4.8). Nullable stays allowed so a future non-Claude platform can omit it.
UPDATE agents SET model = 'claude-opus-4-8' WHERE model IS NULL AND kind = 'ai';
