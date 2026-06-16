# Orcha — Functional Regression Suite (manual/scriptable, runs against a live stack)

> Complements `pytest` (unit/integration). These are **black-box functional checks against a running
> stack** — exercise the real API/CLI/portal the way an operator does, with **exact steps + expected
> results**, so we catch regressions pytest can't (deploy wiring, daemon behavior, portal UX, end-to-end
> flows). Run after every merge to `main` and before any release.
>
> Status legend:  ✅ should pass today · 🚧 known gap (built in a later phase) · ⛔ known-broken until a
> named fix lands. Update the status column as phases complete.

## How to run
For each test: run the **Steps** verbatim, compare to **Expected**, mark PASS/FAIL + date. Most steps are
`curl`/`docker`/`orcha`; portal steps say "in the portal". Keep output for failures.

## Setup (run once per session)
```bash
export BASE=http://localhost:8000
export CID=$(python3 -c "import json;print(json.load(open('.claude/orcha.json'))['current_container_id'])")
# helper: agent id by alias
aid() { curl -fsS "$BASE/api/containers/$CID" | python3 -c "import json,sys;d=json.load(sys.stdin);print(next(a['id'] for a in d['agents'] if a['alias']=='$1'))"; }
# DB shell helper
psql() { docker exec -i orcha-orcha-db-1 psql -U orcha -d orcha "$@"; }
```
**Preconditions:** stack up (`orcha status` healthy), a container exists, at least one human + one AI agent registered.

---

## FT-CORE — the DB-as-bus core (✅)
- **CORE-1 Create + read a task.** Steps: `curl -fsS -X POST "$BASE/api/containers/$CID/tasks" -H 'Content-Type: application/json' -d '{"title":"FT probe","definition_of_done":"n/a","priority":100}'` → note `task_id`; `curl -fsS "$BASE/api/containers/$CID" | python3 -c "..."`. **Expected:** task appears with `status=ready` (unassigned, not claimable until assigned) and the given title.
- **CORE-2 Assign claims + sets in_progress.** Create with `"assignee_alias":"Forge"`. **Expected:** response `status=in_progress`, `assignee_alias=Forge`.
- **CORE-3 Task thread message.** `POST $BASE/api/tasks/<tid>/messages {author_agent_id:<aid Forge>, body:"hi"}`. **Expected:** 200 `{message_id}`; appears in `GET /api/tasks/<tid>/messages`. *(Regression: only the task's assignee/participant may post — a non-participant gets 403; over-length body gets a CLEAR error, not a silent 422 — see B-4.)*
- **CORE-4 Info request lifecycle open→answered→closed.** `POST $BASE/api/containers/$CID/requests {requester_agent_id:<A>, target_alias:"<B>", type:"info", payload:"q"}` → `POST /api/requests/<rid>/respond {responder_agent_id:<B>, response:"a"}` → `POST /api/requests/<rid>/close {requester_agent_id:<A>}`. **Expected:** statuses go `open`→`answered`→`closed`; 403 if non-target responds; 409 if closing a non-answered request.
- **CORE-5 Long-poll `/wait`.** `curl "$BASE/api/agents/$(aid Forge)/wait?since_ts=0&timeout=10"`. **Expected:** returns the first event newer than `since_ts`, or `{"event":"timeout"}`. Re-running with the returned `ts` as `since_ts` advances past it.

## FT-A — Epic A: Wake & Self-Movement
- **A-1 Reachability registry (✅).** `curl -X POST "$BASE/api/agents/$(aid Forge)/reachability" -d '{"headless_cwd":"'$PWD'","wake_enabled":true}'`. **Expected:** echoes stored fields; `GET` returns them; `wake_enabled` defaults true on a fresh agent.
- **A-2 wake-scan (✅).** Give Forge a pending item (CORE-4 targeting Forge), then `curl "$BASE/api/containers/$CID/wake-scan?cooldown=15&min_idle=0"`. **Expected:** Forge appears with `should_wake=true`, `pending_events>=1`, a resolved `transport`.
- **A-3 Headless wake fires (✅).** With Forge reachable + pending work + `wake_enabled=true`, run one daemon tick: `PYTHONPATH=orcha-cli python3 -m orcha_cli notifier --once --min-idle 0 --cooldown 0 --api-base $BASE --container $CID`. **Expected:** prints `woke <alias> via headless`; `pgrep -f "claude -p"` shows a worker; `agent_wake_state.last_wake_kind=headless`.
- **A-4 Dry-run resolves without spawning (✅).** Same as A-3 with `--dry-run`. **Expected:** prints `DRY-RUN would wake … via <transport>` and the exact command; **no** new `claude -p` process; cursor not advanced.
- **A-5 Auto-start never crosses the verify gate (✅).** Assign Forge a ready task; let it auto-start; have it `/orcha-done`. **Expected:** task → `needs_verification` (NOT `completed`); only a human `/orcha-verify` completes it.
- **A-6 Targeted task_ready on unblock (✅).** Create task T2 depending on T1 (assigned to Forge); complete T1 (verify). **Expected:** a `task_ready` event targeted at Forge is emitted for T2.
- **A-7 Wake opt-out (✅).** `POST reachability {wake_enabled:false}` for Forge; re-run wake-scan. **Expected:** Forge `should_wake=false` (reason mentions disabled); daemon spawns nothing.
- **A-8 Cron stopgap catches a missed event (✅).** Idle agent + a pending event → `orcha notifier --once`. **Expected:** issues exactly the wake the live loop would; advances the delivered cursor.
- **A-9 tmux live-context wake (🚧 not yet verified).** Launch an agent inside a tmux pane, register `tmux_target`, give it pending work, run the daemon. **Expected (target):** daemon `send-keys` into the live pane; the existing tab resumes in place. *Currently unverified — needs an agent in tmux.*
- **A-10 Single-flight wake guard (⛔ until R2.4).** Assign ONE task to an agent and run the daemon. **Expected (target):** **exactly one** worker spawned. *Currently FAILS — daemon spawns multiple concurrent workers (observed up to ~12). This is the R2.4 regression test; it must go green before daemon auto-wake is re-enabled.*

## FT-B — Epic B: Portal Control Surface
- **B-1 Verify (approve) from portal (✅).** A task in `needs_verification`; in the portal click **Approve** (or `POST /api/tasks/<tid>/verify {approve:true, actor_agent_id:<human>}`). **Expected:** task → `completed`; downstream deps unblock; a `task_verified` event is emitted.
- **B-2 Reject routes feedback to the agent (✅).** Click **Reject** with feedback (or `{approve:false, feedback:"fix X", actor_agent_id:<human>}`). **Expected:** task → `in_progress`; a `[verification rejected] fix X` message is inserted on the task thread; `task_verified` carries the feedback.
- **B-3 Acting-as identity (✅).** In the portal with one human → auto-acts-as them; with >1 human → "Acting as" picker, persisted in localStorage. **Expected:** verify actions carry a valid `kind=human` `actor_agent_id`; a non-human actor is rejected by the API.
- **B-4 Over-length message → clear error (✅, R1-era fix).** `POST /api/tasks/<tid>/messages` with a body over the cap. **Expected:** a clear "too long"-type error, **not** a silent 422.
- **B-5 close-implications aggregation (✅).** `curl "$BASE/api/tasks/<tid>/close-implications"` for a task with deps + children. **Expected:** correct counts of downstream/blocked tasks, in-flight agents, open child requests, `spawned_task_id`.
- **B-6 Approval control = Approve/Reject + reason everywhere (🚧 until B0/G1).** Every decision surface shows `[Approve][Reject]` + a reason field (required on reject); the reason routes to the agent. *Built in Surface phase.*

## FT-C — Epic C: Per-Agent Memory Digest
- **C-1 Digest write (✅).** As an agent, run `/orcha-snapshot` (or `POST /api/agents/<aid>/digest {current_focus, decisions, learnings, open_threads}`). **Expected:** a new row in `agent_memory_digests` for that agent.
- **C-2 Digest read (✅).** `GET` the agent's digest. **Expected:** returns the latest snapshot.
- **C-3 SessionStart rehydrate (✅).** `orcha rehydrate --alias <a>` (or open a fresh session). **Expected:** prints a "where we left off" brief built from the latest digest (+ tasks/threads).
- **C-4 Ownership boundary (✅).** Inspect: digest lives in Postgres (`agent_memory_digests`); the local Claude Code memory dir is untouched. **Expected:** no bidirectional sync; disjoint content.
- **C-5 Digest write-on-exit / FT-CONT (✅, C1).** A woken headless worker (`ORCHA_HEADLESS_WORKER=1`) snapshots a continuity digest on session end via the `orcha snapshot` SessionEnd hook. *Automated:* `pytest tests/test_c1_digest_write_on_exit.py` covers: marker-gated no-op for interactive tabs; fallback digest written (focus = last assistant turn) on a normal end; the fallback **carries forward** the prior digest's decisions/learnings/open-threads (rehydrate reads only the latest row, so a thin row must not erase earlier wakes' context); **skip** when the agent already POSTed its `/digest` this session (so it never shadows the rich `/orcha-done` digest); SessionEnd hook registered idempotently. **Expected:** green; on a live worker, its latest `agent_memory_digests` row reflects the just-finished wake. *(Note: the Stop hook does NOT fire under `claude -p`; SessionEnd is used, and writes directly since it cannot block/reprompt.)*

## FT-R1 — Migration runner (✅, merged)
- **R1-1 Ledger + baseline.** `psql -c "select version from schema_migrations;"`. **Expected:** `001_init.sql` recorded as applied; core tables intact.
- **R1-2 Idempotent apply.** Drop a throwaway `migrations/999_probe.sql` (`CREATE TABLE IF NOT EXISTS _probe(...)`); run `orcha migrate`. **Expected:** run 1 applies + records `999`; run 2 is a no-op. Remove the probe after.
- **R1-3 `orcha up` migrates a live volume, NO wipe.** On an existing volume with data, add a pending `002_*.sql`, then `orcha up`. **Expected:** `002` applied on boot; **existing rows survive**.
- **R1-4 Fresh init still whole.** `orcha init` in a scratch dir. **Expected:** full schema present; `001` recorded baseline; `002+` applied by the runner.
- **R1-5 Hard-fail on bad migration.** Add a deliberately-broken `migrations/998_bad.sql`; restart the portal. **Expected:** portal **fails to boot** (loud); with `ORCHA_MIGRATE_ON_FAILURE=continue` it logs + serves. Remove the bad file after.

---

## FT-DEPLOY — deploy/install sanity (✅; catches ISS-4)
- **DEPLOY-1 — CLI install actually took.** After `uv tool install …` (or any CLI reinstall), the new
  commands are present. *Steps:* `orcha -h` → expect the full set incl. `upgrade` and `migrate`.
  *Verify:* `orcha -h | grep -E "upgrade|migrate"` returns both. *(Catches the uv version-cache trap:
  `--force`/`uninstall+install` reuse the cached `0.1.0` build; use `--editable` or bump the version.)*
- **DEPLOY-2 — migrations applied on deploy, no wipe.** After `orcha upgrade && orcha up`, the live DB
  has the new migrations and existing rows survive. *Verify:* `schema_migrations` lists the expected
  `00N_*.sql`; new columns/tables exist; a pre-existing row still present.
- **DEPLOY-3 — deployed code matches main.** The running portal carries the merged code. *Verify:* grep
  `.orcha/portal/main.py` for a known new symbol (e.g. `wake_lease_until`) → present.
- **DEPLOY-4 — _retired 2026-06-12._** Postman collection ↔ route parity is no longer enforced.
  The API contract's source of truth is now the generated **Swagger / OpenAPI** spec
  (`/docs`, `/openapi.json`) — reviewers verify routes/schemas against it, so there is no
  hand-maintained artifact to keep in lockstep. (Replaces the former mandate +
  `tests/check_postman_parity.py`; see `docs/orcha-review-protocol.md` §4.)

## FT-SMOKE — live-terminal end-to-end real-seam gate (✅, R2; required merge gate)
The "untested-seam" bug class (#154 bridge read the PATCH-only bare `/api/agents/{id}` instead of
`/persona` → 405 → "always busy"; #147 PTY booted AS the actor not the target) survived because every
unit test of this seam **mocks** the network/process (a `_get_json`-agnostic mock literally *hid* #154).
This gate drives the whole wire with almost nothing mocked.
- **SMOKE-1 — full cold-boot seam.** *Automated:* `pytest -m smoke` →
  `tests/test_e2e_terminal_smoke.py`. Boots a **real uvicorn server** on an ephemeral port against the
  test DB and drives `terminal_bridge.handle_connection` for real: real `/persona` reads, real `wake-claim`
  (live lease in `agent_wake_state`), real **PTY fork of `orcha use <alias>`** → real `cmd_use` →
  real `_exec_live_session`. Only the `claude` leaf is substituted, via the **`ORCHA_LIVE_EXEC`** test
  seam — a stub that records the argv/cwd/env it was launched with. *Verify:* client gets `connected`;
  the stub booted **AS the target** (`ORCHA_ALIAS=Vault`, not the human actor) with `ORCHA_LIVE=1` + a
  cold boot (no `--resume`) in the provisioned cwd; the live lease is **released** on close.
- **SMOKE-2 — non-human actor refused (4403)** at the real `/persona` check — no lease, no PTY.
- **SMOKE-3 — single-flight busy (4409)** — a second connect while the live lease is held is refused by
  the real `wake-claim` SQL; no second PTY.
- *Teeth check (manual):* reverting the bridge's actor read to the bare route reproduces #154 and turns
  SMOKE-1 red (`lease_denied: actor not human`). *(Only the websocket transport is not exercised here —
  framing is unit-tested in `test_terminal_bridge.py`, and `websockets` is a lazy runtime-only dep.)*
- **CI:** runs today as part of the default `pytest` job in `.github/workflows/test.yml` (the `smoke`
  marker doesn't deselect it), so it already gates merges. *Follow-up (needs `workflow` scope — an
  OAuth push can't touch `.github/workflows/`):* add a dedicated named step so the gate is visible/
  separately enforceable —
  ```yaml
      - name: E2E smoke gate (real-seam — required)
        run: pytest -m smoke -v
  ```

## Pending phases (add tests as they land)
- **FT-R2 (event-consumer):** drain-full-inbox (3 pending + one wake → all 3 handled); idempotent mutations (repeat close → 200, not 409); **A-10 single-flight goes green**.
- **FT-R3 (main.py split):** all 40 routes respond identically pre/post; OpenAPI/route list unchanged.
- **FT-ENGINE (A1–A5):** worker output captured + retrievable via endpoint; portal `prompt` event wakes an agent; resume-trigger advances a long task across 2 sessions; allowlist blocks a disallowed op while permitting orcha calls.
- **FT-CONT (C1/C2):** C1 — digest auto-written on worker exit — ✅ codified in `tests/test_c1_digest_write_on_exit.py` (see C-5 above). C2 — a fresh worker rehydrates + references the prior worker's decisions — live-e2e, still to codify.
- **FT-SURFACE (B0–B6):** progress feed shows worker output; prompt-from-portal round-trips; Approve/Reject+reason on every surface; assign-from-portal wakes the agent; continuous-agent timeline.
- **FT-E2E (the acceptance test):** terminal-free loop — prompt in portal → worker runs (progress visible) → asks → human Approve/Reject+reason → same-agent resumes with context → needs_verification → verify+reason → completed. **No terminal touched; one continuous agent; every decision carried a reason.** When FT-E2E passes, the manual administrative work is gone.

## Current known-failing (must go green as phases land)
- **A-10 single-flight** — ✅ FIXED: R2.4 merged + deployed; verified GREEN live (1 task → exactly 1 worker, lease held, repeated ticks spawn no 2nd worker).
- **A-9 tmux wake** — 🚧 unverified (needs tmux-hosted agent).
- **worker output visibility** — 🚧 `/dev/null` today (Engine A1/A2).
- **unattended worker permissions** — 🚧 `--dangerously-skip-permissions` (Engine A5).
- Until those land: **operate with daemon-wake DISABLED + per-tab listen loops** (the current safe mode).
