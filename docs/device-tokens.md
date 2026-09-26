# Device tokens — per-device bearer auth for the iOS app

Orcha Cloud's perimeter (see `docs/superpowers/specs/2026-07-30-auth-perimeter-design.md`)
gives browsers GitHub OAuth and API callers a bearer lane. In v1 that lane was a single
static team token: every phone shared one secret, and phone requests reached the portal
with **no identity** — attribution fell back to body params. Device tokens fix both:
each device holds its own revocable token tied to one member's verified GitHub
identity, and the perimeter forwards that identity upstream on every request.

## The pairing flow

1. The iOS app opens `https://<box>/auth/device` in an in-app browser sheet
   (`ASWebAuthenticationSession`). No bearer header → Caddy routes it through the
   browser lane → oauth2-proxy → GitHub OAuth (allowlist enforced). The proxied
   request reaches the portal carrying the trusted `X-Auth-Request-User` header.
2. The page fetches `POST /api/device-tokens` same-origin — the proxy session
   supplies the identity. The portal resolves the login to a live member
   (match-only, reusing the collab identity resolution; the founding-human
   binding rule stays `/api/me`'s job) and mints `secrets.token_urlsafe(32)`.
   Non-members get a 403 and the page explains: ask an owner to invite you.
3. Only the **sha256 hex** of the token is stored (`device_tokens.token_hash`,
   unique). The raw token exists in exactly one place: this response.
4. The page location-redirects to
   `orcha://auth/callback?host=<location.host>&token=<token>` — the app's
   registered URL scheme — and stays behind showing the token with a copy button
   as the manual fallback ("the app should have opened automatically…").
5. From then on the app sends `Authorization: Bearer <device token>` on the API
   lane.

## The perimeter's validation lane

`deploy/auth/Caddyfile` now has **two bearer lanes, order-sensitive**:

1. **Team token (break-glass)** — exact match on `Bearer {$ORCHA_TEAM_TOKEN}`
   proxies straight to the portal, no validator involved. It must stay first
   (the team token also matches the wildcard), and it keeps working even if the
   portal's validator misbehaves — that is the break-glass property. Rotation is
   unchanged: edit `.env`, `docker compose up -d`.
2. **Any other `Bearer *`** — treated as a device token:
   `forward_auth` → `GET /api/auth/check` on the portal. A valid token answers
   **202** with `X-Auth-Request-User: <github_login>`; `copy_headers` carries it
   upstream, so the portal sees the phone's requests with the same verified
   identity a browser session gets — author attribution works from the phone.
   Invalid/revoked → plain **401 body** (never the browser sign-in redirect;
   API clients need a clean status).

`GET /api/auth/check` is deliberately **not** gated on the trusted header — it is
the endpoint that *makes* that header for this lane. It matches by hash against
unrevoked rows whose member is still live, and stamps `last_used_at` (throttled
to at most one write per 60s per token, so a 3s-polling phone costs one UPDATE a
minute).

Containerized Caddy targets `portal:8000` for both `forward_auth` and
`reverse_proxy`; host-Caddy boxes (portal loopback-published, e.g. the dogfood
box) target `127.0.0.1:8001` instead.

## Managing and revoking

- `GET /api/device-tokens` — the acting identity's own live tokens
  (`id`, `label`, `created_at`, `last_used_at`).
- `DELETE /api/device-tokens/{id}` — revoke (sets `revoked_at`; idempotent —
  re-revoking answers `revoked: false`). A member may revoke **their own**
  tokens; an **owner** of the token's project may revoke **any member's**.
- Revocation is immediate: the next `/api/auth/check` for that token is a 401.
- Tokens also die with their human: removing a member (retire semantics) makes
  every token they held stop validating — no separate cleanup step.
- Lost phone, no portal access? The team token is the break-glass: it bypasses
  the validator entirely, so an operator can always get in to revoke.

## Self-hosters

Without the cloud proxy (`ORCHA_TRUST_PROXY_USER` unset) the trusted header is
inert, so mint/list/revoke all refuse — the device-token surface simply does not
exist off-cloud, same as the rest of collab's proxy identity.
