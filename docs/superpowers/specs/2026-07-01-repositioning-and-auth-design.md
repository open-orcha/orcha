# Repositioning Orcha as the human-oversight system of record — and Auth v1 design

**Date:** 2026-07-01
**Status:** Draft — pending human review
**Decisions taken (by Hussein):** Identity v1 = local capability tokens (OIDC as pluggable v2 issuer). Scope = additive — no cuts to desktop app, macOS widget, or resident terminal; governance tracks run alongside the existing R2 roadmap.

---

## 1. Context and goal

Orcha's strategic direction is to become **the human-oversight and audit layer for AI agent
work** — the system that proves "a verified human approved every agent change" — targeting
buyers with compliance deadlines (EU AI Act Art. 14 human oversight / Art. 12 record-keeping /
Art. 26 deployer duties, high-risk obligations binding 2026-08-02 unless the Digital Omnibus
defers them; ISO/IEC 42001; SOC 2 AI addenda). The acquirable asset is the governance layer,
not orchestration plumbing.

The blocker is authentication. Today:

- The portal binds **0.0.0.0:8000** inside the container with the API port published by
  Docker Compose; there is **no caller auth** (`main.py` ~line 1412: *"actor identity is
  100% body-supplied"*).
- Every write endpoint trusts a body field `actor_agent_id`. The human-only gates
  (`_require_kind(..., ("human",))`, `main.py` ~1408–1429) check only that the *claimed*
  UUID belongs to a `kind='human'` row — **known spoof vector #271 V2: an AI agent can
  supply any human's UUID and pass human-only gates.**

Until that is fixed, "no agent self-certifies" is a convention, not a guarantee, and none of
the audit/evidence work is credible. Auth v1 is therefore the first domino; Tracks 2–5
(evidence, attestation, policy, repositioning) layer on it.

## 2. Non-goals (v1)

- No OIDC/SSO implementation (designed-for, not built — see §3.9).
- No fine-grained permission scopes; authorization stays kind-based (human / ai / daemon)
  plus container binding.
- No TLS termination (localhost product; `--expose` documents a reverse-proxy requirement).
- No new Python dependencies. The portal keeps `fastapi, uvicorn, psycopg, python-multipart`;
  all crypto is stdlib (`hashlib`, `hmac`, `secrets`), consistent with `secret_box.py`.
- No changes to the task/request state machine.

## 3. Auth v1 — local capability tokens

### 3.1 Principals and credentials

Every actor that calls the API holds a credential:

| Principal | `agents.kind` | Credential issued at | Stored where (client side) |
|---|---|---|---|
| Human | `human` | `orcha init --as` / `/orcha-register-human` / portal | `~/.orcha/credentials/<project>.json` (0600) |
| AI agent | `ai` | `/orcha-register-agent` | `.claude/orcha-tabs/<alias>.json` (existing binding file) |
| Daemons (watch, notifier, terminal-bridge, poll pipeline) | `daemon` (new) | `orcha init` / `orcha upgrade` | `.orcha/runtime-token` (0600) |

One shared per-project **runtime token** covers all host daemons in v1 (they already run as
the host owner); per-daemon tokens are a v2 refinement.

New table (next migration in sequence, e.g. `0NN_auth.sql`):

```sql
CREATE TABLE agent_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,          -- sha256 hex of the secret; secret never stored
  label         TEXT NOT NULL DEFAULT '',      -- e.g. "init", "portal-reissue", "runtime"
  issuer        TEXT NOT NULL DEFAULT 'local', -- 'local' now; 'oidc:<provider>' in v2
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);
ALTER TABLE agents ADD COLUMN email TEXT;      -- nullable; used by evidence packs + OIDC v2
-- agents.kind CHECK constraint gains 'daemon'
```

### 3.2 Token format

`orcha_<k>_<base64url(secrets.token_bytes(32))>` where `<k>` ∈ `h|a|d` (human/ai/daemon).
The prefix makes tokens greppable by secret scanners (GitHub push protection etc.). The
server stores only the SHA-256 hash; lookup is by hash, comparison via
`hmac.compare_digest`. No JWT, no signing keys, no expiry in v1 (revocation covers it) —
deliberately boring.

### 3.3 Transport and server enforcement

- Callers send `Authorization: Bearer <token>`.
- A FastAPI dependency `require_actor(kinds=...)` replaces trust in the body field:
  resolves token → non-revoked `agent_tokens` row → `agents` row; enforces kind and
  container binding; bumps `last_used_at`.
- The existing body `actor_agent_id` is **kept** for compatibility but must **match** the
  token's agent (403 on mismatch). This closes #271 with minimal churn across the ~27
  slash-skill templates: skills add the header; bodies are unchanged.
- Browser portal: a login page accepts a pasted token and sets it in an HttpOnly,
  SameSite=Lax cookie; every portal fetch and SSE stream goes through the same dependency.
  Logout clears the cookie.
- Terminal-bridge WebSocket (localhost:8765): requires the token as the WebSocket
  subprotocol / first-message auth; unauthenticated connections are closed.

### 3.4 Enforcement modes and migration path

`.orcha/config` gains `auth_mode: off | warn | enforce`.

- **New projects** (`orcha init`): `enforce` from day one.
- **Upgraded projects** (`orcha upgrade`): start in `warn` — requests without valid tokens
  are served but logged (`events.event_type='auth_warn'`) so users can see what would
  break; the following minor release flips the default to `enforce`.
- `off` exists only as an explicit escape hatch and stamps every audit event
  `auth_mode=off` (see Track 2) so evidence packs can't silently launder unauthenticated
  history.

Bootstrap / recovery root of trust: **host filesystem access is root**. The CLI mints
tokens by writing to Postgres directly through the project's compose stack (as it already
does for migrations), so a locked-out owner recovers with `orcha token new --for <alias>`
on the host. This is honest for a local-first product and documented as such.

### 3.5 Minting flows

- `orcha init --objective ... --as <name>` → registers the human (existing behavior) +
  mints their token into `~/.orcha/credentials/<project>.json` + mints the runtime token
  into `.orcha/runtime-token`.
- `/orcha-register-agent <alias>` → API returns the agent token once; the skill writes it
  into `.claude/orcha-tabs/<alias>.json` (already the per-tty identity home).
- `/orcha-register-human` and the portal's agent page can mint additional human tokens
  (human-token-holders only).
- `orcha connect <project> --as <name>` fetches/mints for the connecting folder.
- `orcha init`/`upgrade` must ensure `.claude/orcha-tabs/`, `.orcha/runtime-token`, and
  nothing else secret-bearing are covered by the project `.gitignore` entries it manages.

### 3.6 CLI credential management

```
orcha token new --for <alias> [--label ...]   # mint (host root-of-trust or human token)
orcha token ls                                 # list: alias, label, created, last used, revoked
orcha token revoke <token-id>
orcha token rotate --for <alias>               # new token + revoke old, atomically
```

Portal shows the same list read-only in v1 (revoke button is fine to include — it's a
human-gated POST like any decision).

### 3.7 Network posture

Compose template publishes the API port as `127.0.0.1:<api_port>:8000` (host-loopback
only) instead of the current all-interfaces publish. `orcha init --expose` (or config
`expose: true`) restores LAN binding, requires `auth_mode=enforce`, and documents "put TLS
in front" as the deployment note. Desktop app, widget, and daemons are unaffected — they
already talk to localhost.

### 3.8 Audit tie-in

`log_event()` gains `credential_id` (nullable during `warn` mode). Every event then reads
"authenticated actor X **via credential Y**" rather than "claimed actor X" — the atom of
the Track-2 evidence story.

### 3.9 OIDC v2 hook (designed now, built later)

- `agent_tokens.issuer` distinguishes local vs federated credentials from day one.
- Reserved endpoint `POST /api/auth/exchange`: verified OIDC ID token → short-lived local
  token bound to a human row matched by `agents.email`. SSO becomes an *issuer*, not a
  rewrite; enterprise SSO ships without touching enforcement, storage, or skills.

### 3.10 Testing

- Spoof regression for #271: AI token + human `actor_agent_id` in body → 403 (the
  flagship test; name it after the issue).
- Token lifecycle: mint/verify/revoke/rotate; `last_used_at`; revoked → 401.
- Mode matrix: off/warn/enforce across a human gate, an agent endpoint, SSE, and the
  terminal-bridge handshake.
- `orcha upgrade` on a pre-auth volume: migration idempotent, stack comes up in `warn`,
  zero data loss.
- Follow `docs/orcha-test-runbook.md` (`.venv-test`) conventions; per-issue test files as
  with prior epics.

### 3.11 As-landed deviations (implementation, same PR)

The implementation follows this design with four deliberate deviations, recorded here so
the spec stays truthful:

1. **Daemons hold a *derived* root credential, not a DB row.** Instead of a `kind='daemon'`
   agents row (§3.1), the runtime token is `HMAC(ORCHA_SECRET_KEY, purpose)` — computed by
   the CLI (which already owns the master key in `.orcha/.env`) and verified computationally
   by the portal. No bootstrap chicken-and-egg, no daemon rows polluting agent lists/status
   logic. Rotation = rotate the master key. `agents.kind` is unchanged.
2. **Warn-mode violations log to the portal log, not the events table.** An `events` row
   per unauthenticated poll would flood the audit stream (daemons poll every 10s). `docker
   compose logs portal` shows the `orcha.auth` warnings; enforce mode is the real gate.
3. **Terminal-bridge WebSocket auth is deferred** to the immediate follow-up (§9): it needs
   a browser-side ticket flow (portal JS → bridge), which belongs with the Track 2 work.
   The bridge remains a localhost-only listener, as before.
4. **Claim-field vocabulary:** the middleware matches `actor_agent_id`, `author_agent_id`,
   `requester_agent_id`, `responder_agent_id`, `created_by_agent_id`, plus `agent_id` on
   `POST /api/tasks/{tid}/done` only (elsewhere `agent_id` names a *subject*, e.g. assign).
   Endpoint-level kind gates (`_require_kind`) stay as defense-in-depth behind the match.

## 4. Track 2 — Evidence: tamper-evident audit + exports

(Depends on Auth v1. Design sketch; own spec before build.)

- Hash-chain `events`: `prev_hash`, `event_hash = sha256(prev_hash || canonical(event))`;
  `orcha audit verify` walks the chain; DB role for the portal loses UPDATE/DELETE on
  `events` and `decisions`.
- **Evidence pack** export: for a container or date range, a JSON + human-readable bundle —
  who (authenticated identity + credential) approved what (task, diff from
  `worker_runs.diff`), when, why (decision reason) — with a mapping table to EU AI Act
  Art. 12/14/26 and ISO/IEC 42001 control language.

## 5. Track 3 — Attestation into git

(Depends on Tracks 1–2.) `/orcha-verify` approval emits an in-toto-style attestation
(subject = commit/diff digest, verifier = authenticated human, decision id) stored with the
decision and stamped as commit/PR trailers (`Orcha-Verified-By:`, `Orcha-Decision:`); a
GitHub status check comes later. Publish the attestation format openly.

## 6. Track 4 — Policy engine

(Depends on Auth v1.) Declarative `.orcha/policy.yml`: path-pattern and task-type rules →
required verifier count/kind (e.g. `payments/** → 2 human verifiers`), auto-approve lists
for low-risk task types. Enforced in the same gates `_require_kind` guards today.

## 7. Track 5 — README/positioning refresh

Rewrite the top of `README.md` around the oversight/evidence pitch (target ≤15 lines before
the fold); move operational depth (destructive-command guide, Docker gotchas, hook
internals) into `docs/`. No functional change.

## 8. Sequencing (additive — alongside existing R2 work)

1. **Auth v1** (§3) — unblocks everything; also independently fixes the project's worst
   standing security hole. Est. the largest single track; ship behind `warn` early.
2. **Track 2 evidence** — the demoable "evidence pack" is the design-partner artifact.
3. **Track 5 README** — cheap; do with Track 2 so the pitch matches the product.
4. **Track 3 attestation**, then **Track 4 policy**.

Honest constraint, recorded: with no cuts, these tracks share runway with the R2
embodiment/terminal work (ISS-74, ISS-69/70/71) and desktop/widget maintenance.
Auth v1 + Track 2 are the acquisition-critical path; if anything slips, it should not be
these.

## 9. Open questions

- Do existing dogfooding stacks upgrade in `warn` long enough to re-bind all live agents,
  or do we force re-registration? (Recommend: `warn` + `orcha token new` per agent; no
  re-registration.)
- Desktop app / widget: they read local binding files today; confirm they only need the
  runtime or human token file path added to their config readers (expected: yes, no UI
  work in v1).
