# Auth perimeter v1 — design

**Date:** 2026-07-30
**Status:** implemented alongside this spec (PR-reviewed); v1 of Orcha Cloud sub-project 2, pulled forward
**Decision drivers:** the portal has no auth of its own; the user ruled out
Tailscale; BYOC/dogfood boxes face the public internet. An unauthenticated
public portal exposes plan approval, agent diffs, and stored provider keys —
so the perimeter is v1-critical.

## Shape

One reverse-proxy layer in front of an unchanged OSS portal:

```
                    internet
                       │ :443 (TLS via Caddy/ACME)
              ┌────────▼────────┐
              │      Caddy      │
              │  ┌───────────┐  │   Bearer lane: requests with
   browser ───┼─►│forward_auth│  │   Authorization: Bearer <ORCHA_TEAM_TOKEN>
              │  │→oauth2-proxy│ │   skip OAuth and proxy straight through
   iOS app ───┼─►│ (GitHub)   │  │   (iOS app, agent API callers)
   (bearer)   │  └───────────┘  │
              └────────┬────────┘
                       │ compose network (portal never binds a public port)
                  portal:8000
```

- **Browsers**: `forward_auth` to oauth2-proxy → GitHub OAuth → access limited
  to an explicit allowlist of GitHub usernames (`OAUTH2_PROXY_GITHUB_USERS`).
  Small-team fit: the allowlist IS the team roster; org/team-based rules are a
  later upgrade.
- **iOS app + agents**: exact-match header lane in Caddy
  (`Authorization: Bearer {$ORCHA_TEAM_TOKEN}`). One static team token per box
  in v1, rotated by editing the env + reload. The control plane later mints
  and rotates these per team.
- **Portal isolation**: a compose override rebinds the portal port to
  127.0.0.1 on the host; the proxy reaches it over the stack's compose
  network. Bootstrap docs include the firewall posture (22/80/443 only).
- **Inside the box**: agents/sandbox containers talk to `portal:8000` on the
  compose network directly — the perimeter guards the outside; in-box calls
  are unchanged (same trust domain as today's laptop).

## Non-goals (v1)

- No portal code changes; no per-user sessions inside Orcha (author
  attribution keeps using the existing agent identities).
- No per-agent token enforcement (that's the PR #105 line of work, later).
- iOS: the app must attach the bearer header — that change rides the iOS
  branch stack (small: reuse the stored pairing token as the bearer value or
  add a per-container "team token" field). Until it ships, phone supervision
  of an auth-fronted box requires the app build with the header.

## Failure modes

| Case | Behavior |
|---|---|
| No/We wrong bearer token | falls through to OAuth → 302 to GitHub sign-in (browser) / HTML for the app → effectively 401 |
| GitHub user not on allowlist | oauth2-proxy 403 page |
| oauth2-proxy down | browsers get 502 from Caddy; bearer lane keeps working (independent path) |
| Cert issuance fails | Caddy retries ACME; port 80 must stay open for HTTP-01 |
| Token leaked | rotate `ORCHA_TEAM_TOKEN` in env, `docker compose up -d` the auth stack |

## Files

- `deploy/auth/docker-compose.auth.yml` — caddy + oauth2-proxy, joins the
  orcha stack network (external), plus a portal-port override file
- `deploy/auth/Caddyfile` — TLS, bearer matcher, forward_auth wiring
- `deploy/auth/.env.example` — every knob with comments
- `deploy/README.md` — box bootstrap: Docker, orcha-cli from this repo,
  `orcha init`/`sandbox on`, auth stack up; doubles as the BYOC bootstrap
