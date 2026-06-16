# Epic C — Persistence & Resume: per-agent memory digest + auto-resume/rehydrate

**Owner:** Vault (Backend/Persistence Engineer) · **Branch:** `feat/epic-c-agent-digest`
**Status:** implemented (server + CLI + skills + tests green); awaits human `/orcha-verify`.

Lets an agent reconnect to the same workspace days/weeks later and remember not
just its task rows but its **reasoning** — decisions, learnings, current focus,
open threads. Closes the gap Dock surfaced in the persistence interview: reasoning
lived only in the ephemeral Claude conversation and was lost on tab close.

Sequenced **D3 → D4 → D2**: the digest table (D3) is consumed by the rehydrate
assembly (D4), which the SessionStart brief (D2) prints.

## Ownership boundary (locked with Dock's D3 spec)

Two **parallel** injectors at SessionStart, **non-overlapping** content, **no
bidirectional sync** (avoids drift):

| | Claude Code file-memory | Orcha memory digest (this epic) |
|---|---|---|
| Owns | durable USER / PROJECT / feedback / reference facts | per-AGENT work/reasoning state |
| Lives | `~/.claude/projects/.../memory/` (OUTSIDE the repo) | Postgres `agent_memory_digests`, agent_id-keyed |
| Scope | local, private, agent-blind, human-authored | shared, portal-visible, rehydratable by any re-binding tab |
| Injector | Claude Code's own native channel | `orcha rehydrate` (SessionStart) |

The digest never carries project facts; file-memory never carries per-agent work
state. Orcha never reads or writes the CC memory dir.

## D3 — the table (`agent_memory_digests`)

Added to the **canonical** template migration
`orcha-cli/orcha_cli/templates/migrations/001_init.sql` (the file `conftest.py` and
`orcha init` load). Append-only snapshot history; the latest row per agent is the
live view, older rows give the portal a reasoning timeline + cheap audit.

```
id            BIGSERIAL PK
container_id  UUID NOT NULL REFERENCES containers(id)   -- the Orcha "workspace" (D1 rename parked)
agent_id      UUID NOT NULL REFERENCES agents(id)
snapshot_ts   DOUBLE PRECISION NOT NULL                 -- epoch secs, matches agent_events.ts
current_focus TEXT
decisions     JSONB NOT NULL DEFAULT '[]'               -- [{text, ts?}]
learnings     JSONB NOT NULL DEFAULT '[]'               -- [{text, ts?}]
open_threads  JSONB NOT NULL DEFAULT '[]'               -- [{text, ref?}]
created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
INDEX (agent_id, snapshot_ts DESC)
```

**Naming:** the FK is `container_id` (matches existing schema), not `workspace_id`.
The D1 `container → workspace` rename is parked; this column renames atomically with
D1 later. Flagged to Tim/Dock; proceeding with `container_id`.

### Who writes it

Agent-authored. The server **never synthesises** a digest — reasoning isn't
derivable from rows — it only stores what the agent POSTs and stamps `snapshot_ts`
(so cadence is server-truth). One narrow exception preserves this boundary: #287
**Tier-0 compaction** (`post_digest` → `dedup_digest`) drops exact/normalised-duplicate
and empty entries *before* store. It removes only provably-redundant bytes, so it
never edits the agent's reasoning — the stored row stays full + verbatim. `open_threads`
stays the agent's *subjective* loose ends; live inbox/tasks come fresh from existing
tables at rehydrate (no duplication).

## Endpoints (canonical `orcha-cli/orcha_cli/templates/portal/main.py`)

- `POST /api/agents/{aid}/digest` — body `{current_focus, decisions[], learnings[], open_threads[]}`; inserts a snapshot, emits a `digest_snapshotted` event. **201**.
- `GET  /api/agents/{aid}/digest` — the agent's latest snapshot, or `{digest: null}`.
- `GET  /api/agents/{aid}/rehydrate` — **D4**: one call assembling the whole brief:
  `identity` + live (non-terminal) `tasks` (with last thread line) + open `inbox` +
  answered `outbox` + latest `digest`. Identity/tasks/inbox are fresh from existing
  tables (Dock's (i)–(iii)); the digest is the reasoning gap (iv). Carries **no** CC
  file-memory (the boundary).

## Cadence + `/orcha-done` trigger

- **On `/orcha-done`** (deterministic): the skill composes + POSTs the agent's
  end-of-task digest — the natural "finished a unit of work" boundary.
- **Standalone:** `/orcha-snapshot` skill the agent runs any time.
- **No server cron:** the server can't author reasoning, so reminding the agent is
  the only honest cadence. (Follow-up: a gentle "N min since last digest" reminder in
  `/orcha-listen` timeout + `/orcha-checkpoint` output.)

## D2 — SessionStart auto-resume / rehydrate

New CLI `orcha rehydrate` wired into the SessionStart hooks array **alongside**
`orcha watch --detach` (a second, independent, idempotent entry in
`_write_hook_config`). On SessionStart, no command typed by the user, it:

1. detects the stack (`.claude/orcha.json`); silent no-op if absent/unreachable;
2. rebinds the alias via `_resolve_any_binding(cwd, $ORCHA_ALIAS)` — the same
   resolver `orcha watch` uses (alias file → `$ORCHA_ALIAS` → single-binding fallback);
3. `GET /api/agents/{aid}/rehydrate` and prints the brief to stdout — SessionStart
   injects stdout into Claude's context (same channel as `poll-inbox`).

Like every hook, it **never raises**: a SessionStart hook that breaks an unrelated
Claude session is worse than one that stays quiet.

### `orcha use <alias>` (shell attach helper)

A slash command/hook can't mutate the parent shell's env, so `orcha use Vault`
prints `export ORCHA_ALIAS=Vault` for the ssh-agent idiom: `eval "$(orcha use Vault)"`.
Sets the var in *your* shell so subsequent `/orcha-*` skills and a fresh `claude`
resolve to that agent without `--alias`. Validates the binding exists (typos fail loudly).

## Coordination

- **Dock (D3 spec):** reconciled — complement/superset, parallel injectors, no sync.
  One delta flagged: FK named `container_id` not `workspace_id` (D1 parked).
- **Forge (Epic A, SessionStart/tmux):** agreed `orcha rehydrate` can call Forge's
  `POST /api/agents/{aid}/reachability` from inside the same SessionStart
  binding-resolve pass (his call on hook structure since he owns `_write_hook_config`).
  Confirmed **separable layers**: tmux = transport (keeps the terminal alive); digest
  = reasoning (rehydrates even in a brand-new tab with no tmux). `tmux_target`/`cwd`
  are **not** stored in the digest. Wiring the reachability call awaits Forge's field
  contract.

## Deployment notes (for the human / infra)

The build edits the **canonical** `templates/` tree (source of truth). To run live:

1. **Reinstall the CLI** so hooks pick up `orcha rehydrate` / `orcha use`:
   the installed `orcha` is currently a stale copy — `pip install -e orcha-cli`
   (or your install method) so `~/.local/bin/orcha` reflects source.
2. **Redeploy the portal** so the live stack serves the new endpoints (the deployed
   `.orcha/portal/main.py` is a copy made at `orcha init`); restart/rebuild the stack.
3. **Apply the table** to the live `orcha` DB (a fresh `orcha init` gets it from the
   template automatically; an existing DB needs the `CREATE TABLE` applied once).

Until then `orcha rehydrate` no-ops gracefully against the live stack (endpoint 404
→ silent), so nothing breaks.

## Tests (`tests/test_digest.py`, all green)

Round-trip (POST → GET latest), null-before-first-snapshot, append-only history
preserved, unknown-agent 404, bad-UUID 400, `digest_snapshotted` event published,
full rehydrate assembly (identity + task + inbox + digest), **per-agent isolation**
(agent A's digest never leaks to B), and live-tasks-only filtering. Full suite green.

## DoD acceptance

A brand-new tab re-binding alias `<X>` prints `<X>`'s prior `current_focus` /
decisions via `orcha rehydrate` (proven at API level by
`test_rehydrate_assembles_full_brief`; live demo after the deployment steps above).
Never self-certified — a human `/orcha-verify`s the task.
