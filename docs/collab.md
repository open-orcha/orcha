# Collab v1 — GitHub identity, project members, task reviewers

The acting human in the portal IS a verified GitHub user. In the cloud deployment,
users sign in through a GitHub OAuth proxy that forwards the verified username as the
`X-Auth-Request-User` request header; the portal maps that identity onto a container's
human agents, owners invite collaborators by GitHub username, and owners route
verification by naming a task's reviewer. Self-hosters without a proxy are unaffected —
the header is ignored unless explicitly trusted, and every surface falls back to the
pre-collab acting-human behavior.

## Identity mapping and the trust env

The header is read **only** when the portal env carries `ORCHA_TRUST_PROXY_USER=1`
(compose passthrough, same pattern as `ORCHA_LLM_API_KEY`). It is trustworthy only
because the cloud portal is loopback-bound *behind* the OAuth proxy — never set it on a
directly-reachable portal, where any client could forge the header.

`GET /api/me?cid=<cid>` resolves the acting identity for a container:

- **Match**: a live human agent with `lower(github_login) = lower(header)` → that agent
  is the actor. Response:
  `{"identity": {agent_id, alias, github_login, member_role, avatar_url}}` where
  `avatar_url` is `https://github.com/<login>.png`.
- **Binding rule** (the "ACTING AS root" fix): if the container has humans but **none**
  carries a `github_login` yet — the fresh `orcha init` state, one human named after
  the unix user — the first verified arrival *is* that human. `/api/me` binds it as a
  side effect: the earliest-created human gets `github_login = <header>`, its alias is
  renamed to the login (kept unchanged only if another agent already uses that alias),
  and it is promoted to `member_role='owner'`. A single guarded `UPDATE` makes this
  idempotent and race-safe under the portal's 3s polling.
- **Otherwise** (mapped humans exist but none match, header absent, or trust off):
  `{"identity": null}`. Endpoints decide what null means; the cloud **perimeter
  allowlist is the hard access gate** — identity resolution only maps who's acting.

Schema (migration `036_collab.sql`): `agents.github_login`,
`agents.member_role ∈ owner|member` (first human per container backfilled/registered
as owner), a case-insensitive partial unique index on
`(container_id, lower(github_login))`, and `tasks.reviewer_agent_id`.

## Members and roles

Members are the container's live `kind='human'` agents. Roles: **owner** (invite/
remove members, change roles, assign reviewers; multiple owners supported) and
**member**. Owner-gating uses the resolved identity when the proxy is trusted; with
trust off it falls back to the standard `actor_agent_id` human-gate convention plus
the owner-role check on the claimed actor.

- `GET /api/containers/{cid}/members` →
  `{"members": [{agent_id, alias, github_login, member_role, pending}]}` —
  `pending` = invited (login set) but never yet active (no heartbeat).
- `POST /api/containers/{cid}/members` `{github_login, role}` (owner) — creates a
  `kind='human'` agent with `alias = github_login` and the login pre-set, so the
  invitee matches directly on first arrival. `409` on a duplicate login (any casing).
- `PATCH /api/containers/{cid}/members/{aid}` `{role}` (owner) — `400` when demoting
  the **last** owner.
- `DELETE /api/containers/{cid}/members/{aid}` (owner) — the existing agent-**retire**
  semantics (`terminated_at`, tasks released), never a hard delete; `400` on the last
  owner; any task naming the removed member as reviewer reverts to *anyone*.

**Invite flow**: an owner adds the GitHub username in **Settings → Members** (role
select, pending badge until first sign-in). NOTE the cloud front door — the
**perimeter allowlist** — is synced separately cloud-side; inviting here maps the
identity inside the workspace, it does not by itself grant access to the deployment.

## Task reviewers

`PUT /api/tasks/{tid}/reviewer` `{reviewer_agent_id | null}` (owner only; the target
must be a live human member of the task's container, else `400`). The snapshot's tasks
carry `reviewer_agent_id` plus a resolved `reviewer {agent_id, alias, github_login}`.

Reviewer assignment is **advisory routing, not a lock**: the verify endpoint keeps its
existing permissive state machine (any human CAN verify). The portal surfaces it as:

- a **Reviewer** row on the task detail (avatar chip or "anyone"; owners get a member
  picker),
- de-emphasis on the home "needs you" queue — a verification whose task names a
  *different* reviewer renders dimmed with a `review: <login>` label for non-owner
  identities; the assigned reviewer, owners, and identity-less (self-host) viewers see
  it normally.

## Portal surfaces

- **Topbar "acting as" chip**: with a resolved identity, a circular GitHub avatar
  (`github.com/<login>.png`, deterministic letter tile as the error fallback) + the
  login. Without one, the pre-collab picked-human chip.
- **Actor attribution**: `actingHuman()` prefers the `/api/me` agent, so verify,
  plan approvals, decisions, comments, and container controls all attribute to the
  verified GitHub user automatically.
- **Settings → Members**: the management card described above (read-only for
  non-owners).
