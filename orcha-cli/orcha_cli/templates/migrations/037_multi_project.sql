-- 037_multi_project.sql — portal multi-project (the project switcher).
--   * containers_singleton DROPPED — a stack's DB may now hold MULTIPLE containers
--     ("projects"). Every API is already cid-scoped, so isolation is unchanged; the
--     CLI's 1:1:1 init contract moves from the schema to the API layer (POST
--     /api/containers still 409s a second container unless the caller passes
--     `additional: true` — see container_lifecycle_routes.create_container).
--   * containers_name_uq — project names unique per stack (case-insensitive), so the
--     switcher menu and the reset confirm-phrase (`confirm` must equal the name) stay
--     unambiguous. Safe to add here: containers_singleton guaranteed the table holds
--     at most one row when this runs.
--   * containers.last_wake_scan_at — stamped (throttled) by GET
--     /api/containers/{cid}/wake-scan, the notifier daemon's per-tick poll. A recent
--     stamp means a HOST-SIDE daemon actually serves this container's wakes; a
--     container without one gets full portal CRUD but NO agent wakes until host-side
--     glue (`orcha init` binding / fleet provisioner) exists — the portal's honest
--     "portal-only" signal.
DROP INDEX IF EXISTS containers_singleton;
CREATE UNIQUE INDEX IF NOT EXISTS containers_name_uq ON containers (lower(name));
ALTER TABLE containers ADD COLUMN IF NOT EXISTS last_wake_scan_at TIMESTAMPTZ;
