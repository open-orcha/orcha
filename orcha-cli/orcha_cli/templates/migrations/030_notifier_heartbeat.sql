-- #103 (notifier health): the host-side notifier daemon's liveness beat.
--
-- Problem: the portal's Paused/Running switch only flips containers.wakes_enabled — it never
-- verifies that the host-side `orcha notifier` daemon is actually alive and polling. So the
-- portal can read "Running / wakes enabled" while no host process exists to spawn agents: a
-- silent "wakes on, no poller" failure mode. This table gives the daemon a place to report a
-- heartbeat so the portal can derive and surface notifier health (healthy | stale | offline).
--
-- Singleton per container (1:1:1 stack:db:container), keyed on container_id. The notifier
-- UPSERTs last_seen_at=now() each loop tick; the portal reads the row's age in the container
-- snapshot (GET /api/containers/{cid}) and classifies it. No parallel "status" is stored — the
-- age of last_seen_at IS the health signal, so it can never drift from reality.
--
-- Migration number: 030. New table, zero rows on create, no change to any existing table → a
-- pure additive, zero-behaviour-change migration applied on portal boot by the migration runner.
CREATE TABLE IF NOT EXISTS notifier_state (
    container_id  UUID PRIMARY KEY REFERENCES containers(id) ON DELETE CASCADE,
    last_seen_at  TIMESTAMPTZ,          -- most recent daemon heartbeat; NULL = never seen
    version       TEXT,                 -- orcha-cli version reported by the daemon
    pid           INTEGER,              -- daemon pid (host process; informational)
    last_error    TEXT,                 -- last tick error reported, else NULL
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
