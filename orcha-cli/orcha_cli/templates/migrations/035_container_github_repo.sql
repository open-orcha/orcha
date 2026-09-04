-- GitHub dashboard: the GitHub repository (owner/name) a container is bound to via the
-- portal's Connect-repo modal. Plain owner/name text — shape is validated at the API edge
-- (PUT /api/containers/{cid}/github); NULL = unbound. ADD-only; applied on portal boot by
-- the R1 migration runner.
ALTER TABLE containers ADD COLUMN IF NOT EXISTS github_repo TEXT;
