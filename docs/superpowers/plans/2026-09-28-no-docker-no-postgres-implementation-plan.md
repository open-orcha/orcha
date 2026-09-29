# Run Orcha with no Docker and no Postgres — implementation plan

> **Status:** COMPLETE (2026-09-29, CodeCleanupAgent, Orcha task `cc549ff7`, GH #258). Parts 0–13 and Appendices A–C are written; nothing is pending. This file supersedes the spike comments on GH #258 as the implementation record (the spike comments remain the record of the *findings*). It is an untracked, uncommitted file for the owner to review; line numbers are from `main` @ `a776dd3`.
>
> **For agentic workers:** this plan is meant to be executed PR by PR (Part 11). Each PR lists the files to touch, the tests that must exist, and the acceptance check. Do not skip the parity tests: they are what makes a wide mechanical port safe. Steps use checkbox (`- [ ]`) syntax so progress can be tracked in the file itself.

**Goal:** a non-engineer downloads Orcha.app (or runs one install command), signs in to Claude Code, picks a folder, and agents run. No Docker, no Colima, no Homebrew, no Postgres, no ports or passwords to understand. Existing Docker/Postgres stacks move over with one command and can roll back.

**Strategy (locked by the spike on GH #258, Q6):** go straight to **SQLite under a native `orcha serve` runtime**, then bundle that runtime into the desktop app as a sidecar. Skip the embedded-Postgres detour from #251. Docker becomes optional (kept only for the cloud sandbox runner and the auth perimeter on hosted boxes). Adopt #252 as the storage track (re-ordered to go first) and re-scope #251 to the runtime track without embedded Postgres.

**Tech stack after this plan:** Python ≥ 3.10 (portal + CLI + notifier in ONE environment), FastAPI + uvicorn, `sqlite3` from the standard library (SQLite ≥ 3.38), launchd (macOS) / systemd user units (Linux) for supervision, Electron desktop app with a bundled `python-build-standalone` sidecar (arm64 first). No psycopg, no Docker in the local path.

**Baseline this plan was written against:** `main` @ `4b2bee0` / `a776dd3` (2026-09-28). Line numbers are from that tree. Canonical portal source is `orcha-cli/orcha_cli/templates/portal/` (the `.orcha/portal/` and `desktop/resources/orcha-templates/` trees are untracked mirror copies; never edit them).

---

## Table of contents

- Part 0 — How to read this plan; conventions
- Part 1 — Decisions locked in (D1–D12) and open questions for the owner
- Part 2 — Current architecture, one page, with evidence
- Part 3 — Target architecture
- Part 4 — Workstream S: storage (Postgres → SQLite)
- Part 5 — Workstream R: native runtime in the CLI (`orcha serve`, state file, supervision)
- Part 6 — Workstream M: migrating existing stacks (converter + `orcha migrate-runtime`)
- Part 7 — Workstream D: desktop native mode + bundled sidecar
- Part 8 — Workstream I: install path, packaging, docs
- Part 9 — Workstream X: sandbox without Docker
- Part 10 — Workstream C: Orcha Cloud / BYOC boxes
- Part 11 — PR sequence (the executable checklist)
- Part 12 — Test and CI plan
- Part 13 — Risks, mitigations, and what to watch
- Appendix A — Postgres-only construct inventory (file:line)
- Appendix B — Probe evidence (SQLite behaviour verified on this machine)
- Appendix C — Environment-variable contract of the portal (before/after)

---

## Part 0 — How to read this plan

- **Workstreams** (Parts 4–10) describe *what* and *why*, with the evidence. **Part 11** turns them into an ordered list of PRs, each small enough to review, with tests. If a workstream section and Part 11 ever disagree, Part 11 wins for ordering and Part 4–10 wins for design.
- Every claim about the current code carries a `path:line`. Re-verify against `main` before relying on a line number; the repo moves fast.
- "Portal" = the FastAPI app in `orcha-cli/orcha_cli/templates/portal/` (`main.py` + `portal_backend/`). "CLI" = `orcha-cli/orcha_cli/`. "Daemon"/"notifier" = `orcha notifier`, the host process that wakes agents. "Bridge" = `orcha terminal-bridge`. "Desktop" = `desktop/` (Electron).
- Sizing is in engineer-days for one experienced contributor, code + tests + docs. Treat as ±40%.
- Two probe scripts were run while writing this (Appendix B). They live in `/tmp/orcha-sqlite-spike/` and are throwaway; the plan quotes their output so you do not have to re-run them.

---

## Part 1 — Decisions locked in

These were made in the spike (GH #258) and refined here. Each has a rationale so a reviewer can overturn it deliberately rather than by accident.

| # | Decision | Rationale (short) |
|---|---|---|
| **D1** | **SQLite is the only storage engine after this plan; no dual-dialect product configuration.** A transition-only dialect switch lives inside one module (`portal_backend/sql.py`) while main carries both, and is deleted in the cleanup PR. | #252's argument: maintaining two dialects across 446 `execute(` sites is the expensive path. Orcha Cloud runs one portal per project already, which is SQLite's model. |
| **D2** | **No embedded-Postgres step.** | Every user would migrate twice; ~12 MB of Postgres Mach-O binaries would need notarizing inside the app; the wheel is young. Spike Q2/Q4. |
| **D3** | **Timestamps are stored as ISO-8601 UTC text with microseconds and a `+00:00` suffix** (`2026-09-29T00:34:06.058427+00:00`), never as epoch integers. Columns keep the declared type name `TIMESTAMPTZ` so `sqlite3`'s declared-type converters return `datetime` objects exactly like psycopg does today. | Keeps every FastAPI JSON response byte-identical (same ISO string), keeps `ORDER BY created_at` correct (uniform format ⇒ lexicographic = chronological, verified in Appendix B), and lets `julianday()` do age arithmetic. Epoch integers would change the JSON contract that iOS/Android/desktop decode. |
| **D4** | **`now()` keeps working in SQL via a user-defined function** registered on every connection (`conn.create_function("now", 0, ...)`), returning the canonical text. **Interval arithmetic does not** (`now() - interval '5 hours'` is Postgres syntax): those 20 sites bind a cutoff computed in Python. | Leaves the 144 plain `now()` sites untouched and reviewable by grep, and puts every window boundary in Python where it can be unit-tested. |
| **D5** | **`%s` placeholders stay in the route code for now.** A thin cursor adapter translates `%s` → `?` and `%(name)s` → `:name` at execute time (cached per SQL string). The mechanical `%s` → `?` rewrite is a separate, optional cleanup PR after cutover. | Cuts the diff of the swap PR from ~446 sites to the ~80 that genuinely change semantics, so reviewers can read it. |
| **D6** | **Every transaction that may write starts with `BEGIN IMMEDIATE`.** `db_cursor()` defaults to that; a `db_cursor(readonly=True)` variant (plain `BEGIN`) is used on the hot read paths (event polling, wake scan, snapshot GETs). | Appendix B, case 1: a deferred transaction that reads then writes after another writer committed fails **instantly** with `database is locked` (`SQLITE_BUSY_SNAPSHOT`); `busy_timeout` does not help. Nearly every route reads before it writes (`_require_agent` then `UPDATE`). IMMEDIATE avoids the whole class. |
| **D7** | **One SQLite connection per thread, cached, never closed per request; nested `db_cursor()` on the same thread joins the outer transaction.** | Appendix B, case 4: two connections on one thread deadlock until `busy_timeout` expires. The 182 sync routes run on Starlette's 40-thread pool and `wait_for_event` on the asyncio default executor, so thread-local caching is the natural unit. |
| **D8** | **UUID primary keys stay as text with a SQL `DEFAULT` expression generating v4-shaped ids**, so the 63 `RETURNING id` sites keep working with no app-side id generation. All UUIDs are lowercased on the way in (`valid_uuid` guard normalises; converter lowercases). | Postgres compares UUIDs case-insensitively; SQLite text does not. Verified expression in Appendix B. |
| **D9** | **JSON columns keep the declared type name `JSONB`** and are decoded by a declared-type converter, so `row["payload"]` is a `dict` exactly as with psycopg. Writes keep passing `json.dumps(...)` text; the `::jsonb` casts are simply removed. | 38 write sites already `json.dumps`; only the read side needs the converter. Appendix B confirms bare-number JSON round-trips despite NUMERIC affinity. |
| **D10** | **One squashed baseline `migrations/sqlite/001_baseline.sql`**, generated once from a fully-migrated Postgres test DB by a script kept in `tools/db/`, hand-reviewed, then frozen. Future migrations are plain SQLite files `002_*.sql` applied by the same `run_migrations()` shape. | SQLite has no `ADD COLUMN IF NOT EXISTS` / `DROP CONSTRAINT`; replaying the 49 Postgres files is impossible. |
| **D11** | **The Docker-Postgres runtime is not carried forward as a "Docker + SQLite" mode.** In the release that ships SQLite, an existing Docker stack keeps running untouched until the user runs `orcha migrate-runtime` (which needs Docker up once, to read the data out). `orcha up`/`orcha update` on an unmigrated stack print the instruction instead of rebuilding the image. Rollback re-starts the old compose stack; `--purge-docker` deletes it. | A containerised portal has no purpose once Postgres is gone; keeping it would double the runtime test matrix. The old image + `pgdata` volume are the rollback, untouched until purged. |
| **D12** | **Supervision is owned by an OS unit (launchd user agent / systemd user unit) running `orcha serve`; the desktop app is a client, not a supervisor.** | Agents must keep running after the app quits and after reboot; CLI-only users must get the same. Spike Q4.3. |

### Open questions for the owner (answer before the relevant PR, not before starting)

- **Q-A (before PR S3):** keep the file name `orcha.db` under `<project>/.orcha/`? (Plan assumes yes.)
- **Q-B (before PR R2):** LaunchAgent label `io.openorcha.<project>` and log dir `<project>/.orcha/logs/`? (Plan assumes yes; matches the `io.openorcha` prefix already used by Android and the desktop `appId`.)
- **Q-C (before PR M1):** minimum overlap: keep the old `pgdata` volume until the user runs `--purge-docker` (plan) or auto-purge after N days? (Plan: never implicit.)
- **Q-D (before PR D3):** ship the desktop sidecar arm64-only first (plan) or universal (+53 MB)?
- **Q-E (before PR I1):** replace Homebrew as the primary CLI install with `uv tool install orcha-cli`, keeping the formula as a secondary path? (Plan: yes.)

---

## Part 2 — Current architecture, one page, with evidence

**Processes today (local install):**

| process | how it starts | where | talks to |
|---|---|---|---|
| Postgres 16 | `docker compose up` (`orcha-cli/orcha_cli/templates/docker-compose.yml.j2:6-23`) | container `orcha-<project>-db-1`, port `db_port` published | portal only |
| Portal (FastAPI, 1 uvicorn worker) | same compose file `:24-120`, `Dockerfile:17` | container, port `api_port` → 8000 | Postgres via `DATABASE_URL=postgresql://orcha:orcha@db:5432/orcha` (`:28`); five bind mounts (`:89-118`) |
| Notifier daemon (`orcha notifier`) | `orcha up` → `ensure_daemon` (`notifier_daemon_control.py:106-196`), detached `Popen(start_new_session=True)`; self-healed only by the `SessionStart` hook (`cli_hooks.py:28`) | host, pidfile `.claude/.orcha-notifier.pid` + heartbeat `.orcha-notifier.hb` + claim `~/.orcha/notifier-<cid>.pid` | portal over HTTP only (`cli_http.py`); spawns `claude -p …` / `codex exec …` (`notifier_headless.py:73-121`) |
| Terminal bridge (`orcha terminal-bridge`) | same pattern (`terminal_bridge_daemon.py:50-96`) | host, `bridge_port` | browser ↔ PTY (`orcha use`) |
| Desktop app | Finder | host | `docker ps` every 5–15 s for discovery (`desktop/src/main/discovery.ts:83`), `docker compose start/stop` (`lifecycle.ts:17`), `orcha up` once after provisioning (`hostWorker.ts:154-165`); never supervises anything |

**Key facts that make this plan tractable:**

- The CLI has ONE runtime dependency (`websockets`, `orcha-cli/pyproject.toml:12`) and never touches the DB. Every DB access is inside the portal (`portal_backend/database.py`, `db_cursor()` used from 82 files, 446 `execute(` sites).
- The portal already runs as a host process: `tests/conftest.py:75-81` imports `main` in-process against any Postgres, and `main.py:89-101` falls back to the `orcha_cli` package for shared modules.
- The DB layer is one 70-line module: `database.py` (`db_cursor()` opens a fresh psycopg connection per call, `run_migrations()` applies `*.sql` under `pg_advisory_lock`). There is no ORM, no pool, no LISTEN/NOTIFY. The event bus is a polled table (`events.py:52-86`).
- 182 route functions, of which only 11 are `async def`; sync routes run on Starlette's threadpool. Background threads: local-index warmer (`application_lifecycle.py:48-68`), worktree refresh threads, onboarding model pump, Slack `to_thread` tasks.
- Container-only path defaults: `database.py:12` (`/app/migrations`), `attachment_config.py:6` + `main.py:104` (`/app/orcha-attachments`), compose-injected `/app/workspace`, `/app/stack-dir`. All env-overridable.
- Docker call sites in the CLI: one compose wrapper (`cli_project_setup.py:289-290`) with six call sites (`cli_init.py:131,135`, `cli_project_commands.py:25,71,169`, `cli_status.py:28`); discovery via `docker ps` (`cli_stacks.py:13-23,72-91`); sandbox (`sandbox.py:210-287`, `cli_sandbox.py:53`). The reaper calls `docker info` every daemon tick even in host mode (`notifier_orphan_cleanup.py:272` → `sandbox.py:281-287`).
- Nothing in the repo supervises the notifier after a crash or reboot except the Linux box's `deploy/orcha-notifier@.service` (`Restart=on-failure`).
- Tests: 177 files / ~2,800 tests, all needing Postgres at **collection time** (`tests/conftest.py:56-81` drops/creates `orcha_test` before importing `main`). CI: `.github/workflows/test.yml` with a `postgres:16` service container. Desktop vitest (44 files) is not in CI.

---

## Part 3 — Target architecture

```
<project>/
  .claude/orcha.json        {api_base_url, project_name, api_port, bridge_port, current_container_id,
                             runtime: "native", db_path: ".orcha/orcha.db", cli_version}
  .claude/.orcha-notifier.{pid,hb,log}   (unchanged)
  .claude/.orcha-terminal-bridge.{pid,log} (unchanged)
  .claude/.orcha-wakes/, .orcha-attachments/ (unchanged)
  .orcha/
    orcha.db, orcha.db-wal, orcha.db-shm   ← THE database (WAL mode)
    .env                                   ← ORCHA_SECRET_KEY (unchanged, still the sealing key)
    state.json                             ← {runtime, pids:{serve,portal,notifier,bridge}, ports, started_at, cli_version}
    logs/{serve,portal,notifier,bridge}.log (size-rotated)
    backups/orcha-<ts>.db                  ← `orcha backup` (VACUUM INTO)
    docker-compose.yml, portal/, migrations/  ← Docker-runtime projects ONLY (rollback material; gone after
                                              `orcha migrate-runtime --purge-docker`). Native mode runs the
                                              portal + SQLite migrations straight from the installed
                                              `orcha_cli` package (decision R-D1, Part 5).
    sandbox/, agent-home/                  ← unchanged (sandbox api-config copies, persisted agent ~/.claude)
~/.orcha/stacks.json                       ← machine-wide registry {project → path, api_port}; replaces `docker ps`
~/Library/LaunchAgents/io.openorcha.<project>.plist  (macOS)   |  ~/.config/systemd/user/orcha-<project>.service (Linux)
```

**Version coupling after this plan:** the portal code that serves a project is the code of the `orcha` that starts it (the installed package, or the desktop sidecar's bundled copy). There is no per-project portal copy to fall behind, so `orcha upgrade`'s "re-copy templates + rebuild image" step disappears; the schema still migrates forward on startup, and the old template-tip downgrade guard becomes a DB-tip guard (Part 5, R-D1).

**Processes after this plan:** exactly one OS-supervised process per project, `orcha serve`, which owns three children (portal uvicorn on `127.0.0.1:<api_port>`, notifier, bridge), restarts them with backoff, rotates logs, writes `state.json`. `orcha up` = "ensure the unit is loaded and `orcha serve` is running", so every existing entry point (`orcha up`, the `SessionStart` hooks, the desktop app) keeps working. The desktop app bundles the same Python runtime as a sidecar and calls the bundled `orcha` for init/up/down instead of re-implementing them in TypeScript.

**Data:** one SQLite file per project. Backup = `VACUUM INTO`. Restore = copy the file back while `orcha serve` is stopped.

**What stays on Docker:** nothing locally. On hosted/BYOC boxes: the auth perimeter (Caddy + oauth2-proxy) and the sandbox runner image, both optional (Part 10).

---

## Part 4 — Workstream S: storage (Postgres → SQLite)

This is the largest workstream and the only one with real correctness risk. It is designed so that **main stays releasable at every PR**: the helper module is dialect-aware during the transition, CI runs the suite on both engines until cutover, and the swap PR (S3) is reviewable because the mechanical placeholder rewrite is deferred.

### S0. Ground truth about the SQL surface (counted on `main` @ `a776dd3`, `portal_backend/*.py` only)

| construct | sites | files | how it is handled |
|---|---|---|---|
| `execute(` | 446 | ~180 | untouched by S1–S3 except where listed below |
| `now()` (bare) | 144 | 55 | **stays**: user-defined SQL function (D4) |
| `now() - interval '…'` / `+ interval` | 20 | 8 | rewrite: Python-computed bound parameter (S2) |
| `make_interval(secs => %s)` / `(days => %s)` | 10 | 4 | rewrite: same (S2) — *missed by #252's inventory* |
| `EXTRACT(EPOCH FROM (now() - x))` | 7 | 4 | rewrite: `sql_age_secs("x")` helper (S2) |
| `%s::jsonb`, `'[]'::jsonb`, `'[]'::json` | 16 | 15 | remove cast (S2) |
| `::text`, `::int[]`, `::timestamptz`, `::interval` | 15 | 10 | remove / rewrite (S2) |
| `= ANY(%s)` | 15 | 9 | rewrite: `sql_in()` helper → `IN (SELECT value FROM json_each(?))` (S2) |
| `FOR UPDATE` (plain) | 6 | 5 | delete; `BEGIN IMMEDIATE` covers it (S3) |
| `FOR UPDATE SKIP LOCKED` | 1 | 1 | claim rewrite (S4) |
| `DISTINCT ON` | 1 query | `code_space_routes.py:438` | window function (S2) |
| `unnest(%s::int[])` + `JOIN LATERAL` | 1 query | `task_start_core.py:241` | `json_each` + correlated subquery (S2) |
| `LEFT JOIN LATERAL` | 1 | `active_conversation_routes.py:139` | correlated subquery (S2) |
| `json_build_object(...)` | 12 | 3 | `json_object(...)` (S2) — *missed by #252* |
| `json_agg(x ORDER BY …)` | 3 | 2 | `json_group_array(x)` with ordered subquery (S2) — *missed by #252* |
| `LEFT(col, n)` | 6 | 3 | `substr(col, 1, n)` (S2) — *missed by #252* |
| `GREATEST(a, b)` | 5 SQL sites | 4 | `max(a, b)` **with COALESCE** — SQLite's scalar `max()` returns NULL if any argument is NULL, Postgres ignores NULLs (S2) |
| `ILIKE` | 1 | `task_start_core.py:343` | `LIKE` (S2) |
| `payload->>'key'` | 6 | 4 | supported (SQLite ≥ 3.38); **one site compares a JSON boolean** (`container_metrics_routes.py:180`) and must change (S2) |
| `FILTER (WHERE …)`, CTEs, `NULLS FIRST/LAST`, `RETURNING`, `ON CONFLICT … DO UPDATE`, `UPDATE … FROM`, `rowcount`, `executemany`, `= false`, `COALESCE`, `NULLIF`, `lower()`, `||` | many | — | supported as-is (probe-verified for the non-obvious ones) |
| `%(name)s` named placeholders | 11 | 3 (`push_outbox.py`, `agent_reachability_routes.py`, `local_git.py`) | adapter maps to `:name` (S3) |
| `psycopg.errors.UniqueViolation` | 5 | 5 | `sqlite3.IntegrityError` via `db.is_unique_violation(exc)` (S3) |
| `psycopg.types.json.Jsonb(...)` | 1 | `member_routes.py:250` | `json.dumps` (S2) |
| `psycopg.connect` outside database.py | 1 | `application_lifecycle.py:75` | `database.ping()` (S3) |
| `pg_advisory_lock`, `to_regclass` | 3 | `database.py` | replaced in S3 |
| `LISTEN/NOTIFY`, `string_agg`, `array_agg`, `jsonb_*`, `date_trunc`, `WITH RECURSIVE`, `SAVEPOINT`, sequences, `AT TIME ZONE` | 0 | — | nothing to do |

Migrations (49 files, `orcha-cli/orcha_cli/templates/migrations/`): 34 tables, 34 indexes, 66 `TIMESTAMPTZ` columns, 20 `JSONB`, 16 `UUID DEFAULT gen_random_uuid()`, 3 `BIGSERIAL` (`events.id`, `agent_events.id`, `agent_memory_digests.id`), 1 `NUMERIC(14,6)` (`worker_runs.total_cost_usd`), 6 `DOUBLE PRECISION`, 1 plpgsql trigger (`031_worker_run_tasks.sql:39-53`), 3 `DO $$` guards, `containers_singleton` (created `001:26`, dropped `037:17`), `CREATE EXTENSION pgcrypto` (`001:1`). Full file:line list in Appendix A.

### S1. New module `portal_backend/sql.py` — dialect helpers + lint (PR S1, behaviour-neutral on Postgres)

Purpose: give every construct that differs between engines ONE spelling, so the S2 rewrite is mechanical and the lint can prove completeness. During the transition the module emits Postgres or SQLite text based on `DIALECT`; the Postgres branches are deleted in the cleanup PR.

```python
# portal_backend/sql.py  (new)
"""Dialect helpers. Every Postgres-only SQL construct in portal_backend goes through here.
tests/test_no_postgres_syntax.py fails the build if one is spelled inline anywhere else."""
import datetime as _dt, json, os

DIALECT = os.environ.get("ORCHA_DB_DIALECT", "postgres")   # transition only; "sqlite" after cutover
UTC = _dt.timezone.utc

def utcnow() -> _dt.datetime:
    return _dt.datetime.now(UTC)

def ts(dt: _dt.datetime) -> str:
    """Canonical stored form: ISO-8601, UTC, microseconds, '+00:00'. Same text FastAPI emits today."""
    return dt.astimezone(UTC).isoformat(timespec="microseconds")

# --- window boundaries: compute in Python, bind as a parameter (D4) ---
def ago(seconds: float) -> _dt.datetime:          # `now() - interval '5 hours'`  ->  `>= %s` with ago(5*3600)
    return utcnow() - _dt.timedelta(seconds=seconds)
def from_now(seconds: float) -> _dt.datetime:     # `now() + make_interval(secs => %s)`  ->  `%s` with from_now(n)
    return utcnow() + _dt.timedelta(seconds=seconds)

# --- age in seconds as a SQL expression (the 7 EXTRACT(EPOCH ...) sites) ---
def age_secs(col: str) -> str:
    if DIALECT == "postgres":
        return f"EXTRACT(EPOCH FROM (now() - ({col})))"
    return f"((julianday(now()) - julianday({col})) * 86400.0)"

# --- `x = ANY(%s)` (15 sites) ---
def in_list(col: str) -> str:
    """Use as f\"{sql.in_list('id')}\" and bind sql.list_param(ids)."""
    return f"{col} = ANY(%s)" if DIALECT == "postgres" else f"{col} IN (SELECT value FROM json_each(%s))"
def list_param(values) -> object:
    return list(values) if DIALECT == "postgres" else json.dumps([str(v) for v in values])

# --- JSON ---
def json_param(obj) -> object:            # replaces `%s::jsonb` + psycopg Jsonb()
    return json.dumps(obj)
def json_cast(placeholder: str = "%s") -> str:   # for the few f-string sites: `%s::jsonb` -> json_cast()
    return f"{placeholder}::jsonb" if DIALECT == "postgres" else placeholder
def json_object(*pairs: str) -> str:     # json_build_object('k', v, ...)  -> json_object('k', v, ...)
    fn = "json_build_object" if DIALECT == "postgres" else "json_object"
    return f"{fn}({', '.join(pairs)})"
def json_array_agg(expr: str, order_by: str | None = None) -> str:
    if DIALECT == "postgres":
        return f"json_agg({expr}{' ORDER BY ' + order_by if order_by else ''})"
    return f"json_group_array({expr})"    # ORDER BY must move into the subquery FROM clause (see S2 notes)
def json_bool_is_true(expr: str) -> str: # payload->>'approved' = 'true' vs SQLite ->> returning 1
    return f"COALESCE({expr}, 'true') = 'true'" if DIALECT == "postgres" else f"COALESCE(json_extract_bool({expr}), 1) = 1"

# --- strings / misc ---
def left(col: str, n: int) -> str:
    return f"LEFT({col}, {n})" if DIALECT == "postgres" else f"substr({col}, 1, {n})"
def greatest(*exprs: str) -> str:
    """Postgres GREATEST ignores NULLs; SQLite max() propagates them. Callers pass COALESCE'd exprs."""
    return f"GREATEST({', '.join(exprs)})" if DIALECT == "postgres" else f"max({', '.join(exprs)})"
def ilike() -> str:
    return "ILIKE" if DIALECT == "postgres" else "LIKE"
def for_update() -> str:
    return " FOR UPDATE" if DIALECT == "postgres" else ""
def is_unique_violation(exc: BaseException) -> bool:
    if DIALECT == "postgres":
        import psycopg; return isinstance(exc, psycopg.errors.UniqueViolation)
    import sqlite3; return isinstance(exc, sqlite3.IntegrityError) and "UNIQUE" in str(exc)
```

Notes for the implementer:
- `json_extract_bool` above is a placeholder for the actual SQLite spelling: `json_extract(detail, '$.approved')` returns `1`/`0` for JSON booleans, so the site becomes `COALESCE(json_extract(detail, '$.approved'), 1) = 1`. Only one site needs it (`container_metrics_routes.py:180`); do not over-engineer.
- `ago()`/`from_now()` return `datetime` objects. On Postgres psycopg adapts them; on SQLite the adapter registered in S3 converts them to canonical text. Comparisons against stored text are then lexicographic on identical formats — correct.
- **Never use SQLite's `datetime()`/`strftime()` output in a comparison against a stored column**: `datetime(col, '-5 hours')` yields `YYYY-MM-DD HH:MM:SS` (space, no fraction, no offset), which sorts *before* every canonical `…T…` string of the same day. The lint forbids `datetime(` and `strftime(` outside `sql.py` and the baseline schema.
- Lint: `tests/test_no_postgres_syntax.py` greps `portal_backend/**/*.py` (excluding `sql.py`) for: `interval '`, `make_interval`, `EXTRACT(EPOCH`, `::jsonb`, `::json`, `::text`, `::int`, `::timestamptz`, `::interval`, `ANY(`, `unnest(`, `LATERAL`, `DISTINCT ON`, `json_build_object`, `json_agg`, `LEFT(`, `GREATEST(`, `ILIKE`, `FOR UPDATE`, `SKIP LOCKED`, `pg_advisory`, `to_regclass`, `psycopg`, `Jsonb(`, `datetime(`, `strftime(`. It starts with an allow-list of the not-yet-ported sites (the table above) that shrinks to empty by S3. Each allow-list entry is `path:line`, so a PR that ports a site must also delete its entry.

**Tests for S1:** unit tests for every helper in both dialects (`tests/test_sql_helpers.py`): `ts()` round-trips through `datetime.fromisoformat`; `ago(3600)` is exactly one hour before `utcnow()` within 5 ms; SQLite `age_secs` on an in-memory `sqlite3` db returns ≈ the elapsed seconds; `in_list` + `list_param` on both engines; `greatest` documents the NULL caveat with a test that fails if a caller forgets COALESCE. Size: 2 days.

### S2. Port the differing sites through `sql.py` (PR S2a/S2b, still on Postgres, behaviour-neutral)

Mechanical, reviewable in two halves (a: time + JSON + arrays; b: the one-off queries). Every site in the S0 table except the claim (S4) and the `FOR UPDATE` deletions (S3). Concrete rewrites the implementer should copy:

- **Spend/token windows** `container_token_usage_routes.py:88-102` (`ended_at >= now() - interval '5 hours'` ×6, `'7 days'` ×6): replace with `ended_at >= %s` and bind `sql.ago(5*3600)` / `sql.ago(7*86400)` once each (compute both cutoffs before the query; add them to the parameter tuple in order). Same in `agent_spend_routes.py:44` (`WINDOW_INTERVALS` becomes a dict of seconds), `wake_backoff.py:115`, `wake_scan_routes.py:57`, `orphan_lease_routes.py:164`, `push_routes.py:220`, `push_outbox.py:52`, `device_token_routes.py:123`, `container_metrics_routes.py:165,172,181` (`make_interval(days => %s)` → bind `sql.ago(days*86400)`).
- **Lease writes** `wake_lease_claim_routes.py:76,78,97,99`, `wake_lease_renewal_routes.py:31,43` (`now() + make_interval(secs => %s)`), `wake_backoff.py:144` (`now() + (%s || ' seconds')::interval`), `wake_backoff.py:206` and `request_creation_routes.py:176` (`now() + interval '7 days'`, `(%s || ' minutes')::interval`): bind `sql.from_now(secs)`.
- **Age reads** `wake_scan_queries.py:14-19`, `orphan_lease_routes.py:34,42`, `container_snapshot_routes.py:171`, `active_conversation_routes.py:94`: f-string `sql.age_secs("w.last_woken_at")` etc. `orphan_lease_routes.py:26` builds `GREATEST((hb),(floor))` — wrap each operand in `COALESCE(x, '1970-01-01T00:00:00.000000+00:00')` before `sql.greatest()`.
- **`= ANY(%s)`** (15 sites, list in Appendix A): `f"WHERE {sql.in_list('id')}"` + `sql.list_param(ids)`. Note `orphan_lease_routes.py:59` uses `agent_id::text = ANY(%s)`: drop the cast (ids are text after S3; on Postgres the cast is harmless, keep it inside the helper's postgres branch if needed).
- **JSON casts** (16 sites): `%s::jsonb` → `%s`, `'[]'::jsonb` → `'[]'`, `'[]'::json` → `'[]'`; `member_routes.py:250` `Jsonb(deduped)` → `sql.json_param(deduped)`. Postgres accepts plain text for a `jsonb` column on INSERT/UPDATE (implicit cast from unknown-typed literal), so this is neutral. **Exception:** parameters compared or concatenated as JSON in a SELECT keep working only if the column type drives the cast; the four `SELECT … '[]'::jsonb` defaults (`task_message_routes.py:178` etc.) become `COALESCE(m.attachments, '[]')` — neutral on both.
- **`json_build_object` / `json_agg`** (`task_list_query.py:19-56`, `container_snapshot_routes.py:80,99,178-181,253`, `container_request_list_routes.py:94`): `sql.json_object("'task_id'", "st.id", "'title'", "st.title", …)`. For `json_agg(a.alias ORDER BY a.alias)` (`task_list_query.py:23`): SQLite's `json_group_array` has no `ORDER BY`; rewrite as `(SELECT json_group_array(alias) FROM (SELECT a.alias FROM agent_tasks at JOIN agents a … WHERE at.task_id = t.id ORDER BY a.alias))`, which both engines accept. **Important:** on Postgres these functions return `json` and psycopg decodes them to Python objects; on SQLite `json_object()` returns TEXT. The S3 row adapter must therefore decode by **column name** for these aliases (`assignees`, `message_summary`, `plan_decision`, `latest_message`, `blocked_on`, `requests`, …) as well as by declared type. Collect the alias list while doing S2 and put it in `database.JSON_ALIASES`; the parity test (S8) catches any miss.
- **`LEFT(col, n)`** (6 sites) → `sql.left("m.body", 140)`.
- **`DISTINCT ON (thread_id) … ORDER BY thread_id, created_at`** (`code_space_routes.py:438`): `SELECT thread_id, body FROM (SELECT thread_id, body, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY created_at ASC) AS rn FROM code_thread_messages WHERE {sql.in_list('thread_id')}) WHERE rn = 1` — valid on both.
- **`unnest(%s::int[]) … JOIN LATERAL`** (`task_start_core.py:241-246`): `SELECT v.number, (SELECT id FROM tasks WHERE container_id=%s AND {sql.in_list('status')} AND title LIKE %s || v.number || ': %%' ORDER BY created_at, id LIMIT 1) AS task_id FROM (SELECT value AS number FROM json_each(%s)) v` — on Postgres keep the `unnest` spelling inside a `sql.int_rows()` helper; the correlated-subquery shape is portable. `v.number::text` → `CAST(v.number AS TEXT)` (portable).
- **`LEFT JOIN LATERAL (SELECT seq, role FROM conversation_turns WHERE conversation_id = cv.id ORDER BY seq DESC LIMIT 1) t ON true`** (`active_conversation_routes.py:139`): two correlated scalar subqueries `(SELECT seq FROM … LIMIT 1) AS last_seq, (SELECT role FROM … LIMIT 1) AS last_role`. Portable.
- **`ILIKE %s`** (`task_start_core.py:343`) → `f"role {sql.ilike()} %s"`.
- **`->>` boolean** (`container_metrics_routes.py:180`) → `sql.json_bool_is_true("detail->>'approved'")` per the note in S1.
- **`GREATEST` in UPDATE … SET** (`agent_notification_routes.py:191`, `event_acknowledgement.py:53`, `wake_acknowledgement_routes.py:24,66`): these compare `DOUBLE PRECISION` epoch floats, never NULL by schema (`NOT NULL DEFAULT 0`) except `conv_delivered_ts` (nullable, `030:34`) — wrap that one in `COALESCE(x, 0)`.

Acceptance for S2: full pytest green on Postgres, the lint's allow-list reduced to the S3/S4 entries only, and **zero JSON-response diffs** in the parity snapshot (S8, run on Postgres before/after). Size: 5–6 days for both halves.

### S3. Swap `database.py` to `sqlite3` (PR S3 — the cutover PR)

Replace the module wholesale. Shape to implement (this is the core of the port; every line matters):

```python
# portal_backend/database.py (SQLite version)
"""Own the SQLite connection per thread, the row/type adapters, and the migration runner."""
import datetime as _dt, json, os, pathlib, re, sqlite3, threading, time
from contextlib import contextmanager
from functools import lru_cache

DB_PATH = pathlib.Path(os.environ["ORCHA_DB_PATH"])                     # e.g. <project>/.orcha/orcha.db
MIGRATIONS_DIR = pathlib.Path(os.environ.get("MIGRATIONS_DIR", str(pathlib.Path(__file__).resolve().parents[2] / "migrations" / "sqlite")))
SLOW_TX_SECS = float(os.environ.get("ORCHA_DB_SLOW_TX_SECS", "0.25"))
UTC = _dt.timezone.utc
JSON_ALIASES = frozenset({"assignees", "message_summary", "plan_decision", ...})   # filled during S2

# ---- type adapters (D3, D8, D9) ----
sqlite3.register_adapter(_dt.datetime, lambda d: d.astimezone(UTC).isoformat(timespec="microseconds"))
sqlite3.register_adapter(bool, int)
sqlite3.register_converter("TIMESTAMPTZ", lambda b: _dt.datetime.fromisoformat(b.decode()))
sqlite3.register_converter("JSONB", lambda b: json.loads(b.decode()))
sqlite3.register_converter("BOOLEAN", lambda b: b in (b"1", b"true", b"TRUE"))
sqlite3.register_converter("UUID", lambda b: b.decode())

def _now_text() -> str:
    return _dt.datetime.now(UTC).isoformat(timespec="microseconds")

def _dict_row(cur, row):
    d = {}
    for (name, *_), value in zip(cur.description, row):
        if name in JSON_ALIASES and isinstance(value, str):
            value = json.loads(value)           # json_object()/json_group_array() come back as TEXT
        d[name] = value
    return d

_local = threading.local()

def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, detect_types=sqlite3.PARSE_DECLTYPES, isolation_level=None,   # autocommit; we BEGIN ourselves
                           timeout=5.0, check_same_thread=True)
    conn.row_factory = _dict_row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.create_function("now", 0, _now_text, deterministic=False)      # D4: `now()` keeps working in SQL
    return conn

def _conn() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = _local.conn = _connect()
        _local.depth = 0
    return conn

# ---- placeholder translation (D5) ----
_PCT_S = re.compile(r"%s|%\((\w+)\)s|%%")
@lru_cache(maxsize=4096)
def _translate(sql: str) -> str:
    return _PCT_S.sub(lambda m: "%" if m.group(0) == "%%" else (":" + m.group(1) if m.group(1) else "?"), sql)

class Cursor:
    """psycopg-shaped cursor over sqlite3: execute/executemany/fetch*/rowcount/description."""
    def __init__(self, conn): self._cur = conn.cursor()
    def execute(self, sql, params=()):
        self._cur.execute(_translate(sql), params); return self
    def executemany(self, sql, seq):
        self._cur.executemany(_translate(sql), seq); return self
    def fetchone(self): return self._cur.fetchone()
    def fetchall(self): return self._cur.fetchall()
    def fetchmany(self, n): return self._cur.fetchmany(n)
    @property
    def rowcount(self): return self._cur.rowcount
    @property
    def description(self): return self._cur.description
    def close(self): self._cur.close()

class Conn:
    """psycopg-shaped connection: commit()/rollback()/execute(); nested scopes join the outer tx (D7)."""
    def __init__(self, raw): self._raw = raw
    def commit(self):
        if self._raw.in_transaction: self._raw.execute("COMMIT")
    def rollback(self):
        if self._raw.in_transaction: self._raw.execute("ROLLBACK")
    def execute(self, sql, params=()):
        return Cursor(self._raw).execute(sql, params)

@contextmanager
def db_cursor(*, readonly: bool = False):
    """Yield (conn, cur). Outermost scope opens BEGIN IMMEDIATE (or BEGIN when readonly);
    inner scopes on the same thread reuse it. Exit: commit if clean, rollback on exception."""
    raw = _conn()
    outer = _local.depth == 0
    _local.depth += 1
    t0 = time.monotonic()
    try:
        if outer:
            raw.execute("BEGIN" if readonly else "BEGIN IMMEDIATE")
        conn = Conn(raw); cur = Cursor(raw)
        yield conn, cur
        if outer: conn.commit()
    except BaseException:
        if outer: conn.rollback()
        raise
    finally:
        _local.depth -= 1
        if outer and (held := time.monotonic() - t0) > SLOW_TX_SECS:
            print(f"[db] slow transaction {held*1000:.0f} ms", flush=True)

def ping() -> None:
    _conn().execute("SELECT 1")

def run_migrations(migrations_dir=None) -> list[str]:
    mdir = pathlib.Path(migrations_dir or MIGRATIONS_DIR)
    files = sorted(mdir.glob("*.sql")) if mdir.is_dir() else []
    applied = []
    raw = _conn()
    raw.execute("BEGIN IMMEDIATE")                       # the migration mutex (replaces pg_advisory_lock)
    try:
        raw.execute("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, "
                    "applied_at TIMESTAMPTZ NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00'))")
        done = {r["version"] for r in raw.execute("SELECT version FROM schema_migrations")}
        for f in files:
            if f.name in done: continue
            raw.executescript(f.read_text())             # executescript commits first! see note below
            raw.execute("BEGIN IMMEDIATE")
            raw.execute("INSERT OR IGNORE INTO schema_migrations(version) VALUES (?)", (f.name,))
            applied.append(f.name)
        raw.execute("COMMIT")
    except BaseException:
        if raw.in_transaction: raw.execute("ROLLBACK")
        raise
    return applied
```

Implementation notes that will bite if ignored:
1. **`executescript()` issues a COMMIT before running** and leaves autocommit afterwards. So a migration file is *not* atomic with its `schema_migrations` row unless you split statements yourself. Recommended: parse each file into statements (split on `;` at line end, ignoring `--` comments; the baseline and future files are written to satisfy this) and run them with `execute()` inside the one `BEGIN IMMEDIATE`. Add a test that a failing statement in a migration leaves `schema_migrations` unchanged.
2. **`in_transaction` is the source of truth**, never a Python flag: `isolation_level=None` means sqlite3 never opens implicit transactions, so a stray `COMMIT` without `BEGIN` raises. `Conn.commit()` guards on it. Route code calls `conn.commit()` mid-scope in a few places (e.g. `agent_task_claim_routes.py:48,81`); after an explicit commit the scope is in autocommit until exit, matching psycopg (where a new implicit transaction would start on the next execute). If a later statement in the same scope must be transactional, re-`BEGIN IMMEDIATE` on the next execute when `not in_transaction` — implement that in `Cursor.execute` (one `if`), and test it with a two-writes-after-commit route.
3. **Thread-locals and thread churn:** anyio's threadpool and `asyncio.to_thread` reuse threads, so cached connections are reused; threads that die leak nothing (SQLite closes on GC). Register `_local.conn.close()` in a `threading` finaliser only if a leak shows up under `pytest -p no:cacheprovider` memory checks; do not pre-optimise.
4. **Long transactions:** the ten files that mix `db_cursor` with network/subprocess calls (`local_git.py`, `task_start_core.py`, `github_routes.py`, `github_hub_routes.py`, `github_repo_browse_routes.py`, `github_pat_routes.py`, `code_github_edit_routes.py`, `slack_routes.py`, `slack_notify.py`, `slack_files.py`) hold `BEGIN IMMEDIATE` across the slow call and block every other writer. The slow-transaction log finds them at runtime; the S3 PR must audit each and either (a) move the slow call outside the `with` block, or (b) open the scope `readonly=True` for the read part and a second scope for the write. Do not merge S3 with any route holding a write lock across `urllib`/`subprocess`.
5. **`readonly=True` adoption list (hot paths):** `events.fetch_next_event` (polled every 0.5 s per SSE/long-poll client), `wake_scan_queries`/`wake_scan_routes` GET, `container_snapshot_routes.get_container`, `container_task_list_routes`, `container_request_list_routes`, `agent_notification_routes` GET, `worker_run_read_routes` stream, `dashboard_routes`. A readonly scope must never execute a write (sqlite raises `cannot start a transaction within a transaction`? No: it silently upgrades and can hit `BUSY_SNAPSHOT` — add an assertion in `Cursor.execute` that rejects `INSERT|UPDATE|DELETE` when the scope is readonly, in debug builds via `ORCHA_DB_ASSERT_READONLY=1`, on in tests).
6. **`application_lifecycle.startup_migrate`** (`:71-107`): replace the `psycopg.connect` retry loop with `database.ping()` (a file open never needs 20 retries; keep the loop at 3 for a mounted-volume edge case). `admin_migrate` unchanged.
7. **`UniqueViolation` sites** (5): `except Exception as exc: if not sql.is_unique_violation(exc): raise` — or catch `sqlite3.IntegrityError` directly after cutover.
8. **`ORCHA_WAKES_DIR`** is set by compose but read by nothing (verified); drop it from the env contract.
9. **`DATABASE_URL`** is read at import (`database.py:11`) and by `tests/test_e2e_terminal_smoke.py:35,87` and `test_migrations.py:24-30`; those tests change in S6.

**Baseline schema (D10):** `orcha-cli/orcha_cli/templates/migrations/sqlite/001_baseline.sql`, generated by `tools/db/gen_sqlite_baseline.py` from a fully-migrated Postgres test DB (`information_schema` + `pg_indexes` + `pg_constraint`) with this type map, then hand-reviewed and committed:

| Postgres | SQLite DDL (declared type is what the converters key on) |
|---|---|
| `UUID PRIMARY KEY DEFAULT gen_random_uuid()` | `UUID PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4))) \|\| '-' \|\| lower(hex(randomblob(2))) \|\| '-4' \|\| substr(lower(hex(randomblob(2))),2) \|\| '-' \|\| substr('89ab', abs(random()) % 4 + 1, 1) \|\| substr(lower(hex(randomblob(2))),2) \|\| '-' \|\| lower(hex(randomblob(6))))` (v4-shaped; Appendix B) |
| `UUID` (FK / plain) | `UUID` (text affinity via converter; store lowercase) |
| `TIMESTAMPTZ [NOT NULL] [DEFAULT now()]` | `TIMESTAMPTZ … DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now') \|\| '000+00:00')` |
| `JSONB [DEFAULT '[]'::jsonb]` | `JSONB … DEFAULT '[]'` |
| `BOOLEAN DEFAULT true/false` | `BOOLEAN DEFAULT 1/0` |
| `BIGSERIAL PRIMARY KEY` | `INTEGER PRIMARY KEY AUTOINCREMENT` |
| `INT`, `BIGINT` | `INTEGER` |
| `DOUBLE PRECISION`, `NUMERIC(14,6)` | `REAL` (cost values lose Decimal exactness: 6 dp × float64 is fine for USD cents; the parity test asserts `abs(diff) < 1e-9`) |
| `TEXT`, `CHECK (...)`, `UNIQUE (...)`, `REFERENCES … ON DELETE CASCADE`, partial indexes, `lower()` indexes | same |
| `CREATE EXTENSION pgcrypto` | dropped |
| `containers_singleton` | already dropped by `037_multi_project.sql:17`; nothing to port |
| plpgsql trigger `sync_worker_run_task` (`031:39-53`) | two triggers: `CREATE TRIGGER worker_run_task_sync_ins AFTER INSERT ON worker_runs WHEN NEW.task_id IS NOT NULL BEGIN INSERT OR IGNORE INTO worker_run_tasks(run_id, task_id) VALUES (NEW.run_id, NEW.task_id); END;` and `…_upd AFTER UPDATE OF task_id ON worker_runs WHEN NEW.task_id IS NOT NULL …` |
| `DO $$ … $$` idempotent guards (`030:51`, `036:18`, `039:13`) | dropped (baseline is authoritative) |
| `ALTER TABLE … ADD COLUMN IF NOT EXISTS` (59) / `DROP CONSTRAINT` / `RENAME` | folded into the final `CREATE TABLE` |

The baseline stamps its own version row and **also stamps every Postgres migration name** (`001_init.sql` … `049_disable_worktrees.sql`) into `schema_migrations` so `run_migrations()` on a converted DB (Part 6) and on a fresh DB see the same history and tooling that lists "applied migrations" keeps its meaning.

`test_schema_parity.py` (transition only): create the Postgres test DB via the 49 files and the SQLite DB via the baseline; compare `{table: {column: nullable}}` and index/unique/FK sets after normalising types. It fails if anyone adds a Postgres migration without the SQLite twin during the overlap.

**Environment:** `DATABASE_URL` → `ORCHA_DB_PATH` (absolute path). `MIGRATIONS_DIR` default becomes the package's `templates/migrations/sqlite` (no `/app`). Compose template (still shipped until D11's cleanup) is not updated for SQLite (D11: no Docker+SQLite mode).

Size: 5–6 days including the audit in note 4 and the baseline review.

### S4. Task-claim rewrite + concurrency test (PR S4, can land with S3)

`agent_task_claim_routes.py:35-61` becomes one statement inside the scope's `BEGIN IMMEDIATE`:

```sql
UPDATE tasks SET status = 'in_progress', started_at = COALESCE(started_at, now())
 WHERE id = (SELECT t.id FROM tasks t
               JOIN agent_tasks at ON at.task_id = t.id AND at.agent_id = %s
                AND at.assignment_status IN ('assigned','accepted','working')
              WHERE t.container_id = %s AND t.status = 'ready' AND t.is_root = 0
              ORDER BY t.priority, t.created_at LIMIT 1)
RETURNING id, title, description, definition_of_done, priority, protocol
```
then the existing `agent_tasks` upsert (`:56-61`) and the rest unchanged. The prototype in `/tmp/orcha-sqlite-spike/claim_proto.py` (spike Q3.1) ran this shape at 64 threads × 1,000 tasks with one winner per task and zero busy errors. The six plain `FOR UPDATE` sites (`request_lookup.py:18`, `code_space_routes.py:575`, `conversation_write_routes.py:63`, `request_backstop.py:22`) lose the suffix via `sql.for_update()` → `""`.

Test `tests/test_task_claim_concurrency.py`: seed 10 ready tasks assigned to one agent, mint 20 work-lane tokens, fire 20 concurrent `POST /api/agents/{aid}/next` through a real uvicorn (the smoke harness in `tests/test_e2e_terminal_smoke.py:61-80` shows how) or `ThreadPoolExecutor` against the ASGI app with `anyio` portals; assert exactly 10 distinct task ids, 10 `{"task": None}`, no 5xx, and `agent_tasks` has one `working` row per claimed task. Then the same with 5 agents each assigned the same 10 tasks: still exactly 10 winners overall. Size: 1.5 days.

### S5. Timestamp and window boundary tests (PR S5, lands with S3)

`tests/test_time_windows_utc.py`: freeze `sql.utcnow` via monkeypatch and check the five correctness-critical windows at their exact boundaries on the SQLite backend:
- token/spend windows (`container_token_usage_routes.py:88-102`, `agent_spend_routes.py:44`): a run ended 4h59m59s ago counts in the 5 h window; 5h00m01s ago does not;
- wake backoff suppression (`wake_backoff.py:115,144`): `suppressed_until` written via `from_now()` reads back as a `datetime` and `now() < suppressed_until` flips exactly at the boundary;
- single-flight lease (`wake_lease_claim_routes.py:76-99`, `002_wake_single_flight.sql:8`): a lease of N seconds is honoured for N−1 and expired at N+1;
- orphan-lease idle computation (`orphan_lease_routes.py:26-42`): with a NULL heartbeat the COALESCE floor applies (this is the `GREATEST` NULL trap);
- wake-scan `secs_since_woken` (`wake_scan_queries.py:14-19`) equals wall-clock elapsed ± 1 s.
Also: every API response field that was a datetime on Postgres is still an ISO string with `+00:00` (covered by S8). Size: 1 day.

### S6. Test suite on SQLite (PR S6, lands with S3 — the suite must be green on SQLite before S3 merges)

`tests/conftest.py` changes:
- `ORCHA_TEST_BACKEND=sqlite|postgres` (default `sqlite` after cutover). SQLite: `tmp_path_factory`-style session temp file, `ORCHA_DB_PATH` set **before** `import main`, migrations applied by calling `portal_backend.database.run_migrations()` (so the runner itself is exercised; today conftest bypasses it, `:56-71`).
- `_clean_db`: `PRAGMA foreign_keys=OFF; DELETE FROM <each app table>; DELETE FROM sqlite_sequence; PRAGMA foreign_keys=ON` inside one transaction. Include the eight tables that `APP_TABLES` (`:43-53`) currently omits and only clears via CASCADE (`worker_runs`, `worker_run_lines`, `worker_run_tasks`, `embodiment_tokens`, `container_model_settings`, `roster_analysis`, `code_threads`, `code_thread_messages`; `code_threads` has no `ON DELETE CASCADE`, `045_code_space.sql:23,56`). Derive the list from `sqlite_master` instead of hand-maintaining it.
- `Db.execute`: use `portal_backend.database` (same adapters, same `%s` translation) so test SQL keeps working; add `db.ago(seconds)` and `db.from_now(seconds)` helpers returning canonical text for the 31 test files that write `now() - interval '…'` / `make_interval` / `EXTRACT(EPOCH)` in raw SQL (`test_iss60b_orphan_lease_reaper.py` ×21, `test_metrics_endpoint.py:136-214`, `test_iss50_heartbeat_on_poll.py:28-77`, `test_push_pipeline.py:440`, `test_iss266_auto_wake.py:39,153,304`, …). Port those files mechanically (the lint from S1 can be pointed at `tests/` with its own allow-list to track progress).
- Driver/catalog-specific tests: `test_migrations.py:51-83` (`to_regclass`, the compose initdb assertion) → `sqlite_master` + drop the compose assertion (D11); `information_schema.columns` in `test_iss294_llm_key.py:309`, `test_pr_attribution.py:43`, `test_iss294_model_settings.py:235` → `PRAGMA table_info`; `psycopg.errors.CheckViolation` in `test_iss298_autonomy.py:144-148`, `test_iss64_autonomy_override.py:245-250` → `sqlite3.IntegrityError`; `test_e2e_terminal_smoke.py:35,87` raw psycopg → `database` helpers; `test_iss76_restart_policies.py`, `test_iss294_secret_key_provenance.py:84-88` → keep only while the compose template exists, delete in the cleanup PR.
- The 69 test files that use no DB fixture finally run without any database server (they still import `main`, which now opens a temp file).

CI (`.github/workflows/test.yml`): during S1–S2 add a second `pytest` job with `ORCHA_TEST_BACKEND=sqlite` and no service container (allowed to fail until S3); at S3 make it required and delete the Postgres job **in the cleanup PR**, not before. Keep `--cov-fail-under=70` on one leg and extend `--cov` to `portal_backend` (today it measures only `main.py`, 239 lines). Size: 3–4 days.

### S7. Backup / restore (PR S7, small)

- `orcha backup [--out PATH]` → `VACUUM INTO '<project>/.orcha/backups/orcha-<UTC ts>.db'` through a fresh connection (works while `orcha serve` runs; the target must not exist — Appendix B). Prune to the last 10 by default.
- `orcha restore <file>` → refuse while `orcha serve` is running; copy the file over `orcha.db`, delete `-wal`/`-shm`, run `PRAGMA integrity_check`.
- Document in `docs/orcha-test-runbook.md` and the BYOC guide (replaces the `pg_dump`/`pg_restore` sections). Size: 1 day.

### S8. Response-shape parity test (PR S8 — write it FIRST, before S2, and keep it through cutover)

The single most valuable guard in this workstream. `tests/test_dialect_parity.py`: drive one fixed scenario through the API (create container, two agents, three tasks with dependencies, a request chain with an answer, a conversation turn, a worker run with tokens, a task message with an attachment, a wake-scan, a claim, a done → needs_verification), then `GET` ~25 endpoints (`/api/containers/{cid}`, `/tasks`, `/requests`, `/agents/{aid}/inbox|outbox|notifications|digest`, `/wake-scan`, `/metrics`, `/token-usage`, `/api/tasks/{tid}/messages`, …) and record a **type tree** of each response (`{"tasks": [{"id": "str", "created_at": "iso-datetime", "priority": "int", "is_root": "bool", "result": "null|dict", …}]}`) plus the values of every boolean and every datetime. Store the Postgres recording as a committed JSON fixture (`tests/fixtures/parity_postgres.json`) while both engines exist; on SQLite assert equality of the type tree and of all boolean values. This is what catches: `EXISTS(...)`/`bool` expression columns coming back as `0/1` (iOS decodes `Bool` strictly and will fail on `1`), JSON aggregate aliases coming back as strings, `Decimal` → `float`, and any datetime that lost its `+00:00`. Size: 2 days. After cutover it stays as a regression fixture (regenerate the fixture from SQLite once).

### S9. Cleanup (PR S9, one release after cutover)

Delete `psycopg` from `requirements.txt`/`tests/requirements.txt`, the `postgres` branches in `sql.py` and `DIALECT`, `templates/migrations/*.sql` (Postgres) and `tests/test_schema_parity.py`, the Postgres CI job, the `pg_restore` docs; optionally the `%s` → `?` sweep (446 sites, purely mechanical; run the full suite and the parity test). Size: 1–2 days.

**Workstream S total: ~22–26 days.**

---
## Part 5 — Workstream R: native runtime in the CLI (`orcha serve`, state file, supervision)

This workstream removes Docker from the local path. It is independent of Workstream S until R2 (which wants a database that needs no server) and can start the day S0 is agreed. Everything here is `orcha-cli/orcha_cli/`; paths below are relative to that directory unless they start with `tests/`, `desktop/` or `deploy/`.

### R0. Ground truth (what the CLI does today)

| fact | evidence |
|---|---|
| The only Docker call sites in the CLI are: one compose wrapper, the `docker ps` discovery, the sandbox runner, and the runner image build | `cli_project_setup.py:289` (`docker compose -f .orcha/docker-compose.yml …`); `cli_stacks.py:15,72,80` (`docker ps`, `docker compose -p`, `docker ps -a --filter label=`); `sandbox.py:210,276,293` (`docker run`, `_docker()`, `preflight`); `cli_sandbox.py:53` (`docker build`) |
| Callers of the compose wrapper | `cli_init.py:131,135` (`down -v` on `--reset-data`, `up -d --build`), `cli_project_commands.py:25,71,169` (`up -d`, `down [-v]`, `up -d --build` in `upgrade`), `cli_status.py:28` (`ps`) |
| "This folder is an Orcha project" means `.orcha/docker-compose.yml` exists | `cli_project_commands.py:20,66,105`, `cli_update.py:141`, `cli_status.py:27`, `desktop/src/main/folderModes.ts:8`; the sandbox derives its network from that file's `name:` line, `sandbox.py:107-117` |
| `orcha init` sequence | render compose `cli_init.py:68-78`; copy `migrations/` + `portal/` + 13 shared modules `:80-83` (`cli_project_facade.py:28-42,93-98`); skills `:86`; prefs `:91`; write `.claude/orcha.json` `{api_base_url, project_name, api_port, db_port, bridge_port[, github_repo]}` `:102-115`; hooks `:119`; `compose up -d --build` `:135`; wait for `GET /` `:139` (`cli_http.py:15-29`); `POST /api/containers` `:152`; GitHub bind `:177`; first human `:206`; notifier `:244`; bridge `:250`; report prints a Postgres URL `:258` |
| Ports are picked by binding `127.0.0.1` from 5432/8000/8765 | `cli_project_setup.py:56-65`, `cli_init.py:46-52` |
| The secret-box key is generated into `.orcha/.env` (0600) by the compose wrapper on every `up`, and the daemon loads it from that file | `cli_project_setup.py:134-161,274-288`, `cli_env.py:32-57`, `notifier_command.py:38` → `notifier_wake_facade.py:26` |
| `.orcha/.env` is otherwise only read by compose interpolation (`${VAR:-}`); the shell env outranks it | `templates/docker-compose.yml.j2:37-79`, `cli_project_setup.py:206-233` |
| Notifier daemon = detached `Popen(start_new_session=True)` of `orcha notifier --quiet --container <cid>` (or `python -m orcha_cli …` when `orcha` is not on PATH); pidfile + log under `.claude/`, machine-wide claim under `~/.orcha/` | `notifier_daemon_control.py:153-193`, `notifier_daemon_registry.py:10-15,175-187` |
| The daemon loop itself writes its pidfile, the container claim and a heartbeat every pass (so a daemon started by *anything* is visible to `--ensure`), exits on SIGTERM/SIGINT, and self-terminates when its container 404s | `notifier_command.py:130-139,173,184-190,245-265`; heartbeat staleness 120 s `notifier_daemon_registry.py:26,43-52` |
| `--ensure` is skipped inside managed embodiments (`ORCHA_HEADLESS_WORKER`, `ORCHA_LIVE`) | `notifier_command.py:55-65`, `terminal_bridge_daemon.py:54` |
| Terminal bridge = same detached pattern, but its pidfile is written only by `ensure_bridge`, not by the server loop | `terminal_bridge_daemon.py:50-95` (`:92` writes the pid), `terminal_bridge.py:146-163` (`serve_bridge`) |
| SessionStart hooks re-ensure both daemons whenever a human opens Claude Code in the folder | `cli_hooks.py:17-31` |
| `orcha upgrade` = re-render compose, re-copy templates, `compose up -d --build`; guarded against downgrades by comparing migration tips of the package vs `.orcha/migrations` | `cli_project_commands.py:92-187`, `cli_project_setup.py:68-86` |
| `orcha update` = self-update (editable → `uv tool install --reinstall`, brew keg → `brew upgrade`), then `upgrade`, then restart daemons | `cli_update.py:15-77,128-183` |
| `orcha ls`/`connect` discover stacks with `docker ps` and read ports from the published-port strings | `cli_stacks.py:11-56`, `cli_status.py:39-80`, `cli_connect.py:42-56` |
| The CLI has one runtime dependency; the portal needs five more (plus `git` on PATH for `local_git`) | `orcha-cli/pyproject.toml:12`; `templates/portal/requirements.txt:1-5`; `templates/portal/Dockerfile:7-9,17` |
| The portal already imports its shared modules from the installed CLI when the copies are absent | `templates/portal/main.py:89-101` |
| The two container-only defaults | `portal_backend/database.py:12` (`/app/migrations`), `portal_backend/attachment_config.py:6` + `main.py:104` (`/app/orcha-attachments`) |
| The portal reads 20 env vars; compose sets 14 of them | Appendix C |
| Existing OS-level supervisor (Linux box only) | `deploy/orcha-notifier@.service:7-9,24-26` (`Type=simple`, `EnvironmentFile=-/root/.orcha-daemon-env`, `WorkingDirectory=/opt/orcha-work/%i`, `ExecStart=/root/.local/bin/orcha notifier --quiet`, `Restart=on-failure`, `RestartSec=10`) |

### Decisions specific to this workstream

| # | decision | rationale |
|---|---|---|
| **R-D1** | **Native mode runs the portal from the installed `orcha_cli` package** (`importlib.resources.files("orcha_cli") / "templates" / "portal"`), never from `.orcha/portal/`. `orcha init --runtime native` does not copy `portal/`, `migrations/` or the 13 shared modules. The downgrade guard compares the DB's highest applied migration with the package's, and `orcha serve` refuses to start an older package against a newer schema unless `--allow-downgrade`. | The per-project copy exists only to feed `docker build`. Running the copy under the CLI's interpreter would let code and dependencies skew (a project copied by CLI 0.7 running on a 0.6 sidecar). One version per machine is also the simplest story for the target user. The guard's purpose (`cli_project_commands.py:113-118`) is preserved with a better source of truth. |
| **R-D2** | **Every child `orcha serve` spawns runs as `[sys.executable, "-m", "orcha_cli", …]`**, not `shutil.which("orcha")`. | The desktop sidecar's `orcha` is not on PATH; the interpreter that runs `serve` is by definition the right one. `ensure_daemon` already has this fallback (`notifier_daemon_control.py:153-164`); make it the rule. |
| **R-D3** | **The portal binds `127.0.0.1` by default; `bind: "lan"` in `orcha.json` (set by the pairing screen / `orcha pair --lan`) rebinds to `0.0.0.0`.** | Docker publishes on all interfaces today, so the LAN exposure is inherited, not designed. On macOS a `0.0.0.0` bind by a host process triggers the "accept incoming connections?" firewall prompt at first launch, which is exactly the kind of dialog the target user must not see on day one. Mobile pairing needs the LAN bind (`portal_backend/container_pairing_routes.py:59-93` derives the QR from the request host); it stays one toggle away. **Owner question Q-F** below. |
| **R-D4** | **`runtime` is read from `orcha.json`; absent key + `.orcha/docker-compose.yml` present ⇒ `"docker"`; otherwise `"native"`.** Every `docker-compose.yml`-exists gate goes through one function. The Docker branch is left byte-for-byte alone until the cleanup PR. | Zero behaviour change for existing stacks (spike Q5.1); one place to delete later. |
| **R-D5** | **`orcha serve` is a plain foreground supervisor; uptime is owned by launchd / systemd (R3). `orcha up` = "make sure `serve` is running", `orcha down` = "stop it (keep data)", `orcha down -v` = "stop it and delete the database file"** (same verbs, same meanings as today). | Keeps every existing entry point (`up`, hooks, desktop) valid. Spike Q4.3. |

Owner questions raised here (answer before R2): **Q-F** loopback-by-default with a LAN toggle (plan) vs. all-interfaces like Docker today. **Q-G** `orcha serve` log retention: 5 × 10 MB per child (plan).

### R1. `orcha portal` — the portal as a host process (PR R1; the concrete first PR; Postgres still in Docker)

Behaviour-neutral for every existing stack; gives the portal the CLI's runtime, which every later step assumes.

1. **Dependencies.** `orcha-cli/pyproject.toml:12` → `dependencies = ["websockets>=12", "fastapi>=0.110", "uvicorn[standard]>=0.30", "python-multipart>=0.0.9", "qrcode>=8", "psycopg[binary]>=3.1"]` (`psycopg` is removed in S9). Add the same five as `resource` blocks to `packaging/homebrew/orcha.rb.tmpl:20-23` (the formula pip-installs resources into its venv, `:26-29`); pin sha256s the way `websockets` is pinned. `templates/portal/requirements.txt` stays (the Docker image still builds from it until cleanup).
2. **New module `cli_portal.py`** (≤ 250 lines, the repo's file-size rule):
   ```python
   """`orcha portal`: run the packaged FastAPI portal in this interpreter (no container)."""
   def portal_dir() -> pathlib.Path:            # importlib.resources → real directory (wheels are unpacked; cli_update.py:18 already relies on this)
   def read_env_file(path) -> dict[str, str]     # every KEY=value line of .orcha/.env (generalises cli_env._read_env_file_value)
   def build_portal_env(project_root, cfg) -> dict:
       env = dict(os.environ)
       for k, v in read_env_file(project_root / ".orcha" / ".env").items(): env.setdefault(k, v)   # shell env outranks .env, like compose
       env.setdefault("DATABASE_URL", f"postgresql://orcha:orcha@localhost:{cfg['db_port']}/orcha")  # until S3; then ORCHA_DB_PATH
       env.setdefault("MIGRATIONS_DIR", str(PKG_TEMPLATES / "migrations"))                          # → templates/migrations/sqlite after S3
       env["ORCHA_ATTACHMENTS_DIR"] = str(project_root / ".claude" / ".orcha-attachments")
       env["ORCHA_TERMINAL_WS_URL"] = f"ws://127.0.0.1:{cfg['bridge_port']}"
       env["ORCHA_GITHUB_TOKEN_FILE"] = str(project_root / ".orcha" / "github-token")
       env["ORCHA_GITHUB_TOKENS_FILE"] = str(project_root / ".orcha" / "github-tokens.json")
       env["ORCHA_LOCAL_REPO_DIR"] = str(project_root); env["ORCHA_LOCAL_REPO_NAME"] = cfg["project_name"]
       # ORCHA_SECRET_KEY / ORCHA_PAIRING_HOST / ORCHA_GITHUB_PAT: reuse the exact pre-`up` prep compose does today
       return env
   def cmd_portal(args):
       cfg = load orcha.json; env = build_portal_env(...)
       cli_project_setup.ensure_secret_key(...); export_pairing_host(...); export_gh_token()     # cli_project_setup.py:134-161,224-262
       os.environ.update(env); sys.path.insert(0, str(portal_dir())); os.chdir(portal_dir())      # main.py resolves static/ relative to itself
       import uvicorn; uvicorn.run("main:app", host=args.host or bind_host(cfg), port=args.port or cfg["api_port"],
                                   proxy_headers=True, forwarded_allow_ips="127.0.0.1", log_level="info")
   ```
   The `git` binary must be on PATH (the Dockerfile installs it for `portal_backend.local_git`, `Dockerfile:3-9`); `cmd_portal` warns once if `shutil.which("git")` is None (Code Space browse degrades, nothing crashes).
3. **Container-only defaults become project-relative.** `portal_backend/database.py:12` → `MIGRATIONS_DIR` default = the package's migrations dir (computed from `__file__`, as the S3 sketch does); `portal_backend/attachment_config.py:6` + `main.py:104` → default `pathlib.Path.cwd().parent / ".claude" / ".orcha-attachments"` is wrong for the package layout, so keep the env var mandatory and make the *default* `tempfile.gettempdir()/orcha-attachments` with a startup warning (the compose template and `cli_portal` always set it). Drop `ORCHA_WAKES_DIR` from the compose template (set, never read — Appendix C).
4. **Parser + facade.** Register `portal` in `cli_parser_runtime.py` (`--host`, `--port`, `--project-dir`), handler in `__main__.py:63-91`'s dict; keep the 250-line ceiling by putting the parser lines next to `terminal-bridge` (`cli_parser_runtime.py:125-149`).
5. **CI.** In `.github/workflows/test.yml` add a step after the unit suite: `pip install -e orcha-cli && (cd /tmp && orcha portal --project-dir $GITHUB_WORKSPACE/tests/fixtures/native-project --port 8123 &) && curl --retry 20 --retry-connrefused http://127.0.0.1:8123/ && pytest -m smoke` with `DATABASE_URL` pointing at the job's Postgres service (`test.yml:24-41`). The fixture project is a directory with `.claude/orcha.json` + `.orcha/.env` only.
6. **Tests** (`tests/test_cli_portal.py`): `build_portal_env` precedence (shell > `.env` > derived), every key in Appendix C's "native value" column present, `--host` default `127.0.0.1`, `bind: "lan"` → `0.0.0.0`; `portal_dir()` contains `main.py` and `static/dist/index.html`; `orcha portal --help` renders. The uvicorn call is monkeypatched.

Size: **2–3 days.** Acceptance: a developer with the Docker stack running can `docker compose stop portal && orcha portal` and use the same UI at the same port with no behaviour change; CI smoke job green.

### R2. `runtime` key, `orcha serve`, and dual-mode `up/down/status/logs` (PR R2)

**New module `cli_runtime_mode.py`:**
```python
def detect_runtime(project_root) -> str:            # "native" | "docker" (R-D4)
def is_project(project_root) -> bool:               # orcha.json exists AND (runtime native OR compose file exists)
def db_path(project_root, cfg) -> pathlib.Path      # cfg.get("db_path") or ".orcha/orcha.db"
```
Replace the five `docker-compose.yml`-exists gates (R0) with `is_project()`; `cmd_up/down/status` branch on `detect_runtime()`; the Docker branch keeps calling `_compose` unchanged.

**New module `cli_serve.py` — the supervisor** (foreground; `orcha serve [--project-dir P] [--no-bridge]`):
```python
CHILDREN = (  # name, argv (R-D2), health
  ("portal",   [sys.executable, "-m", "orcha_cli", "portal", "--project-dir", P],               http_ok(f"http://127.0.0.1:{api_port}/")),
  ("notifier", [sys.executable, "-m", "orcha_cli", "notifier", "--quiet", "--container", cid],  heartbeat_fresh(P)),   # notifier_daemon_registry.py:43-52
  ("bridge",   [sys.executable, "-m", "orcha_cli", "terminal-bridge", "--quiet", "--port", bp], tcp_open(bp)),
)
```
- **Order and gating:** start `portal`, wait for `GET /` (≤ 30 s, same poll as `cli_http._wait_for_portal`), then start `notifier` and `bridge`. The notifier already refuses to start when the container is missing and tolerates "unreachable" briefly (`notifier_command.py:101-116`), so a portal restart does not kill it.
- **Restart policy:** on child exit, restart after `min(30, 1 * 2**n)` seconds; reset `n` after 60 s of uptime; after 10 restarts in 10 minutes, mark the child `crashlooping` in `state.json` and keep trying every 60 s (never give up silently; the UI reads the state).
- **Env:** children inherit `build_portal_env()` (R1) so the notifier gets `ORCHA_SECRET_KEY` the same way `orcha up` gives it today (`notifier_command.py:35-38` still works as a fallback). Scrub nothing here; the desktop app scrubs its own env before invoking `orcha` (`desktop/src/main/hostWorker.ts:69-77`).
- **Logs:** each child's stdout/stderr is a pipe drained by a thread into `logging.handlers.RotatingFileHandler(".orcha/logs/<child>.log", maxBytes=10*2**20, backupCount=5)`; `serve` itself logs to `.orcha/logs/serve.log`. `orcha logs [-f] [portal|notifier|bridge|serve]` tails them. The notifier's existing `.claude/.orcha-notifier.log` (`notifier_daemon_registry.py:14-15`) stays for hook-started daemons only.
- **State file `.orcha/state.json`** (atomic write via temp + `os.replace`, the pattern `cli_sandbox.py:99-103` uses): `{"runtime":"native","serve_pid":…,"children":{"portal":{"pid":…,"status":"running|restarting|crashlooping","restarts":n,"last_exit":…}},"api_port":…,"bridge_port":…,"bind":"loopback","started_at":iso,"cli_version":…,"db_path":…}`. Re-written on every child transition and every 30 s (mtime doubles as a liveness stamp).
- **Signals:** SIGTERM/SIGINT → SIGTERM to each child, wait ≤ 8 s, SIGKILL (the exact escalation `notifier_daemon_control.py:8-37` implements; reuse it). `serve` exits 0 after the children are gone and removes `state.json`'s pids (keeps the file with `"status":"stopped"`).
- **Contracts with the existing daemon files (important):**
  - The notifier child writes its own pidfile, container claim and heartbeat in its loop (`notifier_command.py:134-139,173`), so the `SessionStart` hook's `orcha notifier --ensure` (`cli_hooks.py:28`) sees "already running" and is a no-op. If the hook ever judges it wedged (stale heartbeat) and kills it (`notifier_daemon_registry.py:150-172`), `serve` restarts it: the two mechanisms compose.
  - The bridge child must write `.claude/.orcha-terminal-bridge.pid` itself when started without `--ensure`: add that one line to `cli_bridge.terminal_bridge_command` (today only `ensure_bridge` writes it, `terminal_bridge_daemon.py:92`); otherwise the hook's `terminal-bridge --ensure` would start a second bridge on a busy port.
  - `ensure_daemon`/`ensure_bridge` are still called by `cmd_up`/`cmd_init`/`cmd_upgrade` (`cli_project_commands.py:32,37,171,184`); under native runtime `cmd_up` skips them (serve owns the children) and `cmd_init` never calls them.
- **Machine-wide registry `~/.orcha/stacks.json`** `{ "<project_name>": {"path": P, "api_port": …, "bridge_port": …, "runtime": "native", "cli_version": …, "updated_at": iso} }`, written by `serve` on start under an `fcntl.flock` on `~/.orcha/stacks.lock`, entry removed by `orcha down`. `orcha ls` reads it, validates each entry (`state.json` mtime < 90 s **and** `GET /api/containers` answers), prunes dead ones, and merges the Docker list from `cli_stacks.discover_stacks()` only when `docker` is on PATH (never `sys.exit` on a missing docker as `cli_stacks.py:24-25` does today). `orcha connect <name>` resolves from the same merged list (`cli_connect.py:42`).
- **`orcha up` (native):** if `state.json` says running and the portal answers → print status; else if a service unit is installed (R3) → `launchctl kickstart -k gui/$UID/io.openorcha.<project>` / `systemctl --user restart orcha-<project>`; else spawn `orcha serve` detached exactly like `ensure_daemon` (`Popen(start_new_session=True)`, log to `.orcha/logs/serve.log`), then wait for the portal. **`orcha down`:** unit → `launchctl bootout` / `systemctl --user stop`; else SIGTERM `serve_pid` from `state.json` and wait. **`down -v`:** additionally delete `orcha.db`, `-wal`, `-shm` after an interactive `y/N` (non-TTY: require `--yes`), mirroring the destructive-flag rule of `cli_init.py:121-131`. **`orcha status`:** prints runtime, bind, ports, child pids/status, DB path + size, log paths; Docker branch unchanged (`cli_status.py:11-36`).
- **`orcha init --runtime native|docker`** (default still `docker` in this PR; flips in R3): native path = ports (api, bridge; no db port), write `orcha.json` with `runtime`, `db_path`, `bind: "loopback"`, `ensure_secret_key`, skills + prefs + hooks as today (`cli_init.py:86-119`), start via `cmd_up`, then the unchanged API bootstrap (`:141-223`). The report block prints the DB path instead of a Postgres URL (`:258`).
- **`orcha upgrade`/`update` (native):** no compose, no copying; `update` = self-update, hooks refresh (`cli_project_commands.py:164-167`), then `orcha up` (which restarts `serve` under the new package). The DB-tip guard replaces the template-tip guard (R-D1): read `max(version) FROM schema_migrations` through the running portal (`GET /api/admin/migrations`, a tiny new read-only route next to `POST /api/admin/migrate`, `application_lifecycle.py:110-117`) or, when the portal is down, straight from the SQLite file.

**Tests** (`tests/test_cli_serve.py`, `tests/test_cli_runtime_mode.py`, `tests/test_cli_up_down_native.py`): supervisor with fake children (`python -c "import time,sys; time.sleep(...); sys.exit(3)"`) proves restart + backoff + crashloop marking + SIGTERM fan-out + `state.json` shape; `detect_runtime` truth table; `up/down/status` dispatch with the compose wrapper monkeypatched to assert it is *never* called in native mode; registry lock + prune; `ls` with docker absent. The existing CLI tests that stub the compose call keep passing because the Docker branch is untouched (`tests/test_iss76_restart_policies.py`, `tests/test_iss294_secret_key_provenance.py:84-88`).

Size: **5–6 days.** Acceptance: `orcha init --runtime native` on a machine with no Docker binary produces a working portal, notifier and bridge; `kill -9` of the portal child is healed within 5 s; `orcha down && orcha up` round-trips; `orcha ls` lists it with no `docker` on PATH.

### R3. OS supervision (`orcha service`), native by default, registry-backed discovery (PR R3)

**`orcha service install|uninstall|status [--project-dir P]`** (new `cli_service.py`):

macOS — `~/Library/LaunchAgents/io.openorcha.<project>.plist` (user agent, no admin rights, survives logout/reboot, runs whether or not the app is open):
```xml
<dict>
  <key>Label</key><string>io.openorcha.<project></string>
  <key>ProgramArguments</key><array><string>/abs/path/to/python</string><string>-m</string><string>orcha_cli</string><string>serve</string><string>--project-dir</string><string>/abs/project</string></array>
  <key>WorkingDirectory</key><string>/abs/project</string>
  <key>RunAtLoad</key><true/>  <key>KeepAlive</key><true/>  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/abs/project/.orcha/logs/launchd.log</string>  <key>StandardErrorPath</key><string>…/launchd.log</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>{captured}</string><key>HOME</key><string>…</string><key>LANG</key><string>en_US.UTF-8</string></dict>
</dict>
```
`ProgramArguments[0]` is `sys.executable` of the installing CLI (R-D2), which for the desktop sidecar is inside `Orcha.app` and for a `uv tool` install is the tool's venv interpreter. **PATH capture** is the one subtle part: launchd gives agents an almost empty PATH, and the notifier must find `claude`, `codex`, `git`, `gh`, `tmux`. Capture the user's login-shell PATH at install time with `$SHELL -ilc 'printf %s "$PATH"'` (the same trick the desktop app uses, `desktop/src/main/hostWorker.ts:45-58`), prepend `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, and store it in the plist; `orcha service install` re-runs on every `orcha up` so a later `claude` install is picked up. Load with `launchctl bootstrap gui/$UID <plist>`; stop with `launchctl bootout gui/$UID/<label>`; restart with `launchctl kickstart -k`.

Linux — `~/.config/systemd/user/orcha-<project>.service`, same shape as `deploy/orcha-notifier@.service:1-34` but `ExecStart=<python> -m orcha_cli serve --project-dir P`, `Restart=always`, `RestartSec=5`, `WantedBy=default.target`; `systemctl --user daemon-reload && enable --now`. Print (do not run) `loginctl enable-linger $USER` with a one-line explanation; without lingering the unit stops at logout, which is still better than today.

**Native becomes the default** for `orcha init` (`--runtime docker` remains for one release, with a deprecation line). `orcha init` calls `orcha service install` unless `--no-service`; the desktop app calls it at provision (Part 7).

**Tests** (`tests/test_cli_service.py`): golden-file rendering of the plist and the unit (PATH captured from a fake `$SHELL`), `launchctl`/`systemctl` argv asserted through a monkeypatched `subprocess.run`, `install` idempotent, `uninstall` removes the file and the registry entry, `status` reads `launchctl print` output fixtures.

Size: **3–4 days.** Acceptance: after `orcha init` on a fresh Mac user account, `sudo reboot` → log in → `orcha ls` shows the stack running and a task assigned in the portal wakes an agent without any terminal being opened.

### R4. Small follow-ups inside this workstream

- `orcha logs` (R2) and `orcha backup`/`restore` (S7) share the "is serve running" check.
- `orcha doctor`: one screen listing runtime, ports, unit status, `claude`/`codex`/`git` on the captured PATH, SQLite version (≥ 3.38 required, Q3.8), free disk, last 20 lines of each log. Half a day; worth it because it is what a non-engineer pastes into a bug report.
- The reaper's per-tick `docker info` (`notifier_orphan_cleanup.py:272` → `sandbox.py:399-404`) returns quickly when `docker` is absent (`_docker()` maps the `OSError` to rc 127, `sandbox.py:281-287`) but still costs a `subprocess.run` every 2 s; gate it on `sandbox.mode == "docker"` (Part 9).

**Workstream R total: ~11–14 days.** Windows is out of scope (as #251 states); nothing here precludes a later Windows service.

---
## Part 6 — Workstream M: migrating existing stacks (`pg_to_sqlite.py` + `orcha migrate-runtime`)

Who this is for: every stack that exists before the SQLite release (each holds its data in a Docker volume `orcha-<project>_pgdata`, `templates/docker-compose.yml.j2:15,122-123`). The dogfood stack on the maintainer's machine (portal 8004, db 5437, all 49 migrations applied) is the first conversion fixture. Hosted boxes are covered in Part 10 (their `orcha.json` has no `db_port`, so the converter must also accept an explicit URL).

### M0. Facts the design relies on

- Every stack publishes Postgres to the host with fixed credentials: `ports: ["{{ db_port }}:5432"]`, `POSTGRES_USER/PASSWORD/DB: orcha` (`docker-compose.yml.j2:10-13`), and `db_port` is in `.claude/orcha.json` (`cli_init.py:102-108`). The converter reads over TCP with `psycopg`; no `docker exec`, no `pg_dump` binary on the host.
- The sealing key for stored provider keys and PATs is `ORCHA_SECRET_KEY` in `.orcha/.env`, not in the database (`docker-compose.yml.j2:39-43`, `cli_project_setup.py:134-161`). The converter copies sealed rows byte for byte and never touches `.env`.
- Files that already live on the host and need no migration: `.claude/.orcha-attachments` (`docker-compose.yml.j2:95-101`), `.claude/.orcha-wakes` (`:91-94`), `.orcha/github-token` + `github-tokens.json` (`:102-111`), `.orcha/agent-home` (sandbox session state, `sandbox.py:171-174`), `.claude/orcha-tabs/*.json`.
- Schema facts for the converter (from `templates/migrations/`): 33 application tables + `schema_migrations`; three `BIGSERIAL` ids (`events.id` `001_init.sql:148`, `agent_events.id` `:187`, `agent_memory_digests.id` `:254`); epoch-float columns stay `REAL` (`agent_events.ts` `:192`, `agent_wake_state.delivered_ts` `:224`, `agent_memory_digests.snapshot_ts` `:257`, `worker_runs.conversation_ack_ts` `014:7`, `agent_notification_state.read_through_ts` `023:24`, `agent_wake_state.conv_delivered_ts` `030:34`); one `NUMERIC(14,6)` (`worker_runs.total_cost_usd`, `019:17`); the trigger `031:39-53` is replaced by the two SQLite triggers in the baseline (S3), so `worker_run_tasks` rows are copied as data, not regenerated.

### M1. `tools/db/pg_to_sqlite.py` — the converter (PR M1, lands with or right after S3)

Standalone script (also importable as `orcha_cli.db_convert` so `migrate-runtime` can call it without a subprocess), stdlib + `psycopg` only:

```
pg_to_sqlite.py --pg postgresql://orcha:orcha@localhost:5437/orcha --out /path/.orcha/orcha.db [--verify-sample 50] [--force]
```
1. Refuse if `--out` exists (unless `--force`, which renames it to `orcha.db.bak-<ts>`); create the file, apply `migrations/sqlite/001_baseline.sql` through `portal_backend.database.run_migrations` (so the converter and the portal agree on the schema by construction).
2. Read `information_schema.tables` (schema `public`, excluding `schema_migrations`), order tables by FK dependency (`pg_constraint` `contype='f'`; topological sort; cycles do not exist in this schema), and copy each with server-side cursors in batches of 1,000 rows via `executemany` into the SQLite file, inside one `BEGIN IMMEDIATE` per table, with `PRAGMA foreign_keys=OFF` for the load and `PRAGMA foreign_key_check` at the end (must be empty: Postgres enforced the same FKs).
3. Value mapping (one function, unit-tested): `uuid.UUID` → lowercase str (D8); `datetime` → `sql.ts()` canonical text (D3; naive values are treated as UTC, which is what `TIMESTAMPTZ` returns from psycopg anyway); `dict`/`list` (jsonb) → `json.dumps(..., separators=(",", ":"))`; `Decimal` → `float`; `bool` → int; `bytes` → BLOB (none expected); `None` → NULL.
4. `sqlite_sequence`: AUTOINCREMENT tables pick up `max(id)` automatically as rows are inserted; assert `seq >= max(id)` per table afterwards anyway.
5. Stamp `schema_migrations`: the baseline row plus all 49 Postgres file names (D10), copying `applied_at` values from the source so history is preserved.
6. Verify: per-table `count(*)` equality; `--verify-sample N` random rows per table compared field by field after normalising through the same mapping (datetimes compared as UTC instants, JSON compared as parsed objects); `PRAGMA integrity_check` = `ok`. Print a one-screen report (table, rows, seconds). Exit non-zero on any mismatch and delete the output file.
7. Performance expectation: the dogfood DB (~400 tasks, tens of thousands of `agent_events`/`worker_run_lines` rows) converts in seconds; a 1 GB box DB in minutes. Not a concern.

**Tests** (`tests/test_pg_to_sqlite.py`, runs only on the Postgres CI leg while it exists): seed the Postgres test DB through the API with the S8 scenario, convert to a temp file, then run the S8 parity GETs against a portal started on the converted file and assert the same type tree and the same boolean/datetime values as the Postgres recording. Unit tests for the value mapper (UUID case, microsecond timestamps, `Decimal("0.000123")`, nested JSON, JSON `null` vs SQL NULL).

Size: **2 days.**

### M2. `orcha migrate-runtime` (PR M2)

`orcha migrate-runtime [--pg-url URL] [--keep-docker-running] [--rollback] [--purge-docker] [--yes]` in a new `cli_migrate_runtime.py`:

Forward path (default):
1. Preconditions: `detect_runtime() == "docker"`; `docker compose ps` shows the `db` service running (else print exactly: "Your project's data is still inside Docker. Start Docker once, run `orcha up`, then run this command again."); the CLI's package carries `migrations/sqlite/001_baseline.sql`; `orcha.db` does not already exist (else stop and explain, never overwrite).
2. Quiesce writers: `stop_daemon(cwd)` + `stop_bridge(cwd)` (`cli_project_commands.py:47-56` already does this for `down`), then `docker compose stop portal` so browser/mobile clients cannot write during the copy. The `db` service stays up.
3. Convert with M1 into `.orcha/orcha.db.partial`, verify, then `os.replace` to `.orcha/orcha.db`.
4. `docker compose stop` (no `down`, no `-v`): containers and the `pgdata` volume stay as the rollback, untouched.
5. Rewrite `orcha.json`: `runtime: "native"`, `db_path`, `bind: "loopback"`, keep `db_port` renamed to `legacy_db_port` (needed by `--rollback`), keep everything else. Refresh hooks. `orcha service install` (unless `--no-service`), then `orcha up`, wait for the portal, `GET /api/containers` must return the same container id as `current_container_id`.
6. Print: where the data now lives, that the old Docker copy is still there, and the two follow-up commands (`--rollback`, `--purge-docker`).

`--rollback`: `orcha down` (native), set `runtime: "docker"`, restore `db_port`, `docker compose up -d`, `ensure_daemon`/`ensure_bridge`; the SQLite file is renamed to `orcha.db.rolled-back-<ts>` (never deleted).
`--purge-docker`: only when `runtime == "native"` and the portal answers on the SQLite file: `docker compose down -v --rmi local` (this is the one destructive step; interactive `y/N`, `--yes` for scripts), then delete `.orcha/docker-compose.yml`, `.orcha/portal/`, `.orcha/migrations/` (Postgres copies), and the `legacy_db_port` key. Registry entry updated.

`orcha up`/`orcha update` on a Docker-runtime project print a one-line nudge naming `orcha migrate-runtime` (spike Q5.1); nothing else changes for them until the cleanup release.

**Tests** (`tests/test_migrate_runtime.py`): the compose wrapper, `stop_daemon`, `stop_bridge`, the converter and `cmd_up` are monkeypatched; assert the exact call order above, that `-v` is never passed on the forward path, that a converter failure leaves `orcha.json` untouched and no `orcha.db` behind, that `--rollback` restores the previous `orcha.json` byte for byte except `runtime`, and that `--purge-docker` refuses while the SQLite portal is not answering.

Size: **2–3 days.**

### M3. Conversion of the offline cloud dump and the dogfood stack (task, not a PR)

- Dogfood: run M2 on the maintainer's stack first (it is the richest dataset: 400 tasks, requests, conversations, worker runs with tokens, attachments, Slack rows, Code Space threads). Keep the Docker volume until the next release. Any parity diff found here becomes a test in S8 before anyone else migrates.
- Offline `db.dump` (`docs/deploy-new-box-runbook.md:15-27`): restore into a throwaway `postgres:16` container, run M1, keep `orcha.db` next to the dump. Nothing live depends on it (Part 10).

**Workstream M total: ~5 days.** Support window: Docker-local stays supported for one release after native lands, deprecated the release after (spike Q5.1); the cleanup PR (S9) deletes the Docker branch of the CLI.

---
## Part 7 — Workstream D: desktop native mode + bundled sidecar

The Electron app (`desktop/`, v1.1.2) is where the non-engineer meets Orcha, and it is the most Docker-shaped code in the repo. Two structural facts drive the design:

1. **The app reimplements `orcha init` in TypeScript** (`desktop/src/main/initEngine.ts:88-282`: render compose `:135-139`, copy templates `:143-151`, write `.env` + `orcha.json` `:153-174`, `docker compose up -d --build` `:181-195`, wait `:198-216`, create container `:219-244`, register human `:247-262`, then `orcha up` via the host helper `:270-280` → `hostWorker.ts:159-163`). It also ships a byte-identical copy of the CLI templates (`desktop/scripts/copy-orcha-templates.mjs:12-52`, `electron-builder.yml:18-20`, parity test `templates.parity.test.ts:7-9,28`). The only reason for the duplication is that the app has no Python runtime of its own.
2. **Everything is keyed to Docker Compose:** stack identity = compose project name (`discovery.ts:35-76`, `lifecycle.ts:8`), project folder = the compose `working_dir` label (`discovery.ts:11-17`), "initialized" = `.orcha/docker-compose.yml` exists (`folderModes.ts:8`), free ports exclude Docker-published ones (`portPicker.ts:32-76`, `index.ts:271-280`), preflight = `docker info` + `open -a Docker` (`preflight.ts:12-58`), reset = `orcha down -v` + `docker compose down -v` + `docker rmi` (`resetEngine.ts:104-159`), and the tray/home/top bar poll `docker ps` every 5–15 s (`attentionPoller.ts:29,38`, `App.tsx:57`, `ProjectsHome.tsx:38-49`, `TrayPanel.tsx:25`).

Other facts that matter: the app never supervises daemons (it runs `orcha up` once, `initEngine.ts:270-276`; the README's claims at `desktop/README.md:31,44-46` are stale); the helper (`orcha`) is installed through Homebrew with an admin-privileged prefix fix-up (`installers.ts:43-72,103`, `index.ts:757-776` installs only that step); Claude Code is installed by the official script (`installers.ts:111-118`); PATH for Finder-launched processes is solved (`hostWorker.ts:21-58`); provider keys are scrubbed from the env before anything reaches `claude` (`hostWorker.ts:69-77`); packaging is hardened-runtime + notarized with entitlements that already permit a bundled interpreter (`electron-builder.yml:36-43`, `resources/entitlements.mac.plist:11-18`, `scripts/dist-mac-signed.sh:17-79`); builds are universal by default, arm64 on request (`package.json:8-22`); there is no auto-update. PR #247 (four-card source chooser, v1.1.3) is open on its own branch and not on `main`; GH #238's follow-ups #243–#246 are unaffected by this plan except #246 (health probe), which R2's `state.json` gives for free.

### Decisions

| # | decision | rationale |
|---|---|---|
| **D-D1** | **The app becomes a client of the CLI.** Provisioning, start/stop, reset, migration and service installation are `orcha` invocations; `initEngine.ts` and the template copy are deleted once the CLI does native init (R2/R3). | One implementation (#251 says the same). The TypeScript port only existed because the app had no runtime; after D3 it has one. |
| **D-D2** | **Discovery reads files, not `docker ps`:** `~/.orcha/stacks.json` for the list, each project's `.orcha/state.json` for pids/ports/health. Docker stacks are merged in only while a `docker` binary exists and at most every 15 s (the current cadence). | No subprocess per poll, works with no Docker, and is the same data `orcha ls` shows. |
| **D-D3** | **Sidecar:** `Orcha.app/Contents/Resources/orcha-runtime/` = `python-build-standalone` (install-only build) + site-packages with the CLI's dependencies + `orcha_cli`, plus a `bin/orcha` launcher. arm64 first (Q-D); Intel users get the uv-installed helper path. | Spike Q4.2(b): ≈85 MB uncompressed, entitlements already suffice, notarization is a build-time cost. |
| **D-D4** | **Uptime belongs to the OS unit (R3); the app installs it at provision and never becomes a supervisor.** Quitting the app never stops agents. | Spike Q4.3; matches the existing tray intent (`index.ts:968-971`). |
| **D-D5** | **Until D3 lands, the helper is installed with `uv`, not Homebrew:** `curl -LsSf https://astral.sh/uv/install.sh \| sh` then `uv tool install orcha-cli` (PyPI, Part 8) or `--from git+https://github.com/open-orcha/orcha#subdirectory=orcha-cli`. | Removes the admin-privileges step (`installers.ts:27-28,43-72`) and the Homebrew prerequisite from day one; the box already installs this way (`deploy/bootstrap-clone.sh:31-33`). |

### D1. Native-aware discovery, lifecycle, preflight (PR D1; needs R2)

- **New `desktop/src/main/nativeStacks.ts`:** `readRegistry()` (`~/.orcha/stacks.json`), `readState(folder)` (`.orcha/state.json`), `probe(apiPort)` (`GET /api/containers`, 1.5 s timeout), and `listNativeStacks(): Stack[]` mapping to the existing `Stack` shape (`desktop/src/shared/types.ts:10-26`: `project = "orcha-<name>"`, `projectShort`, `apiPort`, `dbPort: null`, `portalStatus: "Up (native)" | "Down"`, `running`, `folder`). Add `runtime: "native" | "docker"` and `health: "ok" | "starting" | "crashlooping" | "stopped"` to `Stack` (from `state.json`).
- **`discovery.ts`:** `listStacks()` = native list ∪ (docker list if `which docker` succeeds, cached 15 s); a Docker failure no longer throws `DOCKER_UNAVAILABLE` when there are native stacks (`discovery.ts:85`); it is reported as `dockerAvailable: false` on the result so the home screen can show a small "Docker projects hidden" note instead of the blocking `DockerDownBanner` (`ProjectsHome.tsx:91-94`).
- **`lifecycle.ts`:** `startStack`/`stopStack` for native = `orcha up` / `orcha down` with `cwd = folder` through the existing `execHost` path (`hostWorker.ts:159-163`); Docker branch unchanged.
- **`preflight.ts` + `PreflightStep.tsx`:** Docker is required only when the user chooses a Docker project (none can be created any more, so in practice: never). Requirements list (`PreflightStep.tsx:25-51`) becomes: **Claude Code or Codex** (unchanged copy, `:124`), **git** only for the GitHub source (`GithubSourceStep.tsx:97-98`), **Orcha helper** installed by the app (D-D5, later the sidecar). Homebrew and Docker rows are removed; `probePrereqs()` (`index.ts:147-160`) stops probing `brew`/`docker`.
- **`portPicker.ts`:** drop the Docker-published-ports pass when Docker is absent (`:32-35` already returns an empty set on failure; make absence a no-op rather than a failure path); the CLI picks ports anyway after D2, so this file shrinks to the `orcha init --api-port` fallback.
- **`installers.ts`:** replace the Homebrew step and the `brew tap … && brew install` helper step (`:43-72,103`) with the uv install (D-D5); delete the dead `colima` step (`:81`, filtered out at `index.ts:766`).
- **Tests to update** (the list in the desktop sweep, section 10): `discovery.test.ts:85-98`, `lifecycle.test.ts:8,14`, `preflight.test.ts:7-50`, `portPicker.test.ts:5-60`, `installers.test.ts:65-103`, `hostWorker.test.ts:83-111`, renderer mocks in `App.test.tsx:27-30`, `TrayPanel.test.tsx:33-36`, `OnboardingWizard.test.tsx:18-21`, `ProjectsHome.test.tsx:49,152-155`, `PreflightStep.test.tsx:24`. Add `nativeStacks.test.ts` with fixture `state.json`/`stacks.json` files.

Size: **4 days.**

### D2. Provision, migrate, reset through the CLI (PR D2; needs R3 + M2)

- **`orcha init --progress-json`** (small CLI addition in R3's PR or here): `orcha init` prints one JSON line per step `{"step":"ports|config|service|start|wait-portal|create-container|register-human|done","status":"start|ok|skip|error","detail":…}` on stdout when the flag is set; the app's `ProvisionStep.tsx:9-15` labels map 1:1 ("Render compose file" → "Write project settings", "Start containers" → "Start Orcha in the background", "Start the agent worker" stays).
- **`initEngine.ts`** shrinks to: pick the folder, run `orcha init --runtime native --progress-json --name <n> --objective <o> --as <alias> [--github <login> --git-email <e>]` with `cwd = folder`, stream progress to the renderer, parse the final `{"step":"done","api_port":…,"container_id":…}`. Modes: `init` (fresh), `upgrade` (existing native project → `orcha up`), and the new **`migrate`** (existing Docker project → `orcha migrate-runtime --yes`, shown as a "Move this project off Docker" card on the home screen for any stack with `runtime: "docker"`; the Docker-is-off case shows the exact "start Docker once" text from M2 and never provisions an empty database).
- **`folderModes.ts:8`:** `initialized` = `.claude/orcha.json` exists with `runtime` resolvable (call the same rule as `cli_runtime_mode.detect_runtime`; implement in TS, 10 lines, with a parity test against a fixture set shared with the CLI tests).
- **`resetEngine.ts`:** native path = `orcha down -v --yes` then the existing on-disk deletions (`resetEngine.ts:58-81`) plus `.orcha/state.json`, `.orcha/logs/`, and `orcha service uninstall`; the `docker compose down -v` / `docker rmi` steps (`:147-159`) run only for `runtime: "docker"`. `daemonCleanup.ts` stays as the belt-and-braces sweep (it matches on argv, `:23-48`, which is unchanged by R-D2 because `python -m orcha_cli notifier …` still contains `notifier` and `--container <cid>`).
- **Service unit:** provision calls `orcha service install` implicitly (R3 does it inside `init`); the home screen's start/stop toggle maps to `orcha up`/`orcha down`; a stopped unit shows "Orcha is stopped for this project" rather than "container exited".
- **Delete** `templates.ts`, `copy-orcha-templates.mjs`, `templates.parity.test.ts`, the `extraResources` template entry (`electron-builder.yml:18-20`) and the `pre*` hooks (`package.json:17-21`) once D3's sidecar carries the templates inside `orcha_cli` (until then the app still needs nothing from the templates because the CLI owns provisioning; the copy can go in this PR).

Size: **4 days.**

### D3. Bundled sidecar (PR D3; needs Part 8's wheel or a git-installable CLI)

- **Build script `desktop/scripts/build-orcha-runtime.mjs`** (runs in `predist:*`): download the `python-build-standalone` `install_only` tarball for the target arch (pin the release URL + sha256 in the script), unpack to `desktop/resources/orcha-runtime/`, run its `python3 -m pip install --no-compile ../../orcha-cli` (+ the deps from R1's `pyproject.toml`), then `python3 -m compileall -q -j0` the site-packages, strip `test/`, `tkinter`, `idlelib`, `ensurepip`, `__pycache__` of the stdlib you do not ship, and write `bin/orcha`:
  ```sh
  #!/bin/sh
  HERE="$(cd "$(dirname "$0")/.." && pwd)"
  export PYTHONNOUSERSITE=1 PYTHONDONTWRITEBYTECODE=1 ORCHA_SIDECAR=1
  exec "$HERE/bin/python3" -m orcha_cli "$@"
  ```
  Expected size ≈ 85 MB uncompressed, ≈ 25–30 MB more DMG (spike Q4.2). Add `resources/orcha-runtime/` to `desktop/.gitignore` next to `resources/orcha-templates/` (`:6`).
- **electron-builder:** `extraResources: [{from: resources/orcha-runtime, to: orcha-runtime}]`; keep `hardenedRuntime`, `notarize: true` (`electron-builder.yml:36-43`). Verify on the first signed build that every nested Mach-O (`bin/python3`, `lib/libpython3.*.dylib`, ~100 `.so` files) is signed with the hardened-runtime flag; if electron-builder's walker skips `extraResources`, add a `codesign --force --options runtime --timestamp --sign "$IDENTITY"` loop over `orcha-runtime` in `scripts/dist-mac-signed.sh` **before** the app-level sign at `:44` (inner-most first). Notarization time roughly doubles; nothing else changes.
- **Arch:** ship `dist:mac:arm64` first (Q-D). On `process.arch === "x64"` the app uses the helper path (D-D5) and hides nothing else. A universal build later = two runtimes (+53 MB) or a fat-binary interpreter; decide when Intel demand is known.
- **Resolution order for `orcha` in the app** (`hostWorker.ts:126-138` today: `which orcha`): 1) `process.resourcesPath/orcha-runtime/bin/orcha` if present, 2) `~/.local/bin/orcha`, 3) `which orcha` on the host-tool PATH. The sidecar is preferred so the app and the runtime never skew.
- **`~/.local/bin/orcha` symlink** to the sidecar launcher, created on first launch when no `orcha` is on PATH (and refreshed when the app path changes), with a one-line note in Settings → "Command line: `orcha` is available in Terminal". This is what makes Homebrew optional for everyone.
- **`orcha update` inside the sidecar** (`ORCHA_SIDECAR=1`): prints "Update Orcha.app to update the command line" instead of trying `uv`/`brew` (`cli_update.py:98-125` already branches on install kind; add the sidecar branch first). An app update is a new sidecar; on launch the app runs `orcha up` for every registered native project so `serve` restarts under the new code and the portal applies pending migrations on startup (`application_lifecycle.py:71-107` semantics unchanged). The LaunchAgent's `ProgramArguments[0]` points into `/Applications/Orcha.app/...`, which is stable across updates; if the user relocates the app, `orcha up` re-installs the unit (R3).
- **macOS prompts the user will still see, and why they are acceptable:** Gatekeeper's first-open dialog (signed + notarized → a single "downloaded from the internet" confirmation, no right-click dance; `README.md:117-122` is stale on this); the firewall prompt only if they enable LAN pairing (R-D3); the Claude Code installer's own prompts.
- **Tests:** `build-orcha-runtime.mjs` has a dry-run mode asserted by a vitest (URL/sha pinned, launcher content); `hostWorker.test.ts` gains the resolution-order cases; a manual smoke checklist in `desktop/README.md` replaces the Docker one (`:49-62`).

Size: **6–8 days** (most of it is the first signed/notarized build and its verification).

### D4. Copy, docs, cleanup (PR D4)

- Remove `DockerDownBanner.tsx`, the Docker rows and links in `PreflightStep.tsx:8-13,25-51,122-127,228`, the Docker wording in `ConfirmResetModal.tsx:47-49`, `ProvisionStep.tsx:9-15`, `App.tsx:47`; `HelperMissingBanner.tsx` keeps its job for the Intel/helper path.
- `desktop/README.md`: rewrite "Onboarding" (`:28-47`), "Manual smoke tests" (`:49-62`), and the packaging notes (`:69-112`) for the sidecar; fix the stale "no `orcha` CLI" and "does not start daemons" claims (`:31,44-46`).
- Version bump to the next minor in the same PR as D3 (repo convention: bundle the bump with the feature).

Size: **2–3 days.**

**Workstream D total: ~16–19 days (≈ 3.5–4 weeks).** Milestone M2 (download-and-run) is reached at the end of D3.

---
## Part 8 — Workstream I: install path, packaging, docs

### I0. Ground truth

| fact | evidence |
|---|---|
| CI unit job needs a `postgres:16` service; Python 3.11; coverage gate is `--cov=main --cov-fail-under=70` (measures `main.py` only, 239 lines); a separate `frontend` job runs vitest + `npm run build` | `.github/workflows/test.yml:24-41,46-49,54-56,64-65,74-97` |
| `build-check.yml` builds the sdist/wheel and runs `orcha --version` from a venv, no services | `build-check.yml:15-35` |
| `publish.yml` fires on `cli-v*` tags on the self-hosted Mac, checks tag == `pyproject` version, needs a `## [X.Y.Z]` CHANGELOG section, attaches sdist+wheel to a GitHub Release, renders the Homebrew formula into the tap repo `open-orcha/homebrew-orcha`; **it does not publish to PyPI and does not build a DMG** | `publish.yml:4-12,26,48-53,76-80,89-96,105-118`; PyPI deferred in `docs/superpowers/specs/2026-06-11-homebrew-distribution-design.md:19-20,33,182` |
| The formula builds from the git tag with `python@3.13`, one `resource` (websockets), and carries the caveat "Docker Desktop … must be installed and running before `orcha init`" | `packaging/homebrew/orcha.rb.tmpl:10-14,17,20-23,26-29,34-36` |
| Install docs tell a new user: Docker is required; prerequisites are Docker, Python ≥ 3.10, Claude Code (+ Node for the app, Xcode for the widget); `brew install open-orcha/orcha/orcha`; the desktop DMG is "unsigned, right-click → Open" (stale: it is signed and notarized, `desktop/README.md:96-100`) | `README.md:62-66,70-76,84-87,98-100,104-108,117-122,136-141,153`; second prerequisites block `:546-551,562-570`; Docker troubleshooting `:739-798`; tech-stack table says "PostgreSQL 16 / Docker + Docker Compose / Vanilla HTML" `:50-53`; `orcha-cli/README.md:5-10`; `deploy/local/README.md:12-31` |
| CONTRIBUTING's release step tags `vX.Y.Z` but the workflow only fires on `cli-v*` | `CONTRIBUTING.md:65` vs `publish.yml:9` |
| Python versions in play: package ≥ 3.10, CI 3.11, image 3.12, formula 3.13; no lockfile anywhere | `orcha-cli/pyproject.toml:9`, `test.yml:46-49`, `templates/portal/Dockerfile:1`, `orcha.rb.tmpl:17` |
| Version is held in three places; the portal hardcodes an unrelated `version="0.6.0"` and exposes no version route | `pyproject.toml:3`, `orcha_cli/__init__.py:2`, `__main__.py:51-56`, `portal_backend/application.py:8` |
| The React bundle is committed and shipped in the wheel; nothing rebuilds it at install time | `.gitignore:13,268-270`, `pyproject.toml:40-45`, `frontend/README.md:24-25` |
| `orcha update` already knows three install kinds (editable source, brew keg, "packaged") | `cli_update.py:15-35,89-125` |

### Decisions

| # | decision | rationale |
|---|---|---|
| **I-D1** | **Primary CLI install becomes `uv tool install orcha-cli` from PyPI** (Trusted Publisher, as the Homebrew design spec's §10 already planned); Homebrew stays as a secondary path with the five portal deps added as resources. **Q-E.** | Zero admin rights, no Homebrew, a private interpreter, and it is how the desktop app installs the helper before the sidecar exists (D-D5) and how the box already installs (`deploy/bootstrap-clone.sh:31-33`). |
| **I-D2** | **Python floor stays 3.10; CI tests 3.11 and 3.13; the sidecar ships 3.12.** | Formula uses 3.13, sidecar mirrors the retired image's 3.12; testing both ends catches `sqlite3`/`datetime` differences (Python 3.11 added `fromisoformat` support for `+00:00` with microseconds; 3.10 needs the same input shape, which D3's canonical form satisfies — add a 3.10 leg only if a user reports one). |
| **I-D3** | **The portal reports the version that runs it:** `GET /api/version` → `{"cli_version", "schema_tip", "runtime", "python"}`; `application.py:8` takes its `version` from `importlib.metadata.version("orcha-cli")`. | Needed by `orcha ls`, `orcha doctor`, the desktop About box, and the R-D1 downgrade guard. |

### I1. PyPI + formula (PR I1)

- `publish.yml`: after the GitHub Release step, `pypa/gh-action-pypi-publish` with OIDC (`permissions: id-token: write`); register the project on PyPI with the repo as Trusted Publisher (one-time, owner action — **Q-H**: who owns the PyPI project name `orcha-cli`, and is the name free?). Keep the `cli-v*` trigger; fix `CONTRIBUTING.md:65` to `git tag cli-vX.Y.Z`. Remove the stale comment at `publish.yml:24-25`.
- `orcha.rb.tmpl`: five more `resource` blocks (sha256-pinned sdists of fastapi, starlette, pydantic, pydantic-core, uvicorn, h11, httptools, uvloop, websockets, python-multipart, qrcode, anyio, sniffio, idna, typing-extensions, annotated-types, click … ) — in practice generate them with `brew update-python-resources` from the wheel's metadata in `render_formula.py`, not by hand; drop the Docker caveat text `:34-36` when R3 lands.
- `build-check.yml`: also `pip install dist/*.whl && orcha portal --help` so a wheel that lost the portal deps fails the check.

Size: **1–2 days** (+ the PyPI registration by the owner).

### I2. Version route (PR I2, tiny)

`portal_backend/version_routes.py` with `GET /api/version`; `orcha --version` unchanged; `orcha status`/`ls`/`doctor` print it; desktop About box reads it. `application.py:8` → metadata version. Size: **0.5 day.**

### I3. Docs (PR I3, lands with R3)

- `README.md`: one install section — "Download Orcha.app" (macOS, arm64) or `uv tool install orcha-cli` (any OS with Python ≥ 3.10; `curl -LsSf https://astral.sh/uv/install.sh | sh` first); prerequisites table = Claude Code or Codex, git (optional, for GitHub-backed projects); delete the two Docker prerequisite blocks (`:62-66,546-551`), the Docker troubleshooting section (`:739-798` → move to `docs/legacy-docker-runtime.md` for one release), fix the tech-stack table (`:50-53`: SQLite, React), the DMG note (`:117-122`), and the first-run block (`:153`, `:586-597`: no "brings up docker").
- `orcha-cli/README.md:5-10`, `deploy/local/README.md:12-31`, `docs/orcha-test-runbook.md` §1–2 (no Postgres; `pytest` runs on a temp SQLite file; the "known pre-existing failures" list is re-baselined), `docs/sandbox-mode.md` (Part 9), `docs/byoc-guide.md` + `docs/deploy-new-box-runbook.md` (Part 10), `CHANGELOG.md` `[Unreleased]` → `### Changed` "Orcha runs without Docker or Postgres" + `### Deprecated` "Docker-local runtime (use `orcha migrate-runtime`)".
- `docs/orcha-project-preferences.md` template and the skills under `templates/skills/` are grepped for "docker compose" / "psql" hints and updated (`orcha-status`'s db-shell hint at `cli_status.py:34-35` becomes `orcha backup`).

Size: **2 days.**

### I4. Deprecation + cleanup (with S9)

Docker-local: nudge in `orcha up`/`update` (M2), README banner, CHANGELOG. Cleanup release: delete `templates/docker-compose.yml.j2`, `templates/portal/Dockerfile`, `templates/portal/requirements.txt`, the compose wrapper and `cli_stacks.py`, the Docker branches in `cli_project_commands.py`/`cli_status.py`/`cli_update.py`, the desktop Docker code left behind by D1–D4, `deploy/local/docker-compose.oauth.yml` (replaced by the host layout, Part 10). Size: **1 day** (counted in S9's 1–2 days).

**Workstream I total: ~4–5 days.**

---
## Part 9 — Workstream X: sandbox without Docker

Off the critical path: sandbox is opt-in (`sandbox.enabled` defaults to `false`, `sandbox.py:74`), so the non-engineer install never touches it. Two things change: the Docker sandbox must keep working when the portal is a host process (X2), and laptops get a Docker-free isolation mode built on the agent CLIs' own sandboxes (X1).

### X0. Ground truth

| fact | evidence |
|---|---|
| Sandbox wraps the already-built `claude -p …` / `codex exec …` argv in `docker run` at two spawn sites (one-shot and resident) after a preflight that **must** fail the wake if Docker is unavailable | `notifier_headless.py:166-249`, `notifier_resident_spawn.py:83-160`, `sandbox.py:8-9,290-309` |
| The container reaches the portal by compose service name: `api_base_url` is rewritten to `http://portal:8000` in a per-run config copy bind-mounted over `.claude/orcha.json`, and the container joins `<compose name>_default` | `sandbox.py:124-137,253-254`, network derived from the compose file's `name:` line `:107-117` (callers `notifier_headless.py:241`, `notifier_resident_spawn.py:149`) |
| Resource caps and the wall-clock deadline exist only for containers; the deadline is enforced by the reaper from `docker inspect` `StartedAt` | `sandbox.py:25-28,226-228,363-373`, `notifier_orphan_cleanup.py:160-178` |
| The reaper gates every sweep on `docker info`, even in host mode; a missing binary is mapped to rc 127 so the sweep just reconciles nothing | `notifier_orphan_cleanup.py:265-280`, `sandbox.py:281-287,399-404` |
| The box-wide concurrency cap counts live managed containers from `docker ps` | `sandbox.py:432-549`, `docs/sandbox-mode.md:70-112` |
| Config is the `sandbox` block of `orcha.json` with `enabled/image/memory/cpus/pids_limit/network/max_runtime_secs` | `sandbox.py:72-104`, `docs/sandbox-mode.md:54-68`; `orcha sandbox on|off|status|build-image` `cli_sandbox.py:40-105` |
| Secrets reach the container only through `-e KEY` passthrough of the daemon's env; interactive subscription login does not | `sandbox.py:55-62`, `docs/sandbox-mode.md:28-39` |
| Host-mode workers are spawned with `start_new_session=True` (own process group) and carry `ORCHA_HEADLESS_WORKER=1`; the reaper keys host liveness on `os.kill(pid, 0)` | `notifier_headless.py:261-292`, `notifier_command.py:202-221` |
| Codex host mode passes `--dangerously-bypass-approvals-and-sandbox`; Claude host mode passes `--dangerously-skip-permissions` unless the persona flags override | `notifier_headless.py:74-81,115-120` |

### Decisions

| # | decision | rationale |
|---|---|---|
| **X-D1** | **`sandbox.mode: "off" \| "claude" \| "docker"`** replaces the boolean; `enabled: true` with no `mode` maps to `"docker"` (back-compat), `orcha sandbox on` sets `"claude"` on laptops and prints what that means; `orcha sandbox on --docker` keeps the container path. | Spike Q5.3; #251 proposes the same key. |
| **X-D2** | **The Claude/Codex sandbox isolates files and network, not CPU/memory; the UI and docs say so plainly.** Substitutes: the existing per-agent single-flight lease + a host-mode wall-clock deadline (X1) and the stall watchdog (`--stall-secs`). | Seatbelt/bubblewrap have no cgroups. |
| **X-D3** | **Docker sandbox under a native portal reaches the host portal, not a compose service:** Linux → `--network host` (api_base unchanged, `127.0.0.1:<api_port>`); macOS/Windows Docker Desktop → `--add-host host.docker.internal:host-gateway` + api_base `http://host.docker.internal:<api_port>` **and** the portal bound to `0.0.0.0` (`bind: "lan"`), because a loopback-only bind is not reachable from the Desktop VM. Verified as the first task of X2, not assumed. | `portal:8000` cannot resolve without a compose network. Linux host networking is the smallest change and the box already accepts that the sandbox network is not an isolation boundary (`docs/byoc-guide.md:787-790`). |

### X1. Claude Code / Codex sandbox mode for host wakes (PR X1)

1. **Probe first (half a day, throwaway, in `/tmp`):** run `claude --settings '{"sandbox":{"enabled":true,"allowUnsandboxedCommands":false,"failIfUnavailable":true}}' -p 'curl -s http://127.0.0.1:<api_port>/api/containers'` from a project folder and record whether loopback egress is allowed by default, needs `network.allowedDomains: ["localhost"]`, or is blocked outright. Do the same for `codex exec --sandbox workspace-write` (+ its network config key). The result decides whether X1 ships as designed or needs a fallback (see 5). Pin the settings-schema keys used below against the installed `claude --version` in a unit test that reads `claude --help`/`--settings` acceptance once and caches it, the way `codex_supports_hook_trust_bypass` probes Codex (`notifier_headless.py:82-85`).
2. **`SandboxConfig` gains `mode`, `allowed_domains: list[str]`, `extra_write_paths: list[str]`** (`sandbox.py:72-104`); `orcha sandbox status` prints them (`cli_sandbox.py:61-94`); `on/off` write `mode` (`:96-105`).
3. **Spawn changes** (`notifier_headless.py`, `notifier_resident_spawn.py`): when `mode == "claude"`:
   - Claude runtime: append `--settings <json>` built by a new `sandbox_claude.settings_json(cfg, cwd, ws_root, project_root)`: `sandbox.enabled=true`, `allowUnsandboxedCommands=false`, `failIfUnavailable=true`, `filesystem.allowWrite=[cwd, ws_root/.orcha-worktrees, project/.claude/.orcha-wakes, project/.claude/.orcha-attachments, project/.orcha/agent-home, $TMPDIR]`, `filesystem.denyRead=[~/.ssh, ~/.aws, ~/.gnupg, ~/.config/gh/hosts.yml, ~/Library/Application Support/Google, ~/Library/Application Support/Firefox …]` (a fixed list in the module, documented), `network.allowedDomains=cfg.allowed_domains` (default: `api.anthropic.com`, `github.com`, `api.github.com`, `objects.githubusercontent.com`, `codeload.github.com`, `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, plus whatever the probe in 1 says loopback needs), `network.strictAllowlist=true`. `--dangerously-skip-permissions` stays (auto-allow is orthogonal to sandboxing).
   - Codex runtime: replace `--dangerously-bypass-approvals-and-sandbox` with `--sandbox workspace-write` and the flag Codex uses for non-interactive approval (`--full-auto` at the time of the spike; verify against the installed version like the trust-bypass probe does), keep `--skip-git-repo-check`.
   - The `repr_` strings (`notifier_headless.py:150-165`) gain ` [sandbox: claude]` so dry-run and wake records show the mode.
4. **Preflight for claude mode** (`sandbox_claude.preflight(cfg)` mirroring `sandbox.preflight`'s "return a reason or None" contract): the runtime executable resolves (`notifier_runtime.py:44-60`), the settings schema is accepted (cached probe), on Linux `bwrap` + `socat` are on PATH; on failure the wake fails loudly with the reason, exactly like Docker mode (never silently unsandboxed).
5. **Fallback if loopback is blocked** (only if the probe says so): run the skills' portal calls through a Unix socket that `serve` also listens on (`uvicorn --uds`), which the sandbox permits as a file write; the skills' `curl` lines already take a base URL, so `api_base_url` becomes `http+unix://…`. This is a real fork in the design, which is why the probe is step 1.
6. **Host-mode wall-clock deadline:** in the reaper's dead-pid sweep (`notifier_orphan_cleanup.py:202-221` → `reap_orphaned_runs`), for a `running` host row older than `max_runtime_secs` (`worker_runs.started_at`, `004_worker_runs.sql:15`) whose pid is alive: `os.killpg(pid, SIGTERM)` (the worker owns its process group, `notifier_headless.py:291`), then SIGKILL after 20 s, stamp `killed` with reason `max_runtime`. Applies to all host wakes, not only sandboxed ones; residents are exempt as in Docker mode (`:160-168`).
7. **Concurrency cap** (`sandbox.py:511-549`): in claude mode count `len(live_workers) + len(live_residents)` of this daemon (the box-wide Docker count has no equivalent; a laptop runs one daemon per project, which is fine) against `ORCHA_MAX_CONCURRENT_SANDBOXES` or a default of 4.
8. **Docs:** `docs/sandbox-mode.md` gets a "Which sandbox?" table (docker vs claude: isolation, caps, credentials — claude mode works with subscription login because the worker is the user's own `claude`), the domain allow-list, and the plain statement of X-D2.
9. **Tests** (`tests/test_sandbox_claude_mode.py`): mode mapping (`enabled:true` → docker; `mode:"claude"`), dry-run argv for both runtimes contains/omits the right flags, settings JSON golden file with the paths substituted, preflight reasons, the deadline sweep with a fake pid group, cap counting. No real `claude` needed.

Size: **3 days + the half-day probe.**

### X2. Docker sandbox under the native runtime (PR X2, with R2)

- `sandbox.compose_network()` returns `None` under native runtime (no compose file); `build_docker_argv` then applies X-D3: on Linux `--network host`; elsewhere `--add-host host.docker.internal:host-gateway` and `write_api_config` rewrites `api_base_url` to `http://host.docker.internal:<api_port>` (`sandbox.py:124-137`), with a preflight reason "enable LAN binding (`orcha pair --lan`) to use the Docker sandbox on macOS" when `bind` is `loopback`.
- The reaper's per-tick `docker info` (`notifier_orphan_cleanup.py:272`) runs only when `mode == "docker"` or a `sandbox_container_id` row exists (R4).
- The runner image is unchanged (`templates/runner/`, `orcha sandbox build-image`); it never contained Postgres.
- Tests: argv golden files for Linux vs macOS, api-config rewrite, the loopback preflight reason.

Size: **1 day.**

**Workstream X total: ~4.5 days.**

---
## Part 10 — Workstream C: Orcha Cloud / BYOC boxes

Status first: **the hosted deployment is decommissioned** (`README.md:19-24`, 2026-08-26; `docs/deploy-new-box-runbook.md:4-7`); what exists is an offline `db.dump` + secrets bundle and the runbook to rebuild. `docs/byoc-guide.md:9` still names the old host and `docs/orcha-cloud.md:20-22` still says the auth perimeter is "next up" (both stale). Nothing live has to be migrated; this workstream makes the *documented* box layout work on the native runtime so a rebuilt or customer box is not a second architecture.

### C0. Ground truth (how a box is wired today)

| fact | evidence |
|---|---|
| A box runs **one shared portal** for all projects; the provisioner never calls `orcha init` — it lists containers over HTTP from `http://127.0.0.1:8001` and writes each workspace's `orcha.json` with `api_base_url` + `current_container_id` and no ports | `deploy/provision-projects.sh:55,98-115,194-209`; registry `/opt/orcha-work/workspaces.list` `:57,211` |
| Each workspace gets its own notifier (systemd template unit or nohup `--ensure`) | `deploy/orcha-notifier@.service:7-9,24-26`, `provision-projects.sh:253-257` |
| The provisioner pins the sandbox network by `docker inspect` of the portal container | `provision-projects.sh:68-72` |
| Auth perimeter, containerised variant: Caddy + oauth2-proxy on the stack's Docker network, proxying to `portal:8000` | `deploy/auth/docker-compose.auth.yml:5-8,12-15,24,52-55`, `deploy/auth/Caddyfile:15,36,44,49,65,70,79`; portal port rebound to loopback by `deploy/auth/docker-compose.portal-local.yml:11-12` |
| Auth perimeter, host variant (the reference box): host systemd Caddy → `127.0.0.1:8001`, oauth2-proxy container published on `127.0.0.1:4180` | `docs/byoc-guide.md:9-11,481-488,495-549`, `deploy/auth/oauth2-proxy-host.yml:10-13`, `deploy/sync-members.sh:37-38` |
| Sandboxed wakes reach the portal as `portal:8000` on the compose network; the same network lets them reach `db:5432` (known gap) | `sandbox.py:132,253-254`, `docs/byoc-guide.md:223-225,787-790`, `deploy/README.md:244-245` |
| Timers and relays are HTTP-only against the portal; nothing on the box reads Postgres directly | `deploy/sync-members.sh:17-30`, `deploy/github-token-refresh.sh:95`, `deploy/push-forwarder.py:63,131,141,162`, `deploy/push-relay/relay.py:24-30,251` |
| Backups = `pg_dump` in a tarball; restore = `pg_restore` through `docker exec` | `docs/deploy-new-box-runbook.md:15-27,70-76`, `docs/byoc-guide.md:706-721` |
| Other Docker touchpoints in the runbook: `docker logs`, "rsync into `.orcha/portal/` + `docker compose build portal`", `orcha up` = compose + daemons | `deploy-new-box-runbook.md:67-68,110,122,134-135`; `byoc-guide.md:643-645,650-664`; `deploy/setup-github.py:109,189-190` (`--stack-network`) |

### Decisions

| # | decision | rationale |
|---|---|---|
| **C-D1** | **Cloud moves with the code, in the same release; a box runs one `orcha serve --no-notifier --no-bridge` for the shared portal, one SQLite file, and the per-workspace notifier units as today.** | Spike Q5.2: "cloud code = OSS code"; two dialects across 446 sites is the expensive path. The "one Postgres per project" wording in `byoc-guide.md:161-162` never matched the provisioner; the plan follows the code. |
| **C-D2** | **The host-Caddy layout is the only supported perimeter; the containerised Caddy compose file is deleted in the cleanup release.** | It already targets `127.0.0.1:8001` (`byoc-guide.md:495-549`); the containerised one only works with a compose network that no longer exists. |
| **C-D3** | **Docker stays on the box for the sandbox runner only**, with `--network host` (X-D3, Linux). | Multi-tenant boxes keep container isolation for agent processes; the portal gains nothing from a container. |
| **C-D4** | **One SQLite file per box is accepted, with a measured go/no-go.** Before the first box cutover, run the S3 slow-transaction log on the dogfood box for a week; if p99 write-lock wait exceeds 250 ms under the box's real agent count, split to one `orcha serve` per workspace (SQLite's natural shape) — the provisioner then calls `orcha init` per workspace, which the CLI supports anyway. | A box's write rate is small (notifier heartbeats are files, not rows; the DB sees wake-acks, events, run rows), but this is the one place the single-writer model meets many daemons, so it gets a number rather than an assumption. |

### C1. Box runtime (PR C1; needs R2, R3, S3)

- `orcha serve` gains `--no-notifier` / `--no-bridge` (the box's shared portal has no agents of its own; its notifiers are per-workspace units). Bind stays `127.0.0.1` (Caddy fronts it); `ORCHA_TRUST_PROXY_USER=1` and the other box env vars come from `.orcha/.env` of the portal project exactly as they came from the compose `.env` (`build_portal_env`, R1).
- New `deploy/orcha-portal.service` (system unit, `User=orcha`, `ExecStart=/opt/orcha/.venv/bin/python -m orcha_cli serve --no-notifier --no-bridge --project-dir /opt/orcha-portal`, `Restart=always`), replacing "the stack" in the runbook. `deploy/orcha-notifier@.service` drops `After=docker.service` (`:3`) and adds `After=orcha-portal.service`.
- `deploy/provision-projects.sh`: delete the network pin (`:68-72`), write `"sandbox": {"mode": "docker", "network": "host"}` instead of the compose network (`:194-209`), leave everything else. `deploy/setup-github.py` drops `--stack-network` (`:189-190`).
- `deploy/bootstrap-clone.sh` installs the CLI with `uv tool install` as today (`:31-33`) and no longer needs Docker for the portal; keep the Docker install step for the runner image.
- Backups: `deploy/orcha-backup.service` + `.timer` (daily) running `orcha backup --out /var/backups/orcha/orcha-<ts>.db` (S7, `VACUUM INTO`, safe online) with 14-day rotation; the runbook's restore becomes "stop the portal unit, copy the file into place, `PRAGMA integrity_check`, start" (S7's `orcha restore`).
- The offline `db.dump` is converted once (M3) so a rebuilt box starts from `orcha.db`.

Size: **2 days.**

### C2. Docs (PR C2, with I3)

`docs/byoc-guide.md`: topology (§"one Postgres per project" `:161-162` → one portal per box on SQLite), sandbox networking (`:223-225`), backups (`:706-721`), restart policies (`:650-664`), upgrades (`:643-645`), the security note on `db:5432` (`:787-790`, now moot), remove the decommissioned host at `:9`. `docs/deploy-new-box-runbook.md`: bundle contents (`:15-27`), restore (`:70-76`), logs (`:67-68,122` → `orcha logs`), code updates (`:134-135` → `uv tool upgrade orcha-cli && systemctl restart orcha-portal`), `orcha up` meaning (`:110`). `docs/orcha-cloud.md:20-22` status line. `deploy/README.md:244-245`.

Size: **1 day.**

### C3. Cleanup (with S9)

Delete `deploy/auth/docker-compose.auth.yml`, `deploy/auth/docker-compose.portal-local.yml`, `deploy/local/docker-compose.oauth.yml` + `deploy/local/up.sh`'s Docker check; keep `deploy/auth/Caddyfile` as the host-Caddy reference (already in the guide) and `oauth2-proxy-host.yml`.

**Workstream C total: ~3 days** (+ the C-D4 measurement week, which is wall-clock, not effort).

---
## Part 11 — PR sequence (the executable checklist)

This is the order to build in. Each entry names the workstream sections it implements (design lives there), what depends on it, the files, the tests that must exist before review, and the acceptance check. Sizes are engineer-days (±40%). Follow the repo's PR conventions for every one of them (`docs/orcha-review-protocol.md` §1): base `main`, title prefixed `[<author alias>]`, `NEEDS REVIEW` label, author `kedar1607`, local `N passed` count in the body, never self-merge. Version bumps ride in the PR that ships the user-visible change (repo convention). Tick the boxes in this file as PRs merge; nothing else in the repo tracks this sequence.

**Milestones**

| milestone | reached after | what a user can do |
|---|---|---|
| **M0 — portal is a host process** | PR 3 | `docker compose stop portal && orcha portal` serves the same UI; CI proves it |
| **M1 — no Docker for new CLI projects** | PR 10 | `orcha init` on a machine with no Docker binary → portal + notifier + bridge, surviving reboot |
| **M2 — download-and-run** | PR 16 | Orcha.app (arm64) provisions a project with no Homebrew, Docker or Python on the machine |
| **M3 — Docker retired** | PR 20 | one release after M1: Docker-local runtime deleted; `orcha migrate-runtime` was the bridge |

**Parallelism:** two tracks can run at once from day one — **storage** (PRs 1, 2, 4, 5, 7, 8, 11) and **runtime** (PRs 3, 6, 9, 10, 12). Desktop (14–16) waits for the runtime track; the cutover (7) is the only PR both tracks wait on. With one engineer, do them in the numbered order.

### Phase A — groundwork (no behaviour change; all three can be open at once)

#### PR 1 — API response parity recorder (S8) · 2 d · depends on: nothing
- [ ] `tests/test_dialect_parity.py`: the fixed scenario (container, 2 agents, 3 tasks with deps, request chain, conversation turn, worker run with tokens, task message with attachment, wake-scan, claim, done) and ~25 `GET`s; records a type tree + every boolean + every datetime.
- [ ] `tests/fixtures/parity_postgres.json` committed from a Postgres run; `--regen-parity` pytest option to rewrite it.
- [ ] Assertion mode compares the live run against the fixture (type tree equal, booleans equal, datetimes ISO with `+00:00`).
- [ ] Mutation check (runbook §6): temporarily make one route return `1` for a boolean → test red.
- Acceptance: green on Postgres; fixture reviewed by a human once (it is the contract).

#### PR 2 — `portal_backend/sql.py` + no-Postgres-syntax lint (S1) · 2 d · depends on: nothing
- [ ] `sql.py` as sketched in S1 (both dialects; `DIALECT` from `ORCHA_DB_DIALECT`, default `postgres`).
- [ ] `tests/test_sql_helpers.py`: every helper on both dialects (SQLite side on `:memory:`).
- [ ] `tests/test_no_postgres_syntax.py` with the full allow-list from Appendix A (`path:line` entries).
- Acceptance: pytest green on Postgres; lint passes with the allow-list; no route changed.

#### PR 3 — `orcha portal`: the portal as a host process (R1) · 2–3 d · depends on: nothing → **M0**
- [ ] `orcha-cli/pyproject.toml` deps (fastapi, uvicorn[standard], python-multipart, qrcode, psycopg[binary]); `packaging/homebrew/orcha.rb.tmpl` resources; `render_formula.py` generates them.
- [ ] `orcha_cli/cli_portal.py` (`portal_dir`, `read_env_file`, `build_portal_env`, `cmd_portal`), parser entry in `cli_parser_runtime.py`, handler in `__main__.py`.
- [ ] `portal_backend/database.py:12`, `attachment_config.py:6`, `main.py:104` defaults made package/project-relative; `ORCHA_WAKES_DIR` dropped from the compose template.
- [ ] `tests/test_cli_portal.py` (env precedence, Appendix C keys, bind default, `portal_dir()` contents, `--help`).
- [ ] `.github/workflows/test.yml`: smoke step that starts `orcha portal` against the job's Postgres and curls `/`; `tests/fixtures/native-project/` (orcha.json + .env only).
- Acceptance: on a dev machine with the Docker stack up, `docker compose stop portal && orcha portal` serves the same UI on the same port; CI smoke green.

### Phase B — port the SQL while still on Postgres

#### PR 4 — S2a: time windows, JSON casts, `= ANY` (S2) · 3 d · depends on: PR 1, PR 2
- [ ] The 20 `interval` + 10 `make_interval` sites → `sql.ago()/from_now()` bound params (list in S2 and Appendix A).
- [ ] The 7 `EXTRACT(EPOCH …)` sites → `sql.age_secs()`; `orphan_lease_routes.py:26` GREATEST operands COALESCE'd.
- [ ] The 16 JSON casts removed; `member_routes.py:250` `Jsonb()` → `sql.json_param()`; the four `'[]'::json(b)` SELECT defaults → `COALESCE(col, '[]')`.
- [ ] The 15 `= ANY(%s)` sites (two spelled `=ANY(`) → `sql.in_list()` + `sql.list_param()`.
- [ ] Allow-list entries for every ported site deleted from the lint.
- Acceptance: pytest green on Postgres; parity test byte-identical; lint green.

#### PR 5 — S2b: the one-off queries (S2) · 2–3 d · depends on: PR 4
- [ ] `json_build_object`/`json_agg` (12 + 3 sites) → `sql.json_object()`/ordered-subquery `json_array_agg`; `database.JSON_ALIASES` list started (fill from the aliases touched).
- [ ] `DISTINCT ON` (`code_space_routes.py:431-438`) → `ROW_NUMBER()`; `unnest … LATERAL` (`task_start_core.py:231-246`) → `json_each` + correlated subquery; `LEFT JOIN LATERAL` (`active_conversation_routes.py:139`) → two scalar subqueries.
- [ ] `LEFT(` (6) → `sql.left()`; `GREATEST(` (8) → `sql.greatest()` with COALESCE where nullable; `ILIKE` → `sql.ilike()`; `container_metrics_routes.py:180` boolean `->>` → `sql.json_bool_is_true()`.
- [ ] Booleans inside `json_object(...)` (e.g. `is_human` in `message_summary`) emitted as `json('true')`/`json('false')` on SQLite so they decode as `bool`, not `1/0` (Appendix B, probe g).
- Acceptance: as PR 4; lint allow-list now contains only the S3/S4 entries (`FOR UPDATE`, `SKIP LOCKED`, `%(name)s`, `psycopg`, `pg_advisory`, `to_regclass`).

#### PR 6 — runtime detection + `orcha serve` + dual-mode `up/down/status/logs` + registry (R2, X2) · 6–7 d · depends on: PR 3; **merge after PR 7**
- [ ] `cli_runtime_mode.py` (`detect_runtime`, `is_project`, `db_path`); the five compose-exists gates replaced.
- [ ] `cli_serve.py` supervisor (children, gating, backoff, crashloop marking, log rotation, `state.json`, signal fan-out), `cli_logs`.
- [ ] `~/.orcha/stacks.json` registry with `flock`; `orcha ls`/`connect` read it and merge Docker stacks only when `docker` exists.
- [ ] `orcha up/down/status` native branches; `orcha init --runtime native|docker` (default still docker here); bridge child writes its own pidfile.
- [ ] `GET /api/admin/migrations` read-only route (DB-tip guard input).
- [ ] X2: `sandbox.compose_network()` → `None` under native; `--network host` (Linux) / `host.docker.internal` (+ LAN-bind preflight reason) elsewhere; reaper's `docker info` gated on sandbox mode.
- [ ] `tests/test_cli_serve.py`, `test_cli_runtime_mode.py`, `test_cli_up_down_native.py`, sandbox argv golden files.
- Acceptance (needs SQLite, hence merge after PR 7): `orcha init --runtime native` with no `docker` on PATH → working portal/notifier/bridge; `kill -9` the portal child → healed < 5 s; `down`/`up` round-trip; `orcha ls` works without Docker. Develop on a branch in parallel with Phase B; rebase onto PR 7.

### Phase C — cutover (integration branch `sqlite-cutover`; four stacked PRs reviewed separately, merged to `main` as one merge when all are green)

#### PR 7a — SQLite baseline schema + generator + schema parity (S3 part 1, D10) · 2 d · depends on: PR 5
- [ ] `tools/db/gen_sqlite_baseline.py` (reads a migrated Postgres DB, applies the type map) → `orcha_cli/templates/migrations/sqlite/001_baseline.sql`, hand-reviewed (34 tables, 34 indexes, 2 triggers, stamps the 49 Postgres names).
- [ ] `tests/test_schema_parity.py` (Postgres via 49 files vs SQLite via baseline: columns/nullability/indexes/uniques/FKs).
- Acceptance: parity test green; baseline applies on `sqlite3` ≥ 3.38 with no warnings.

#### PR 7b — `database.py` on `sqlite3` + conftest on SQLite + long-transaction audit (S3 part 2, S6) · 6–7 d · depends on: PR 7a
- [ ] `portal_backend/database.py` replaced (adapters, `_dict_row` with `JSON_ALIASES`, thread-local `_conn`, `_translate`, `Cursor`/`Conn`, `db_cursor(readonly=)`, `ping`, statement-splitting `run_migrations`).
- [ ] `application_lifecycle.py:71-107` retry loop → `database.ping()`; the 5 `UniqueViolation` sites → `sql.is_unique_violation`; the 6 plain `FOR UPDATE` → `sql.for_update()`; `%(name)s` sites verified through `_translate`.
- [ ] Long-transaction audit of the 10 files listed in S3 note 4 (each either moves the slow call out of the scope or splits read/write scopes); `readonly=True` on the hot paths listed in note 5; `ORCHA_DB_ASSERT_READONLY=1` in tests.
- [ ] `tests/conftest.py`: `ORCHA_TEST_BACKEND` (default `sqlite`), temp-file DB, `run_migrations()` exercised, table list from `sqlite_master`, `db.ago()/from_now()` helpers; the 31 test files with raw `interval`/`make_interval`/`EXTRACT` ported; driver-specific tests (`to_regclass`, `information_schema`, `CheckViolation`, raw psycopg) ported per S6.
- [ ] `tests/test_database_sqlite.py`: nested scope joins the outer tx; commit-then-write re-begins; migration failure leaves `schema_migrations` untouched; readonly assertion; `%%` and `%(name)s` translation; `now()` UDF text shape.
- [ ] CI: `pytest-sqlite` job becomes required; `--cov` extended to `portal_backend`.
- Acceptance: full suite green on **both** backends; parity fixture (PR 1) matches on SQLite (type tree + booleans + datetimes); no slow-transaction log lines > 250 ms in the suite run.

#### PR 7c — task-claim rewrite + concurrency test (S4) · 1.5 d · depends on: PR 7b
- [ ] `agent_task_claim_routes.py:35-61` → single `UPDATE … WHERE id = (SELECT … LIMIT 1) RETURNING` inside `BEGIN IMMEDIATE`; `SKIP LOCKED` gone from the lint allow-list.
- [ ] `tests/test_task_claim_concurrency.py` (20 concurrent claims over 10 tasks; then 5 agents × 10 tasks): exactly one winner per task, no 5xx.
- Acceptance: the concurrency test green on SQLite 10× in a row (`pytest --count` via pytest-repeat, or a shell loop).

#### PR 7d — time-window boundary tests (S5) · 1 d · depends on: PR 7b
- [ ] `tests/test_time_windows_utc.py` (the five boundaries in S5 with `sql.utcnow` frozen).
- Acceptance: green; each test proven to go red by shifting the boundary one second.

**Cutover merge acceptance (before the `sqlite-cutover` branch merges to `main`):** lint allow-list empty except the `psycopg` import in `database.py`'s Postgres branch (if the transition switch is kept until PR 20); the dogfood stack converted (PR 8, M3) and used for one working day by the maintainer with no parity diff; `CHANGELOG.md` `[Unreleased]` names the change and the migration command.

#### PR 8 — Postgres→SQLite converter + `orcha migrate-runtime` (M1, M2) · 4–5 d · depends on: PR 7a (schema), PR 6 (native `up`)
- [ ] `tools/db/pg_to_sqlite.py` / `orcha_cli/db_convert.py` (FK-ordered copy, value mapper, `sqlite_sequence` check, `schema_migrations` stamping, verify + report, never overwrites).
- [ ] `orcha_cli/cli_migrate_runtime.py` (forward path with `.partial` + `os.replace`, `--rollback`, `--purge-docker` with `y/N`/`--yes`, the "start Docker once" message); `orcha up/update` nudge on Docker-runtime projects.
- [ ] `tests/test_pg_to_sqlite.py` (Postgres leg only) and `tests/test_migrate_runtime.py` (call order, no `-v` forward, failure leaves nothing behind, rollback byte-for-byte, purge refuses when the SQLite portal is down).
- [ ] M3 (task, not code): convert the dogfood stack; any diff → a new S8 case first.
- Acceptance: dogfood stack migrated, used for a day, rolled back once and re-migrated (proves both directions); converter report shows equal counts for all 34 tables.

### Phase D — native by default

#### PR 9 — merge PR 6 (rebased on the cutover) + `GET /api/version` (I2) · 0.5 d on top of PR 6
- [ ] `portal_backend/version_routes.py`; `application.py:8` version from `importlib.metadata`; `orcha status/ls` print it.
- Acceptance: PR 6's acceptance list, now runnable.

#### PR 10 — OS supervision, native default, `orcha doctor` (R3, R4) · 4 d · depends on: PR 9 → **M1**
- [ ] `cli_service.py` (`install|uninstall|status`; launchd plist with captured PATH; systemd user unit; `loginctl enable-linger` hint); `orcha up` re-installs the unit; `orcha init` defaults to native and installs the unit unless `--no-service`.
- [ ] `orcha doctor` (runtime, ports, unit status, `claude`/`codex`/`git` on the captured PATH, SQLite version, disk, log tails).
- [ ] `tests/test_cli_service.py` golden files + argv assertions; `tests/test_cli_doctor.py`.
- Acceptance: fresh macOS user account: `orcha init` → reboot → log in → `orcha ls` shows running; a task assigned in the portal wakes an agent with no terminal open. Linux: same on an Ubuntu 24.04 VM with lingering enabled.

#### PR 11 — `orcha backup` / `orcha restore` (S7) · 1 d · depends on: PR 9
- [ ] `VACUUM INTO` backup with rotation; restore refuses while `serve` runs; `PRAGMA integrity_check`.
- [ ] `tests/test_cli_backup_restore.py`.
- Acceptance: backup taken while the portal serves traffic restores to an identical parity snapshot.

#### PR 12 — docs for the native runtime (I3) · 2 d · depends on: PR 10
- [ ] `README.md` install section rewritten (Orcha.app or `uv tool install orcha-cli`), Docker blocks/troubleshooting moved to `docs/legacy-docker-runtime.md`, tech-stack table fixed; `orcha-cli/README.md`, `deploy/local/README.md`, `docs/orcha-test-runbook.md` (no Postgres for the default suite), `CHANGELOG.md` Deprecated entry; skills/preferences grepped for `docker compose`/`psql`.
- Acceptance: a reader following README on a clean Mac reaches a running portal without installing Docker.

### Phase E — distribution and desktop

#### PR 13 — PyPI publish + formula resources + wheel smoke (I1) · 1–2 d (+ owner: PyPI Trusted Publisher registration, Q-H) · depends on: PR 3
- [ ] `publish.yml` OIDC publish step; `CONTRIBUTING.md:65` tag name fixed; `build-check.yml` runs `orcha portal --help` from the wheel.
- Acceptance: a `cli-v*` tag publishes to PyPI and `uv tool install orcha-cli` works on a clean machine.

#### PR 14 — desktop: native-aware discovery, lifecycle, preflight, uv-installed helper (D1) · 4 d · depends on: PR 9, PR 13
- [ ] `desktop/src/main/nativeStacks.ts`; `discovery.ts`/`lifecycle.ts`/`preflight.ts`/`portPicker.ts`/`installers.ts` per D1; `Stack` gains `runtime` + `health`; `DockerDownBanner` demoted to a note.
- [ ] Tests listed in D1 updated; `nativeStacks.test.ts` with fixture files.
- Acceptance: the app lists a native project with no Docker installed and can start/stop it.

#### PR 15 — desktop: provision/migrate/reset through the CLI (D2) + `orcha init --progress-json` · 4 d · depends on: PR 10, PR 8, PR 14
- [ ] CLI: `--progress-json` step lines in `orcha init`.
- [ ] `initEngine.ts` → thin `orcha init` driver (modes `init`/`upgrade`/`migrate`); `folderModes.ts` runtime rule with parity fixtures; `resetEngine.ts` native path; template copy machinery deleted (`templates.ts`, `copy-orcha-templates.mjs`, parity test, `extraResources` entry, `pre*` hooks).
- Acceptance: provisioning a folder from the app produces the same `orcha.json`/unit as the CLI; the "Move this project off Docker" card migrates a Docker project end to end.

#### PR 16 — desktop: bundled Python sidecar + copy/docs + version bump (D3, D4) · 8–11 d · depends on: PR 15, PR 13 → **M2**
- [ ] `scripts/build-orcha-runtime.mjs` (pinned `python-build-standalone`, pip install of the CLI, compileall, strip, `bin/orcha` launcher); `electron-builder.yml` `extraResources`; codesign loop in `dist-mac-signed.sh` if needed; `~/.local/bin/orcha` symlink; sidecar-aware `orcha update`; resolution order in `hostWorker.ts`.
- [ ] D4: Docker copy removed from the renderer; `desktop/README.md` rewritten; minor version bump.
- [ ] Tests: dry-run vitest for the build script; `hostWorker.test.ts` resolution cases; manual smoke checklist in `desktop/README.md`.
- Acceptance: a **signed, notarized** arm64 DMG on a clean macOS account (no Homebrew, Docker, Python): open → pick folder → sign in to Claude Code → agents run; Gatekeeper shows only the single first-open confirmation. Do the first signed build in week 1 of this PR, not at the end.

### Phase F — optional isolation, cloud, cleanup

#### PR 17 — Claude Code / Codex sandbox mode for host wakes (X1) · 3.5 d · depends on: PR 10; **start with the half-day loopback probe**
- [ ] Probe result recorded at the top of `docs/sandbox-mode.md`; `sandbox.mode` tri-state; `sandbox_claude.py` (settings JSON, preflight); spawn changes; host wall-clock deadline in the reaper; cap counting; docs table.
- [ ] `tests/test_sandbox_claude_mode.py`.
- Acceptance: a wake in `claude` mode can reach the portal and GitHub, cannot read `~/.ssh`, and is killed at `max_runtime_secs`.

#### PR 18 — BYOC box on the native runtime (C1, C2) · 3 d · depends on: PR 10, PR 11
- [ ] `orcha serve --no-notifier --no-bridge`; `deploy/orcha-portal.service`, backup timer, provisioner/notifier-unit edits, `setup-github.py` flag removal; guide + runbook rewritten.
- Acceptance: the runbook rebuilds a box from `orcha.db` (converted offline dump) with host Caddy in front and per-workspace notifiers.

#### PR 19 — measurement, one release later (C-D4) · task, not code
- [ ] Slow-transaction p99 on the dogfood box for a week; decision recorded in this file (single file vs one `serve` per workspace).

#### PR 20 — cleanup, one release after M1 (S9, I4, C3) · 2 d · depends on: the release after PR 10 shipping
- [ ] Delete: `psycopg` deps, `sql.py` Postgres branches + `DIALECT`, `templates/migrations/*.sql` (Postgres) + `test_schema_parity.py`, Postgres CI job, compose template + `Dockerfile` + `requirements.txt` + compose wrapper + `cli_stacks.py`, Docker branches in `cli_project_commands.py`/`cli_status.py`/`cli_update.py`, leftover desktop Docker code, `deploy/auth/docker-compose.*.yml`, `deploy/local/docker-compose.oauth.yml`, `docs/legacy-docker-runtime.md`. Regenerate the parity fixture from SQLite.
- [ ] Optional: the mechanical `%s` → `?` sweep (446 sites) as its own follow-up PR.
- Acceptance: `git grep -iE 'psycopg|docker compose|DATABASE_URL'` over tracked files returns only `docs/` history and the runner-image sandbox → **M3**.

**Totals by workstream (from Parts 4–10):** S 22–26 d · R 11–14 d · M 5 d · D 16–19 d · I 4–5 d · X 4.5 d · C 3 d ⇒ **66–77 engineer-days (13–15 weeks)** for one person; critical path with two people (storage ‖ runtime, then desktop) ≈ **9–10 calendar weeks** to M2. This is above the spike's 11–13-week figure because it now includes the parity recorder, the converter/migration command, the box work and the first signed sidecar build, none of which were sized in the spike.

---
## Part 12 — Test and CI plan

The port is wide (446 SQL sites) and mostly mechanical; the plan's safety comes from a small number of guards that make a wrong rewrite fail loudly. Everything below already exists in some form in the repo (pytest with `asyncio_mode=auto`, `tests/conftest.py` fixtures, the `smoke` marker, vitest in `desktop/`), so nothing new is introduced in tooling — only in what is asserted.

### 12.1 Test layers

| layer | proves | where | introduced | backend |
|---|---|---|---|---|
| Helper unit tests | every `sql.py` helper emits the right text and the right bound value on both dialects | `tests/test_sql_helpers.py` | PR 2 | both (`:memory:` for SQLite) |
| Syntax lint | no Postgres-only construct survives outside `sql.py`; the allow-list only shrinks | `tests/test_no_postgres_syntax.py` | PR 2 | n/a (greps source) |
| API parity | every JSON response keeps its type tree, booleans and datetime format across the port | `tests/test_dialect_parity.py` + `tests/fixtures/parity_postgres.json` | PR 1 | Postgres records, SQLite asserts; SQLite-only after PR 20 |
| Schema parity | the SQLite baseline equals the 49 Postgres migrations (columns, nullability, indexes, uniques, FKs) | `tests/test_schema_parity.py` | PR 7a | both, transition only |
| DB layer | nested scopes, commit-then-write, migration atomicity, readonly assertion, placeholder translation, `now()` shape | `tests/test_database_sqlite.py` | PR 7b | SQLite |
| Concurrency | one winner per task under 20 concurrent claims; no busy errors | `tests/test_task_claim_concurrency.py` | PR 7c | SQLite |
| Time windows | five boundary-exact windows with `sql.utcnow` frozen | `tests/test_time_windows_utc.py` | PR 7d | SQLite |
| Converter | Postgres data → SQLite file → same parity snapshot; value mapper unit cases | `tests/test_pg_to_sqlite.py` | PR 8 | Postgres leg only |
| CLI (no DB) | `orcha portal/serve/service/migrate-runtime/backup/doctor` with `subprocess.run`, `uvicorn.run`, the compose wrapper and the converter monkeypatched; golden files for plist/unit/argv | `tests/test_cli_*.py` | PRs 3, 6, 8, 10, 11 | none |
| Existing suite | the ~2,800 tests keep passing on the new backend | `tests/` | PR 7b | SQLite (default), Postgres (until PR 20) |
| Smoke (e2e) | real uvicorn + real git + real PTY, `claude` stubbed via `ORCHA_LIVE_EXEC` | `tests/test_e2e_terminal_smoke.py` (`-m smoke`) | exists; ported in PR 7b | SQLite |
| Native e2e | `orcha init --runtime native` on a CI runner with no Docker: portal answers, notifier heartbeat fresh, `orcha down` clean | new CI job (12.2) | PR 10 | SQLite |
| Desktop vitest | the 44 existing files + `nativeStacks.test.ts` + sidecar build dry-run | `desktop/src/**/*.test.ts(x)` | PRs 14–16 | n/a |
| Manual checklists | what automation cannot reach (12.5) | `desktop/README.md`, this file | PRs 10, 16 | — |

### 12.2 CI evolution (`.github/workflows/`)

| phase | change | required? |
|---|---|---|
| A (PR 2) | `test.yml`: add job `pytest-sqlite` — no service container, `ORCHA_TEST_BACKEND=sqlite`, matrix `python: [3.11, 3.13]`, `continue-on-error: true` (advisory until cutover). Keep `pytest` (Postgres, 3.11) as is. | Postgres job |
| A (PR 3) | `test.yml`: smoke step in the Postgres job that starts `orcha portal --project-dir tests/fixtures/native-project --port 8123 &` and curls `/`. `build-check.yml`: `orcha portal --help` from the installed wheel. | yes |
| C (PR 7b) | `pytest-sqlite` becomes required (drop `continue-on-error`); `--cov=main --cov=portal_backend --cov-fail-under=70` on the SQLite leg; the Postgres job keeps running `test_schema_parity.py`, `test_pg_to_sqlite.py` and the full suite with `ORCHA_TEST_BACKEND=postgres`. | both |
| D (PR 10) | new job `native-e2e` on `ubuntu-latest` **and** `macos-latest`: `pip install uv && uv tool install ./orcha-cli`, `mkdir /tmp/p && cd /tmp/p && orcha init --runtime native --no-service --yes --name ci --objective x --as ci`, `curl --retry 30 --retry-connrefused http://127.0.0.1:$PORT/api/containers`, assert `.orcha/state.json` has three running children, `orcha down`. No Docker on the runner is the point (do not `setup-docker`). `orcha service install` is exercised only through its unit tests (launchd/systemd user sessions are not reliable on hosted runners). | yes |
| E (PR 14) | new `desktop.yml` on `macos-latest`: `npm ci`, `npx vitest run`, `npm run build` (typecheck + bundle, **no** packaging/signing; the signed DMG stays a manual, self-hosted step as in `publish.yml` today). | yes |
| F (PR 20) | delete the Postgres job and `services:`; `pytest-sqlite` is renamed `pytest`; regenerate `parity_postgres.json` from SQLite and rename it `parity.json`. | — |

Coverage: `--cov-fail-under=70` stays measured on `main.py` until PR 7b; from PR 7b it is measured on `main.py` + `portal_backend` **at the level the suite already achieves on the day PR 7b opens** (measure, round down to a multiple of 5, use that; never lower it later). `orcha_cli` coverage is reported but not gated (the CLI tests are subprocess-heavy).

### 12.3 Local workflow (updates `docs/orcha-test-runbook.md` in PR 7b and PR 12)

- After PR 7b a bare `pytest` in `.venv-test` needs **no Postgres**: conftest creates a temp SQLite file per session. `tests/requirements.txt` keeps `psycopg[binary]` until PR 20 for the Postgres leg.
- Postgres leg: `ORCHA_TEST_BACKEND=postgres` plus the existing `ORCHA_TEST_ADMIN_URL`/`ORCHA_TEST_DATABASE_URL` (the dogfood stack's Postgres on `:5437` works, as today's runbook §1 describes for `:5436`).
- The accepted-red baseline stays exactly one test (`tests/test_terminal_bridge.py:619`); any new red is a regression.
- Every PR body reports the local `N passed` count per the review protocol; PRs in Phase C report **both** legs.

### 12.4 Test teeth (runbook §6) — the mutations each guard must fail on

| guard | mutation that must turn it red |
|---|---|
| parity | make `/api/containers/{cid}` return `is_root` as `1`; drop `+00:00` from one `created_at`; return `assignees` as a JSON string |
| lint | add `now() - interval '1 day'` to any route |
| schema parity | add a column to a Postgres migration without touching the baseline |
| concurrency | replace `BEGIN IMMEDIATE` with `BEGIN` in `db_cursor` (expect `database is locked` or a double claim) |
| time windows | shift `sql.ago(5*3600)` to `sql.ago(5*3600 + 1)` in the token-usage route |
| migration atomicity | append a failing statement to a test migration; `schema_migrations` must not gain the row |
| converter | make the mapper drop microseconds; the parity comparison of datetimes must fail |
| supervisor | remove the backoff reset; the crashloop test must fail |
| service | change the plist label; the golden-file test must fail |

### 12.5 Manual verification (record the result in the PR body; these are the things CI cannot see)

1. **Clean macOS user account** (PR 10): `uv tool install orcha-cli` → `orcha init` → `sudo reboot` → log in → `orcha ls` shows running; assign a task in the portal → an agent wakes with no terminal open; `orcha doctor` output pasted in the PR.
2. **Ubuntu 24.04 VM** (PR 10): same, with `loginctl enable-linger`; log out and back in; unit still running.
3. **Dogfood migration** (PR 8): forward, use for a day, `--rollback`, use for an hour, forward again, `--purge-docker`; parity snapshot equal before and after; the untracked `.orcha/portal/` mirror is gone after purge.
4. **Docker sandbox under native** (PR 6/X2): Linux `--network host` wake completes; macOS with `bind: "lan"` wake completes via `host.docker.internal`; macOS with `loopback` fails preflight with the documented reason.
5. **Signed DMG** (PR 16): clean macOS account without Homebrew/Docker/Python; `spctl -a -vv Orcha.app` accepted; `codesign -dv --verbose=4` shows hardened runtime on `bin/python3` and a sample `.so`; first open shows one Gatekeeper dialog; provisioning works; quitting the app does not stop agents; reboot survival.
6. **Mobile pairing** (PR 6): default loopback bind → the pairing screen explains the LAN toggle; after `orcha pair --lan` the iOS/Android app pairs as today; the macOS firewall prompt appears once and only then.
7. **Performance floor** (PR 7c): `/tmp/orcha-sqlite-spike/claim_proto.py 1000 64` numbers (Appendix B) re-run against the real claim route through the ASGI app: p95 claim < 200 ms, zero busy errors; slow-transaction log empty at the default 250 ms threshold during a full test-suite run.

---
## Part 13 — Risks, mitigations, and what to watch

| # | risk | likelihood / impact | mitigation (where) | early signal |
|---|---|---|---|---|
| R1 | **`database is locked` under load** from deferred-read-then-write (`BUSY_SNAPSHOT`) or two connections on one thread | high if D6/D7 are skipped; medium otherwise / high | `BEGIN IMMEDIATE` default, thread-local cached connection, nested scopes join (D6, D7); readonly scopes on hot paths; assertion `ORCHA_DB_ASSERT_READONLY`; long-transaction audit of the 10 network/subprocess files (S3 note 4) | slow-transaction log lines; `OperationalError` in `.orcha/logs/portal.log`; Appendix B cases 1 and 4 |
| R2 | **Write-lock hold across slow calls** (GitHub API, `git`, Slack) blocks every writer for seconds | medium / high | audit in PR 7b; rule: no `urllib`/`subprocess` inside a writing `db_cursor` scope; slow-tx log threshold 250 ms | log lines naming the route; wake latency in the notifier |
| R3 | **Response-shape drift**: booleans as `0/1` (iOS decodes `Bool` strictly), JSON aggregates as text, `Decimal`→`float`, datetimes without `+00:00`, booleans inside `json_object` as `1/0` (Appendix B, probe g) | high without the guard / high | S8 parity recorder (PR 1) written before any port; `JSON_ALIASES` by column name; `json('true')` for booleans inside JSON aggregates (PR 5) | parity test red; iOS decoding errors in TestFlight |
| R4 | **Timestamp format mismatch** (`datetime()`/`strftime()` output vs canonical ISO) silently breaks `ORDER BY` and window comparisons | medium / high | D3 canonical text; lint forbids `datetime(`/`strftime(` outside `sql.py`/baseline; S5 boundary tests | tasks listed out of order; windows off by hours |
| R5 | **UUID case sensitivity** (Postgres compared case-insensitively) | medium / medium | D8 lowercase on write (`valid_uuid`) and in the converter; a test that posts an upper-case id | 404s for ids that "exist" |
| R6 | **Migration atomicity**: `executescript` commits first; a half-applied file with no `schema_migrations` row | medium / high | statement splitting inside one `BEGIN IMMEDIATE` (S3 note 1) + the atomicity test | a portal that fails on every start after a bad migration |
| R7 | **Data loss during `migrate-runtime`** | low with the design / critical | never overwrite `orcha.db`; `.partial` + verify + `os.replace`; `pgdata` untouched until explicit `--purge-docker` with `y/N`; `--rollback` renames rather than deletes (M2) | converter report mismatch → non-zero exit and no file left |
| R8 | **Schema drift during the overlap** (a Postgres migration lands without its SQLite twin) | medium / medium | `test_schema_parity.py` required on the Postgres leg until PR 20; rule in CONTRIBUTING | schema parity red |
| R9 | **launchd environment**: empty PATH, missing `HOME`/`LANG`, `claude` not found by the notifier | high without capture / medium | captured login-shell PATH written into the plist; re-install on every `orcha up`; `orcha doctor` lists what the unit can see (R3, R4) | wakes fail with "claude: not found" in `.orcha/logs/notifier.log` |
| R10 | **Notarization of the sidecar** (~100 nested Mach-O files; electron-builder may skip `extraResources`) | medium / high (blocks M2) | explicit `codesign` loop before the app-level sign; first signed build in week 1 of PR 16; `spctl`/`codesign -dv` checks in 12.5 | notarization rejection log naming an unsigned `.so` |
| R11 | **Loopback bind breaks mobile pairing / triggers the firewall prompt** | certain unless designed / medium | R-D3: loopback default, `bind: "lan"` one toggle away, pairing screen explains it; Q-F for the owner | pairing QR unreachable from the phone |
| R12 | **Sandbox loopback egress unknown** under Claude Code's sandbox | unknown / medium (X1 only) | half-day probe first; Unix-socket fallback designed (X1 step 5) | probe result |
| R13 | **Single SQLite file on a multi-tenant box** (many notifiers, one writer) | low locally, unknown on boxes / medium | C-D4 measured go/no-go (p99 lock wait < 250 ms for a week) before the first box cutover; fallback = one `serve` per workspace | slow-tx log on the dogfood box |
| R14 | **Thread churn / connection leaks** in anyio's threadpool and `asyncio.to_thread` | low / low | thread-local cache, no per-request close (D7); watch open fds under the suite; finaliser only if needed (S3 note 3) | fd count growth in `orcha doctor` |
| R15 | **Version coupling change** (R-D1: no per-project portal copy) surprises existing users; the untracked `.orcha/portal/` mirrors become stale rollback material | medium / low | DB-tip downgrade guard; `orcha status` prints the running package version (`/api/version`); docs in PR 12; mirrors deleted by `--purge-docker` | "portal version" confusion in bug reports |
| R16 | **`INSERT … SELECT … ON CONFLICT` parse ambiguity** in SQLite (needs a `WHERE` before `ON CONFLICT`) | low / low | all four `INSERT … SELECT` sites already have a `WHERE` (Appendix A); lint rule keeps every future `INSERT … SELECT … ON CONFLICT` that way (Appendix B, probe b) | syntax error at startup on the first request |
| R17 | **Estimate risk** (66–77 d vs the spike's 55–65 d) | medium / medium | cutover integration branch keeps `main` releasable, so slipping PRs 14–16 does not block M1; scope that can be cut without breaking the goal: X1, C1–C3, the `%s`→`?` sweep, Intel sidecar | burndown of the Part 11 checkboxes |
| R18 | **Parallel desktop work** (PR #247 on its own branch, GH #243–#246) conflicts with D1–D4 | medium / low | rebase #247 onto `main` before PR 14; D1 keeps the `Stack` shape and only adds fields; #246 is satisfied by `state.json` | merge conflicts in `discovery.ts`/`ProjectsHome.tsx` |
| R19 | **Python floor** (3.10) vs machines with only a system 3.9 (this Mac's `python3` is 3.9.7) | certain for CLI-from-source users / low | `uv tool install` and the sidecar bring their own interpreter; docs never say "use system python"; `build-check` runs the wheel on 3.11 | `str \| None` syntax errors on import |
| R20 | **Windows** remains unsupported (as #251 states) | — | out of scope; nothing in the design blocks a later Windows service (`sc.exe`/Task Scheduler) | — |

**What to watch after each milestone**

- **After M0:** CI smoke time (the host-process portal should start in < 5 s); any test that only passes in the container (it would mean a hidden `/app` path).
- **After the cutover:** the slow-transaction log on the dogfood stack for a week; parity diffs reported by mobile users (booleans, datetimes); `orcha.db-wal` size (a WAL that never checkpoints means a reader is held open — look for an SSE client holding a read transaction).
- **After M1:** `orcha doctor` pastes in bug reports (PATH, unit status); notifier restarts per day in `state.json`; users who never ran `migrate-runtime` (the nudge counter).
- **After M2:** notarization turnaround; DMG size; first-open dialog count reported by testers; Intel demand (decides the universal build).

---
## Appendix A — Postgres-only construct inventory (file:line, `main` @ `a776dd3`)

All paths are under `orcha-cli/orcha_cli/templates/portal/portal_backend/` unless noted. Re-grep before relying on a line number (`grep -rnF '<construct>' portal_backend`). Counts are grep hits; a few hits are comments or docstrings (marked `?`), which the lint should also clear so the allow-list can reach zero.

**Time arithmetic**
- `interval '…'` (20): `wake_backoff.py:115,206` · `device_token_routes.py:123` · `push_outbox.py:52` · `orphan_lease_routes.py:164` · `wake_scan_routes.py:57` · `push_routes.py:220` · `container_token_usage_routes.py:88,89,90,91,92,93,97,98,99,100,101,102` · `agent_spend_routes.py:44`
- `make_interval(…)` (10): `orphan_lease_routes.py:42` · `container_metrics_routes.py:165,172,181` · `wake_lease_claim_routes.py:76,78,97,99` · `wake_lease_renewal_routes.py:31,43`
- `(%s || ' seconds')::interval` / `' minutes'` (2): `wake_backoff.py:144` · `request_creation_routes.py:176`
- `EXTRACT(EPOCH FROM …)` (7): `wake_scan_queries.py:14,16,17,19` · `orphan_lease_routes.py:34` · `container_snapshot_routes.py:171` · `active_conversation_routes.py:94`
- bare `now()` (144 sites, 55 files): **stays** (D4 user-defined function).

**Casts**
- `::jsonb` (15): `task_creation_routes.py:70` · `task_done_routes.py:131,159` · `task_message_routes.py:178` · `user_pref_routes.py:153` · `roster_analysis_routes.py:78` · `events.py:30` · `request_acceptance_routes.py:135` · `agent_digest_routes.py:60` · `task_completion_support.py:72` · `agent_status.py:22` · `task_protocol_routes.py:65` · `request_creation_routes.py:176` · `member_routes.py:171` · `request_rejection_routes.py:134`
- `'[]'::json` (2): `container_snapshot_routes.py:172` · `task_list_query.py:25`
- `::text` (10): `task_start_core.py:246` · `wake_event_queries.py:12,15` · `push_outbox.py:142` · `orphan_lease_routes.py:59` · `wake_lease_renewal_routes.py:66` · `active_conversation_routes.py:112,123,130` · `task_list_query.py:39`
- `::int[]` (1): `task_start_core.py:241` · `::timestamptz` (1): `agent_request_box_routes.py:38`
- `psycopg.types.json.Jsonb(…)` (1): `member_routes.py:250`

**Arrays / set membership**
- `= ANY(%s)` (15; two are spelled `=ANY(`): `task_start_core.py:245` · `agent_notification_routes.py:84` · `device_token_routes.py:140` · `code_space_routes.py:440` · `orphan_lease_routes.py:59,71` · `push_routes.py:266,285,312` · `worker_run_support.py:67` · `wake_manifest.py:54,114,121` · `wake_acknowledgement_routes.py:137,202`
- `unnest(%s::int[])` + `JOIN LATERAL` (1 query): `task_start_core.py:231?,241-246` · `LEFT JOIN LATERAL` (1): `active_conversation_routes.py:139`

**Locking**
- `FOR UPDATE SKIP LOCKED` (1): `agent_task_claim_routes.py:42` (S4)
- plain `FOR UPDATE` (6 hits): `request_lookup.py:11?,18` · `code_space_routes.py:575` · `conversation_write_routes.py:63` · `request_nudge_routes.py:84` · `request_backstop.py:22`

**JSON construction / aggregation**
- `json_build_object` (12): `container_request_list_routes.py:94` · `container_snapshot_routes.py:80,99,178,253` · `task_list_query.py:19,26,28,36,44,52,54` — note `task_list_query.py:31` puts a **boolean expression** (`'is_human', (m.author_id IS NOT NULL AND ma.kind = 'human')`) inside the object; on SQLite it must be wrapped so it decodes as `true/false`, not `1/0` (Appendix B, probe g; PR 5).
- `json_agg(… ORDER BY …)` (3 hits): `container_snapshot_routes.py:178` · `task_list_query.py:5?,23`
- `->>` (6, supported; one boolean compare): `wake_scan_queries.py:94` · `wake_event_queries.py:12,16,39` · `container_metrics_routes.py:180` (**boolean**) · `event_acknowledgement.py:72`

**Strings / misc functions**
- `LEFT(col, n)` (6): `container_snapshot_routes.py:74,181` · `agent_digest_routes.py:147,156,157` · `task_list_query.py:29`
- `GREATEST(…)` (8 hits): `agent_notification_routes.py:159,191` · `orphan_lease_routes.py:26,125` · `container_snapshot_routes.py:76` · `event_acknowledgement.py:53` · `wake_acknowledgement_routes.py:24,66` — NULL semantics differ (S1 note); COALESCE the nullable operands.
- `ILIKE` (1): `task_start_core.py:343`
- `DISTINCT ON` (1 query): `code_space_routes.py:431?,438`

**Driver-level**
- `%(name)s` named placeholders (11): `local_git.py:248` · `push_outbox.py:85,87,88,134,136` · `agent_reachability_routes.py:27,29,30,31,32`
- `psycopg` references (19 hits, 9 files): `database.py:8,9,19,29` · `application_lifecycle.py:6,75` · `slack_routes.py:73,570,616` · `agent_profile_routes.py:3,188` · `container_lifecycle_routes.py:3,63` · `agent_suggestion_routes.py:3,82` · `agent_registration_routes.py:3,87` · `member_routes.py:6,8,185`
- `psycopg.errors.UniqueViolation` (5, the S3 `is_unique_violation` sites): `agent_profile_routes.py:188` · `agent_suggestion_routes.py:82` · `container_lifecycle_routes.py:63` · `agent_registration_routes.py:87` · `member_routes.py:185` (the `slack_routes.py` hits are comments/other psycopg uses — verify in PR 7b)
- `pg_advisory_lock/unlock` (2): `database.py:30,68` · `to_regclass` (1): `database.py:44`
- `INSERT … SELECT … ON CONFLICT` (SQLite requires a `WHERE` before `ON CONFLICT`, Appendix B probe b): all four sites already have one — `embodiment_token_routes.py:69-77`, `event_acknowledgement.py:70-74`, `push_outbox.py:84-88` (no `ON CONFLICT`, uses `WHERE NOT EXISTS`), `wake_acknowledgement_routes.py:200-204`. Nothing to change; the lint rule keeps it that way.

**Migrations** (`orcha-cli/orcha_cli/templates/migrations/`, 49 `.sql` files; `029_close_accepted_requests.sql.pending` is parked by the owner, never applied, and is **not** folded into the baseline unless it is unparked first)
- `gen_random_uuid()` (16): `001_init.sql` ×6 · `003_decisions.sql` · `004_worker_runs.sql` · `008_conversations.sql` ×2 · `032_agent_self_wake.sql` · `038_device_tokens.sql` · `041_push.sql` ×2 · `045_code_space.sql` ×2
- `BIGSERIAL` (3): `001_init.sql:148` (`events.id`), `:187` (`agent_events.id`), `:254` (`agent_memory_digests.id`)
- `NUMERIC(14,6)` (1): `019_worker_run_tokens.sql:17` (`worker_runs.total_cost_usd`)
- `DOUBLE PRECISION` (6 columns): `001_init.sql:192` (`agent_events.ts`), `:224` (`agent_wake_state.delivered_ts`), `:257` (`agent_memory_digests.snapshot_ts`) · `014_codex_worker_run_metadata.sql:7` (`worker_runs.conversation_ack_ts`) · `023_agent_notification_state.sql:24` (`read_through_ts`) · `030_conversation_lane.sql:34` (`conv_delivered_ts`)
- plpgsql trigger (1): `031_worker_run_tasks.sql:39-53` · `DO $$` guards (3): `030_conversation_lane.sql:51` · `036_collab.sql:18` · `039_access_model.sql:13` · `CREATE EXTENSION pgcrypto`: `001_init.sql:1`
- `ADD COLUMN IF NOT EXISTS` (59 sites, 30 files) · `DROP CONSTRAINT` (1: `037_multi_project.sql:17`) · `CREATE TABLE` (34) · `CREATE [UNIQUE] INDEX` (34) · `TIMESTAMPTZ` (65 column sites) · `JSONB` (19) · `BOOLEAN` (8)

**Tests** (`tests/`, for S6)
- `interval '…'` in raw SQL: 18 files / 58 sites (largest: `test_iss60b_orphan_lease_reaper.py`, `test_metrics_endpoint.py`, `test_iss50_heartbeat_on_poll.py`, `test_push_pipeline.py`, `test_device_tokens.py`, `test_agent_spend.py`, `test_iss289_token_meter.py`, `test_embodiment_tokens.py`, `test_iss340_active_run_label.py`, `test_iss_stranded_resident_runs.py`, `test_iss47_request_ownership.py`, `test_d7_read_payload.py`)
- `make_interval`: `test_iss266_auto_wake.py` (3) · `EXTRACT(EPOCH`: `test_iss60b_orphan_lease_reaper.py` (2) · `::jsonb`: 7 files / 8 sites
- driver/catalog: `psycopg` in `conftest.py`, `test_iss298_autonomy.py`, `test_iss64_autonomy_override.py`, `test_e2e_terminal_smoke.py`, `test_migrations.py`, `test_github_hub_routes.py` · `information_schema` in `test_iss294_llm_key.py`, `test_pr_attribution.py`, `test_iss294_model_settings.py` · `to_regclass` in `test_migrations.py` · `DATABASE_URL` in `conftest.py`, `test_e2e_terminal_smoke.py`
- the union of the rows above is the "≈31 files" S6 refers to. `docker` appears in 24 test files / 201 sites — those are CLI/sandbox tests that legitimately test the Docker branch and stay until PR 20.

---
## Appendix B — Probe evidence (SQLite behaviour verified on this machine)

Environment: macOS, Python 3.9.7 (system), **SQLite 3.51.0**; scripts in `/tmp/orcha-sqlite-spike/` (throwaway, not committed). Re-run: `python3 /tmp/orcha-sqlite-spike/<script>.py`. The minimum SQLite the plan relies on is 3.38 (`->>`, `RETURNING`, `json_each`, window functions, `UPDATE … FROM`); Python 3.10's bundled `sqlite3` and `python-build-standalone` both exceed it.

**B.1 Timestamps (`datefmt_check.py`)**
```
SQL_NOW -> 2026-09-29T04:17:14.103000+00:00 len 32      (strftime('%Y-%m-%dT%H:%M:%f','now') || '000+00:00')
py iso -> 2026-09-29T04:17:14.103758+00:00 len 32      (datetime.now(UTC).isoformat(timespec="microseconds"))
julianday()/unixepoch() parse both:      True
lexicographic == chronological (4 mixed-precision rows): True
rows > python-computed boundary:         2 (expect 2)
age secs via julianday():                101834.103 (sub-second precision kept)
```
Conclusion: D3's canonical text sorts and compares correctly as TEXT, and SQLite's date functions parse it (so `julianday()` age arithmetic works). The SQL default and the Python adapter produce the same 32-character shape.

**B.2 Declared-type converters (`decl_probe.py`)**
```
RETURNING row: {'id': 'ed02f66b-…', 'created_at': datetime(…, tzinfo=UTC), 'payload': {'a': 1}, 'flag': True}
payload decoded: {'a': 1} (text) | 123 (integer) | '123' (text)     ← bare-number JSON round-trips despite NUMERIC affinity
expr col type: str | direct col type: datetime                       ← MAX(created_at) LOSES the declared type (adapter must handle aliases)
->> returns parsed JSON; json_each IN works; upsert ON CONFLICT ok; UPDATE … FROM ok
EXISTS type: int                                                     ← booleans from expressions come back as 0/1 (S8 guards)
in_transaction after BEGIN IMMEDIATE (isolation_level=None): True
cutoff compare with bound datetime: works (adapter → text)
VACUUM INTO: works, but fails with "output file already exists" if the target exists (S7 must pick a fresh name)
```

**B.3 Second-pass constructs (`probe2.py`)**
```
(a) UPDATE … FROM … RETURNING              ok
(b) INSERT … SELECT … ON CONFLICT DO NOTHING (no WHERE)   FAILS: near "DO": syntax error   ← add WHERE true
(b') same with a WHERE clause               ok
(c) partial-index ON CONFLICT target        ok
(d) NULL NOT IN (json_each)                 NULL (as Postgres) | 'y' NOT IN [] → 1 | 'x' NOT IN ['x'] → 0
(e) user-defined function inside DEFAULT    accepted at CREATE time, but the DB then depends on the function → baseline uses strftime, not now()
(f) SELECT now() (UDF) type                 str
(g) json_group_array ordered via subquery   ["amy","bob","zed"] ; json_object nested boolean (1=1) → 1  ← wrap booleans with json('true')
(h) CAST(… AS TEXT) || ': %'                ok ; LIKE is case-insensitive for ASCII (ILIKE → LIKE is safe)
(i) read-only CTE feeding UPDATE            ok ; data-modifying CTE (WITH … UPDATE … RETURNING)  rejected (none in the code)
(j) ->> on JSON true/false/missing          1 / 0 / None ; COALESCE(json_extract(d,'$.approved'),1)=1 counts 2 of 3 (correct)
(k) row-value comparison                    ok
(l) text UUID compare                       'ABC' = 'abc' → 0 ; lower() → 1   ← D8
```

**B.4 Locking semantics (`snapshot_probe.py`, WAL, `busy_timeout=2000`)**
```
case1: DEFERRED read → other conn commits → write: OperationalError('database is locked') after 0.000 s  (busy_timeout NOT honoured → BEGIN IMMEDIATE, D6)
case2: second BEGIN IMMEDIATE waited 0.58 s then committed                                                (busy handler honoured)
case3: reader sees the row in 0.0000 s while a writer holds the lock                                       (WAL: readers never block)
case4: nested write from the SAME thread on a second connection: 'database is locked' after 2.14 s        (self-deadlock → one connection per thread, D7)
```

**B.5 Claim prototype (`claim_proto.py 1000 64`, spike hard part 1)**
```
tasks=1000 threads=64 agents=5  winners=1000  unique=1000  dupes=0
remaining ready=0  in_progress=1000  busy/lock errors=0  reader iterations during run=5446
claim-attempt latency ms: p50=0.05 p95=76.66 max=220.44  total=235ms  attempts=1064
OK: exactly one winner per task, none lost, none double-assigned
```
Shape = `UPDATE tasks SET … WHERE id = (SELECT … ORDER BY priority, created_at LIMIT 1) RETURNING …` inside `BEGIN IMMEDIATE` (S4). Worst case (every task assigned to every agent); real stacks assign to one or few.

---
## Appendix C — Environment-variable contract of the portal (before / after)

"Read by" is where the portal (or a shared module it imports) reads the variable; "compose today" is `templates/docker-compose.yml.j2`; "native" is what `build_portal_env()` (R1) sets, with shell env > `.orcha/.env` > derived default, mirroring compose interpolation.

| variable | read by | compose today | native (R1 → S3) |
|---|---|---|---|
| `DATABASE_URL` | `database.py:11` | `postgresql://orcha:orcha@db:5432/orcha` | R1: `postgresql://orcha:orcha@localhost:<db_port>/orcha`; **S3: removed** |
| `ORCHA_DB_PATH` | `database.py` (S3, new) | — | `<project>/.orcha/orcha.db` |
| `ORCHA_DB_DIALECT` | `sql.py` (transition only) | — | `sqlite` after S3; deleted in PR 20 |
| `ORCHA_DB_SLOW_TX_SECS`, `ORCHA_DB_ASSERT_READONLY` | `database.py` (new) | — | default `0.25` / unset (tests set `1`) |
| `MIGRATIONS_DIR` | `database.py:12` | `/app/migrations` (bind mount `:90`) | package `templates/migrations` → `templates/migrations/sqlite` |
| `ORCHA_WAKES_DIR` | **nobody** | `/app/orcha-wakes` (`:30`, mount `:94`) | dropped (R1) |
| `ORCHA_ATTACHMENTS_DIR` | `attachment_config.py:6`, `main.py:104` | `/app/orcha-attachments` (`:34`, mount `:101`) | `<project>/.claude/.orcha-attachments` |
| `ORCHA_LLM_API_KEY` | 4 reads (`secret_box`, LLM routes) | `${ORCHA_LLM_API_KEY:-}` (`:37`) | inherited from shell / `.orcha/.env` |
| `ORCHA_LLM_BASE_URL` | `llm_providers.py:94` | `${…:-}` (`:38`) | inherited |
| `ORCHA_SECRET_KEY` | `secret_box.py:13` (sealing key; `cli_project_setup.py:16` generates it) | `${ORCHA_SECRET_KEY:-}` from `.orcha/.env` (`:43`) | read from `.orcha/.env` by `build_portal_env`; file and 0600 mode unchanged |
| `ORCHA_TERMINAL_WS_URL` | terminal routes (1 read) | `ws://127.0.0.1:<bridge_port>` (`:48`) | same |
| `ORCHA_PAIRING_HOST` | `container_pairing_routes.py` | `${…:-}` (`:52`, exported by `export_pairing_host`) | same helper, called before `uvicorn.run` |
| `ORCHA_PAIRING_PORT` | `container_pairing_routes.py:80` | not set | optional, unchanged |
| `ORCHA_GITHUB_TOKEN_FILE` | GitHub token reader | `/app/stack-dir/github-token` (`:58`, mount `:111`) | `<project>/.orcha/github-token` |
| `ORCHA_GITHUB_TOKENS_FILE` | GitHub token reader | `/app/stack-dir/github-tokens.json` (`:64`) | `<project>/.orcha/github-tokens.json` |
| `ORCHA_TRUST_PROXY_USER` | `identity_routes.py:17` | `${…:-}` (`:69`) | inherited (boxes set it in `.orcha/.env`, Part 10) |
| `ORCHA_GITHUB_PAT` | 2 reads | `${…:-}` (`:74`, via `export_gh_token`) | same helper |
| `ORCHA_PLAN`, `ORCHA_UPGRADE_URL` | `plan_routes.py:17-18` | `${…:-}` (`:78-79`) | inherited |
| `ORCHA_LOCAL_REPO_DIR` | `local_git.py` (2 reads) | `/app/workspace` (`:84`, mount `:118`) | `<project root>` |
| `ORCHA_LOCAL_REPO_NAME` | 1 read | `{{ project_name }}` (`:87`) | `cfg["project_name"]` |
| `ORCHA_MIGRATE_ON_FAILURE` | `application_lifecycle.py:95` | not set | unchanged (`halt`) |
| `ORCHA_WAKE_BACKOFF_RECENT_RUN_SECS` | `wake_backoff.py:54` | not set | unchanged |
| `ORCHA_SIDECAR` | `cli_update.py` (D3, new) | — | `1` inside the desktop sidecar launcher |
| `ORCHA_TEST_BACKEND` | `tests/conftest.py` (S6, new) | — | `sqlite` default; `postgres` for the transition leg |
| uvicorn bind | `Dockerfile:17`: `--host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips *` | published `<api_port>:8000` | `127.0.0.1:<api_port>` (`0.0.0.0` when `bind: "lan"`), `--forwarded-allow-ips 127.0.0.1` |

Compose-side variables that are **not** portal contract and simply disappear with the container: `POSTGRES_USER/PASSWORD/DB` (`:10-12`), the `db` service, the five bind mounts (`:89-118`), the `pgdata` volume (`:122-123`).

---

*End of plan.*
