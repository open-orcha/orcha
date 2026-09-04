-- 041_push.sql — APNs push pipeline, DORMANT until credentials (docs/push-notifications.md).
-- Two tables, both written portal-side; NOTHING here holds APNs signing material —
-- boxes only record device tokens and queue events; a central relay (operated by us,
-- deploy/push-relay/) holds the .p8 key and does the actual signing + delivery.
--
--   push_devices — one row per phone that registered for remote push.
--     github_login — the proxy-verified login, stored LOWERCASED (same identity-level
--       convention as user_prefs, mig 040: the device belongs to the ACCOUNT, not to a
--       project — no container_id column on purpose).
--     apns_token   — the APNs device token (hex, as handed to the app by iOS). UNIQUE:
--       registration upserts by token and RE-OWNS the row to the current login (a
--       handed-down phone must never keep pushing to its previous owner).
--     revoked_at   — set by DELETE (own or owner) and by the forwarder when APNs
--       answers Unregistered; a revoked token is never resolved again.
--
--   push_outbox — the queue of needs-you birth events awaiting relay delivery.
--     Written AFTER-COMMIT, best-effort, by portal_backend/push_outbox.py on the three
--     needs-you transitions (task → needs_verification, opening plan message posted,
--     request opened targeting a human). Tokens are NOT snapshotted here — the claim
--     endpoint resolves the container's members' live devices at send time.
--     delivered_at / failed — terminal stamps set by the forwarder via
--       POST /api/push/outbox/mark; rows older than 48h are pruned unconditionally
--       (dormant boxes with no forwarder simply age out).
-- ADD-only + tolerant re-apply; applied on portal boot by the R1 migration runner.

CREATE TABLE IF NOT EXISTS push_devices (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    github_login TEXT NOT NULL,
    apns_token   TEXT NOT NULL UNIQUE,
    platform     TEXT NOT NULL DEFAULT 'ios',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ
);

-- The outbox claim + the enqueue seeded-check both resolve devices by login.
CREATE INDEX IF NOT EXISTS push_devices_login_idx ON push_devices (github_login);

CREATE TABLE IF NOT EXISTS push_outbox (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL,   -- 'task_verify' | 'plan_approval' | 'request'
    ref_id       UUID NOT NULL,   -- task id (verify/plan) or request id
    title        TEXT NOT NULL,
    body         TEXT NOT NULL DEFAULT '',
    delivered_at TIMESTAMPTZ,
    failed       TEXT
);

-- The forwarder's claim scans pending rows oldest-first.
CREATE INDEX IF NOT EXISTS push_outbox_pending_idx
    ON push_outbox (created_at)
    WHERE delivered_at IS NULL AND failed IS NULL;
