-- Per-container GitHub personal access token (Orcha Cloud local run, gap #1: GitHub
-- access without the App). Self-hosters running locally have no App installation and
-- no host-side token-refresh timer; a PAT is the lowest-precedence fallback source in
-- github_routes._read_token / _read_token_map's resolution chain — App files, where
-- present, keep winning unchanged.
--
-- Same sealed-secret shape as container_provider_keys (migration 027), one row per
-- container (a container has at most one PAT — no multi-provider concept here):
--   * token_enc — the PAT SEALED by secret_box ("v1:<base64>"); NEVER plaintext. The
--                 master key lives in ORCHA_SECRET_KEY off-row, so the row alone is not
--                 a usable credential.
--   * token_hint — last 4 chars of the plaintext, for the masked "ghp_...1234" display.
--                  Not reversible.
--   * set_at    — when it was last stored, for the SETTINGS "configured on" banner.
--
-- ADD-only; applied on portal boot by the R1 migration runner.
CREATE TABLE IF NOT EXISTS container_github_pat (
    container_id UUID        PRIMARY KEY REFERENCES containers(id) ON DELETE CASCADE,
    token_enc    TEXT        NOT NULL,
    token_hint   TEXT,
    set_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
