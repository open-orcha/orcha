# Orcha Cloud: per-user Claude subscription tokens — design

**Date:** 2026-09-18 · **Tracks:** open-orcha/orcha#239 · **Scope:** hosted Orcha Cloud only.
Desktop and self-hosted stacks are untouched: they keep the host's own Claude login and the
existing daemon-env credential path.

## 1. Goal

On a hosted Orcha Cloud instance (today: orcha.quantallabs.ai), every agent wake runs on the
Claude subscription of the person who owns that work. Each member generates their own
long-lived token on their laptop and pastes it into Orcha Settings once. Orcha never uses one
member's token for another member's work. There is no shared instance token and no fallback.

Non-goals: Anthropic API keys as a per-user credential (the per-project provider-key card
already covers Orcha's own backend calls and stays as is); desktop or local changes; a
validation ping from the portal to Anthropic.

## 2. Decision record

Anthropic's Claude Code legal page states that developers "may not collect, store, or
intermediate Claude.ai credentials or session tokens" and that per-user API keys are the
sanctioned hosted path. This was raised before the design was chosen. Hussein's decision
(2026-09-18): subscription tokens only, one per user, because the product goal is that nobody
runs on anyone else's token. This doc records that the compliance risk sits with each member's
own subscription and that the Settings card tells them so in plain words.

## 3. How it works today (the seams we build on)

| Seam | Today | File |
|---|---|---|
| Worker credential | One `CLAUDE_CODE_OAUTH_TOKEN` in the daemon's environment, inherited by every spawn and forwarded into every sandbox | `orcha-cli/orcha_cli/sandbox.py` `ENV_PASSTHROUGH`; `notifier_headless.py` / `notifier_resident_spawn.py` env blocks |
| Sealed keys reach the daemon | Wake-scan already returns `triage_key_enc` / `ack_key_enc`; the daemon unseals them with `ORCHA_SECRET_KEY` | `portal_backend/wake_scan_routes.py`; `notifier_boot_context._unseal_scan_key` |
| Per-user identity | Proxy-verified GitHub login (`ORCHA_TRUST_PROXY_USER=1`, `X-Auth-Request-User`); humans are `agents` rows with `github_login` (mig 036); `user_prefs` keyed by login (mig 040) | `portal_backend/identity_routes.py` |
| Stored-secret idiom | Sealed value + last-4 hint, PUT / DELETE / masked GET, audit `log_event`, 503 without master key | `portal_backend/provider_key_routes.py`, `secret_box.py` |
| Who triggered what | `conversation_turns.author_agent_id` (human known), `requests.requester_id` (human known), `tasks.created_by_agent_id` (**NULL means "a human", which one is lost**) | `templates/migrations/001_init.sql` |
| Usage meter | `worker_runs` token columns + `GET /api/containers/{cid}/token-usage`, per agent | mig 019; `container_token_usage_routes.py` |

## 4. Design

### 4.1 Credential mode

Portal env `ORCHA_CREDENTIAL_MODE=per_user` (cloud compose only; default `daemon_env`). The
wake-scan payload gains `credential_mode`. In `per_user` mode:

- the daemon never uses an ambient `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`; it
  deletes both from the spawn env before adding the per-wake token;
- a candidate without a resolvable owner or without a stored token is **held**, never spawned.

`daemon_env` mode is byte-for-byte today's behaviour, so self-hosters see no change.

### 4.2 Storage

Migration `049_user_subscription_tokens.sql` (add-only):

```sql
CREATE TABLE IF NOT EXISTS user_subscription_tokens (
    github_login  TEXT PRIMARY KEY,          -- lowercased, proxy-verified
    token_enc     TEXT NOT NULL,             -- secret_box.seal(token)
    token_hint    TEXT NOT NULL,             -- last 4 chars only
    set_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at  TIMESTAMPTZ,
    last_error    TEXT,                      -- e.g. "auth_rejected" (never the token)
    last_error_at TIMESTAMPTZ
);
ALTER TABLE tasks       ADD COLUMN IF NOT EXISTS owner_login  TEXT;
ALTER TABLE requests    ADD COLUMN IF NOT EXISTS owner_login  TEXT;
ALTER TABLE worker_runs ADD COLUMN IF NOT EXISTS billed_login TEXT;
```

Tokens are sealed with the existing `secret_box` under `ORCHA_SECRET_KEY`, the same master
key the daemon already holds for provider keys. No table is instance-global.

### 4.3 Routes (`portal_backend/subscription_token_routes.py`)

All under the trusted lane; the login comes from the proxy header, never from the body.
Unavailable (404) unless `credential_mode == per_user`.

| Route | Behaviour |
|---|---|
| `GET /api/me/subscription-token` | `{configured, hint, set_at, last_used_at, last_error}`; never the value |
| `PUT /api/me/subscription-token` | body `{token}`; must start with `sk-ant-oat`; seals, upserts, clears `last_error`; audit `subscription_token_set {hint}`; 503 if no master key |
| `DELETE /api/me/subscription-token` | deletes the row; audit `subscription_token_removed`; wakes owned by this login are held from the next scan |
| `GET /api/me` | gains `credential_mode` and `subscription: {configured, hint, last_error}` |

A member can only ever read or write their own row. There is no admin read of values; admins
see per-login configured/hint/last_error via the existing members list.

### 4.4 Owner on every wake

`owner_login` is stamped at creation and inherited through runs, so a wake resolves its
owner in one lookup, with no chain walking:

- **Human-originated** task, request, or conversation turn: `owner_login` = the trusted proxy
  login. Task creation in the trusted lane also sets `created_by_agent_id` to the human's
  agent row (closes the "NULL = some human" gap).
- **Agent-originated** task or request (created from inside a worker, identified by
  `ORCHA_RUN_TOKEN`): `owner_login` = that run's `billed_login`.
- **Wake candidate → owner**: conversation → turn author's login; request → `requests.owner_login`;
  task assigned / created / checkpoint respawn → `tasks.owner_login`.
- **Unresolvable** (legacy rows created before this migration, or an event with no source
  row): the candidate is held with `held_reason: "no_owner"` and surfaced on the task or
  conversation as "Needs an owner". A one-time backfill sets `owner_login` on existing open
  tasks and requests to the container's creating login (from `container_lifecycle_routes`),
  so the dogfood instance does not start with everything held.

There is no fallback to another member's token in any branch.

### 4.5 Wake-scan payload and daemon

Each candidate in `per_user` mode carries:

```json
{ "...existing fields...", "owner_login": "hussein-quant",
  "subscription_token_enc": "<sealed>" }
```

or `"held_reason": "no_owner" | "no_token"` when it cannot run. The daemon:

1. unseals `subscription_token_enc` with `_unseal_scan_key` (existing helper);
2. builds the spawn env from `os.environ` minus `CLAUDE_CODE_OAUTH_TOKEN` and
   `ANTHROPIC_API_KEY`, then sets `CLAUDE_CODE_OAUTH_TOKEN` to the unsealed value and
   `ORCHA_BILLED_LOGIN` to `owner_login`;
3. reports `billed_login` on `POST /worker-runs/start` so the run row carries it.

Sandbox mode needs no change: `CLAUDE_CODE_OAUTH_TOKEN` is already in `ENV_PASSTHROUGH` and
rides the client env, never argv.

### 4.6 Auth failure handling

When a run ends with an auth rejection (Claude Code's stream-json `result` carries an
authentication error, or the process exits immediately with "Invalid API key" / 401 in the
log), the daemon posts `auth_rejected` on `/finish`. The portal sets `last_error` on the
owner's token row and adds a request to the owner: "Your Claude token was rejected. Generate a
new one and paste it in Settings." Further wakes for that login are held (`no_token`) until
the row is replaced. Rotation is therefore: paste a new token, done. Removal is immediate.

### 4.7 Settings card and nudge (cloud frontend)

`src/cloud/settings/SubscriptionTokenSection.tsx`, rendered next to the GitHub-access and
provider-key cards only when `/api/me` reports `credential_mode: per_user`:

- Title "Your Claude subscription". Plain instructions: on your own computer, run
  `claude setup-token`, approve in the browser, paste the printed value here. The value is
  stored encrypted, shown masked, and used only for work you own.
- A one-line notice that the token is tied to their personal Claude subscription and its
  limits, and that Anthropic's terms for hosted use apply to them.
- States: not configured (input + Save), configured (masked hint, set date, last used,
  Replace, Remove), error (`last_error` shown with a Replace prompt).
- "Your usage" tile: 7-day and all-time tokens and dollars from the meter filtered by
  `billed_login`.

Nudge: when `subscription.configured` is false, the conversation page and the task page show a
non-dismissible banner "Add your Claude subscription token in Settings to run agents" linking
to the card. It reuses the existing `conv-wakes` banner style.

### 4.8 Metrics

`GET /api/containers/{cid}/token-usage` gains `per_user: [{login, runs, total_tokens,
total_cost_usd}]`. The Metrics page shows it as a third breakdown next to per-agent.

### 4.9 Security properties

- Never returned raw after save; never logged: the daemon passes the token via the process
  env only, and the worker log capture records stdout, not env. The hint is the only value
  in audit events.
- Sealed at rest with `secret_box`; portal returns 503 rather than storing plaintext when
  `ORCHA_SECRET_KEY` is missing.
- Per-user isolation is structural: the login is taken from the proxy header, and the
  wake-scan attaches exactly the owner's token to each candidate.
- No cross-user fallback in any code path; unresolved wakes are held and surfaced.
- Rotation and removal are single actions with immediate effect from the next scan.

### 4.10 Box provisioning (orcha.quantallabs.ai)

Separate from the code change, the box needs a daemon to serve wakes at all (root cause of the
"No agent runtime yet" banner, 2026-09-13). Cloud workers run in the sandbox runner image,
which already installs the Claude CLI, so the host only needs Docker, `ORCHA_SECRET_KEY`,
`ORCHA_SANDBOX=1`, and a systemd unit running `orcha up` for each workspace. No credential
goes into the daemon env in `per_user` mode.

## 5. Testing

- **pytest (portal):** PUT/GET/DELETE masked round trip; wrong-prefix token rejected;
  member A cannot read B's row; 404 in `daemon_env` mode; 503 without master key;
  owner stamping for human and run-originated tasks/requests; wake-scan attaches the owner's
  sealed token and holds `no_owner` / `no_token` candidates; `auth_rejected` on finish sets
  `last_error` and files the owner request; per-user meter breakdown.
- **pytest (daemon):** spawn env in `per_user` mode contains exactly the candidate's token
  and no ambient credential; `billed_login` sent on run start; held candidates never spawn.
- **vitest:** SubscriptionTokenSection states (unset, configured, error), nudge banner
  visibility from `/api/me`, Metrics per-user breakdown.
- **Migration:** add-only, idempotent, backfill leaves closed rows alone.
- **Live check on the dogfood box:** two members with different tokens, one wake each,
  `worker_runs.billed_login` differs, meter attributes correctly.

## 6. Out of scope, deliberately

- API-key alternative in this card.
- Any change to desktop `scrubWorkerEnv` or to self-hosted credential flow.
- Team/Enterprise seat management or org-level tokens.
- Validating a token at save time by calling Anthropic from the portal.
