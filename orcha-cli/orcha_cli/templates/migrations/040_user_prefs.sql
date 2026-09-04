-- 040_user_prefs.sql — per-USER cosmetic preferences, keyed by GitHub identity.
--   user_prefs.github_login — the proxy-verified login, stored LOWERCASED (the
--     app lowercases before every read/write; GitHub logins are case-insensitive).
--   user_prefs.prefs — a small whitelisted JSONB bag (theme / skin / sidebar /
--     default_cid — see portal_backend/user_pref_routes.ALLOWED_PREF_KEYS).
--     COSMETIC ONLY by construction: nothing server-side ever reads this table
--     to make a decision — it exists purely so a signed-in user's appearance
--     follows them across browsers/devices. Never authorization state.
--   Identity-level, not container-level: no container_id column on purpose —
--     one row per GitHub account, whatever projects it belongs to.
-- ADD-only + tolerant re-apply; applied on portal boot by the R1 migration runner.

CREATE TABLE IF NOT EXISTS user_prefs (
    github_login TEXT PRIMARY KEY,
    prefs        JSONB NOT NULL DEFAULT '{}',
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
