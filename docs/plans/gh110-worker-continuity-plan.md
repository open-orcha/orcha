# Plan — GH #110: preserve task worktree/diff across wakes (worker continuity)

**Task:** 8fa6e17a-9b67-416b-b7f2-437a953f0197 · **Owner:** CodeCleanupAgent · **Reviewer gate:** Code Reviewer (plan → CLEAN → implement).
All line refs below are `orcha-cli/orcha_cli/notifier.py` unless noted, **re-verified against `origin/main` after rebase** (round-1 branch forked 30 commits behind, before PR #80 / GH#61 merged; this round is rebased onto main so the reused helpers exist).

## Round-2 changelog (addressing Code Reviewer round-1 NEEDS CHANGES)
- **[R1] Stale base fixed.** Rebased onto `origin/main`. Main already ships `_codex_is_rate_limit` (1399), `_codex_event_phase` (1428), `_codex_result_status` (1561), `_terminal_status(log_path, runtime)` (1722); `reap_workers` already resolves `w_runtime` from `respawn_ctx.model_runtime` (2384) and `live_workers` already carries `task_id` (2834), `runtime` (2837) and `respawn_ctx` (2861-2865). §1 and §2e rewritten to **reuse** those helpers (thin wrapper, no from-scratch scanner); the false "live_workers never stores runtime" / "store runtime in live_workers" items are dropped.
- **[R2] Checkpoint commit no longer leaks local config.** §2b now commits with exclusion pathspecs (`_DIFF_EXCLUDES` **+** `:(exclude).claude/settings.json`) and extends `_DIFF_EXCLUDES` to cover `settings.json` (fixes a pre-existing diff-capture leak); commit is skipped when the tree is clean after exclusions.
- **[R3] Withheld cursor now bounded.** §2e adds (a) bounded redelivery — after N failed drains advance the cursor + emit a human-visible failure event, and (b) a rate-limit hold-down — parse the reset time (else default backoff) and skip the agent as a wake candidate until then.
- **Minors** m1–m5 folded in (see §2b/§2e/§2f and inline tags).

## 1. Problem (verified against origin/main)
The task-wake ephemeral path (`tick` → `spawn_headless` → `reap_workers`) is runtime-agnostic and, on a **clean exit** (`proc.poll() is not None`, 2320-2334), calls `_finish_run(..., "exited", proc.returncode, ...)` then the force-removing `_teardown_worktree` (2111-2137) — **judged by process returncode alone**, never consulting the Codex classifiers that already exist. `_teardown_worktree` removes the worktree with `--force` and `git branch -D`s the branch unless it has commits beyond `origin/main`. So a worker (Claude or Codex) that exits 0 with **uncommitted** changes loses the tree entirely; the only survivor is the ≤200 KB captured diff text on the run row. The next same-agent+same-task wake re-provisions a fresh **timestamped** worktree from `origin/main` (`_provision_worktree`, 1950-1972) and starts blind. The terminal-status branch (~2400-2410) that handles a Codex terminal turn line likewise ends in `_teardown_worktree`.

Codex rate-limit is the second half: `reap_workers` **does** resolve `w_runtime` (2384) and `_terminal_status`/`_codex_result_status` **do** classify `rate_limit_event` / `api_error_status:429`, but that classification is wired into the *terminal hold-off* path only — the **clean-exit** branch at 2321 ignores it and records `status="exited"` with `delivered_ts` already advanced at spawn (2893). So a Codex worker that dies on a 429 and exits still reads as a successful drain: the wake cursor stays advanced past unhandled work and the worktree is torn down. Codex `exec` also has no SessionEnd hook, so it never writes a continuity digest; the Claude SessionEnd `orcha snapshot` hook only fires on a voluntary clean close.

## 2. Design overview
Introduce a **durable per-(agent+task) worktree/branch** for code-touching *task* wakes, mirroring the preservation already proven by `_checkpoint_and_respawn` (keeps same worktree) and `_safe_teardown_worktree` (preserve-if-dirty, 2138-2217). Non-code request-answer wakes (`is_code_wake == False`, 2811) keep the cheap shared-cwd path unchanged.

### 2a. Stable task worktree key
- New helper `_provision_task_worktree(base_cwd, alias, task_id)`:
  - `slug = f"{_safe_ref(alias)}-{_safe_ref(task_id)[:12]}"`; `branch = f"orcha/task-{slug}"`; worktree `base/.orcha-worktrees/task-{slug}` (stable, **not** timestamped).
  - If the worktree dir already exists and is a valid registered worktree → **reuse** (no fetch/add), return it.
  - Else `git worktree prune` (m4: clear a stale registration for a dir that was manually removed), then: if the branch exists (locally or on origin) but no worktree → `git worktree add <wt> <branch>` (re-attach to prior state, do NOT restart from origin/main).
  - Else → `git fetch origin main` + `git worktree add -b <branch> <wt> origin/main` (first wake only).
  - Overlay runtime config as today (`_overlay_runtime_config`).
- `tick`: when `is_code_wake` (2811) AND a task id is resolvable (`cand.get("wake_task_id")` or first of `auto_start_task_ids`) → call `_provision_task_worktree(base_cwd, alias, task_id)` instead of `_provision_worktree`. When code wake but **no** task id → fall back to today's ephemeral `_provision_worktree` (unchanged). Rationale: only task-linked code wakes need cross-wake continuity.

### 2b. Preserve on clean exit
- `reap_workers` clean-exit branch (2320-2334): decide teardown by whether this run used a **task worktree**. Store a `task_worktree: bool` flag in the `live_workers[aid]` record at spawn (task_id/runtime are already stored at 2834/2837; also mirror both into `respawn_ctx` so a checkpoint-respawned worker keeps them).
  - If `task_worktree`: on clean exit, if the tree is dirty after exclusions, create a **local checkpoint commit** on the task branch, then **keep the worktree** (chosen per reviewer Q1 answer: checkpoint-commit + keep worktree; keep-dirty-only is rejected — a dropped dir would lose it and breaks test 5). **Never push, never open a PR automatically.**
    - **[R2] Commit safely.** Stage/commit with the same exclusion pathspecs used for diff capture: extend `_DIFF_EXCLUDES` (2092) to `(".", ":(exclude).claude/orcha.json", ":(exclude).claude/orcha-tabs", ":(exclude).claude/settings.json")`, then `git add -A -- *_DIFF_EXCLUDES` + `git commit -m "orcha: checkpoint <task_id> <run_id>"`. `settings.json` is a **tracked** file that `_overlay_runtime_config` (1989-1992) copies in per-worktree, so without the exclusion the local hook config would be committed onto the durable branch PRs are cut from (and it already leaks into captured diffs today — extending `_DIFF_EXCLUDES` fixes both). If nothing is staged after exclusions, **skip the commit** (clean tree → nothing to preserve, keep the worktree as-is).
  - If NOT a task worktree (ephemeral/non-code): behavior unchanged (`_teardown_worktree`).
- Apply the same task-worktree guard to the terminal-status exit branch (~2400-2410), which today also force-tears-down.
- **[m3] Cursor/ack framing corrected.** The reap-time wake-ack is already `{"kind":"released","release_lease":True}` with **no** `delivered_ts` — it does **not** advance the cursor. The only cursor advance is the spawn-time `delivered_ts` (2893). §2e's withholding therefore operates on the spawn-time ack, not the reap ack.

### 2c. Only delete task worktrees when safe
- A task worktree/branch is torn down only when the task is `completed`/`verified`/`cancelled`, or once a PR has captured the work. Add a cheap reaper hook: on tick, for tasks now terminal, `_safe_teardown_worktree` their `orcha/task-*` worktree + delete the branch only if it has no commits beyond `origin/main` and no open PR. Conservative by default (never delete a branch with unmerged commits; never delete if a PR is open).

### 2d. Record the durable reference
- Extend the `_finish_run` payload (and the task feed) with `saved_ref`: `{branch, worktree, has_commits, checkpoint_sha?, patch_captured: bool}` so the task page can show where the work lives. Post a short task-thread line on preserve, e.g. "checkpointed to orcha/task-… @ <sha>". These are **additive** run/feed fields — no destructive migration.

### 2e. Codex rate-limit classification (reuse existing helpers)
- `reap_workers` already resolves `w_runtime` (2384). In the **clean-exit** branch (2321), before defaulting to `status="exited"`, when `w_runtime == "codex"` derive status from the existing classifiers rather than raw returncode:
  - New thin wrapper `_codex_exit_status(log_path, returncode)` that calls the existing `_codex_result_status(log_path)` / `_codex_is_rate_limit` (1399/1561) and maps to `("rate_limited" | "failed" | "exited")`. No new from-scratch log scanner — it delegates to the tolerant scanners already on main.
  - On `rate_limited`/`failed`: `_finish_run(..., status="rate_limited"|"failed", kill_reason=…)`, **preserve** the task worktree (no teardown), and **do not** advance the cursor.
- **[R3 + m1] Withhold the spawn cursor, but bound it.** At spawn (2893) for a **task-worktree code wake**, set `delivered_ts=None` (do not advance the cursor) and stash the intended ack timestamp `ack_ts = cand.get("ack_through_ts") or cand.get("max_event_ts")` in `live_workers[aid]` (m1). On a **successful** reap, post the wake-ack with that stashed `delivered_ts` (cursor advances only after the work actually drained). On a **failed/rate-limited** reap, emit no `delivered_ts` — the events stay pending — **subject to these bounds**:
  - **(R3a) Bounded redelivery.** Track a per-(agent+task) consecutive-failed-drain count (in `live_workers` / respawn_ctx, persisted across respawns). After `N` (default 3) failed drains, advance the cursor anyway (emit the stashed `delivered_ts`) **and** emit a human-visible failure event (a `wake` failure notification / task-feed line: "worker for task … failed N times, releasing"). This prevents a deterministically-failing worker from hot-looping forever.
  - **(R3b) Rate-limit hold-down.** On `rate_limited`, parse the reset/`retry-after` time out of the `rate_limit_event` (best-effort; default backoff, e.g. 60s, if unparseable) and record a `hold_until` on the agent so wake-scan **skips this agent as a wake candidate** until then. This stops a still-limited Codex from re-waking on cooldown cadence and burning the retry budget. Precise timer-scheduled retry (waking exactly at reset) is a **follow-up** per reviewer Q3 — round 1 ships the hold-down only.
  - **Do not** ack/close pending notifications on a rate-limited drain (DoD item 3).

### 2f. Continuity digest synthesis (both runtimes)
- On a meaningful task-worker finish (non-empty diff or checkpoint commit), synthesize a minimal continuity digest without relying on the agent voluntarily calling `/orcha-snapshot`:
  - New `_synthesize_task_digest(agent_id, task_id, saved_ref, diff_summary)` → `POST /api/agents/{id}/digest` (verified present on main: append-only, latest-row-wins) carrying: current task id, saved branch/worktree, whether a PR/checkpoint exists, and a one-line "work in progress: …". For Claude this augments the SessionEnd hook; for Codex (no hook) this is the *only* digest write, so it runs from `reap_workers`.
  - **[m2] Codex-side guard.** `_rich_digest_posted_this_session` is Claude-transcript-based, so for Codex use a server check instead: only synthesize if `GET /api/agents/{id}/digest` has **no** row newer than the run's start time (i.e. the agent didn't already post a richer digest this run). Never clobber a newer agent-written digest.

## 3. Tests (add first, must fail on current behavior — issue §"Tests to add")
1. Codex task worker writes uncommitted `android/` file + exits 0 → reaper preserves it; next same-task wake sees the file (reuse-worktree or re-add-from-branch).
2. Same for a Claude ephemeral task worker.
3. Non-code request-answer wake still uses the cheap disposable path (no task worktree provisioned).
4. Clean task-worker exit with non-empty diff records a durable `saved_ref` (branch/worktree/patch) visible from the run.
5. Task worktree removed but branch exists → next wake reattaches to that branch (not origin/main).
6. Codex log with `rate_limit_event` + api status 429 on a **clean exit** → classified failed/rate_limited, spawn cursor NOT advanced, task worktree preserved, pending notifications not acked.
7. After a meaningful run, the next injected continuity state is newer than the run and free of stale pre-work instructions.
- Plus a bound test (R3a): N consecutive failed drains → cursor advances + failure event emitted (guards against the infinite hot-loop the withhold introduces).
- Plus a checkpoint-exclusion test (R2): a task worktree with only overlaid `.claude/settings.json` churn → checkpoint commit is skipped (clean after exclusions) and `settings.json` never lands on the branch.
- Place in `tests/test_worktree_diff.py` (1,3,4,5, R2), a new `tests/test_gh110_worker_continuity.py` (2,6,7, R3a), reusing fixtures from `test_wake_single_flight.py`.

## 4. Acceptance criteria mapping (issue §Acceptance)
Recreate Andrew's flow → covered by 2a/2b (reuse worktree + checkpoint), 2d (visible ref), 2e (rate-limit marked+preserved+bounded), tests 1/5/6. Both runtimes → `w_runtime` already tracked + clean-exit status dispatch added for Codex, task-worktree preservation is runtime-agnostic for Claude. No log reconstruction → tree persists. No-voluntary-snapshot → 2f. No cursor-skip / no-ack on rate limit → 2e (R3).

## 5. Constraints / non-goals
- Never auto-push, never open a PR automatically, never bypass review (issue explicit).
- No DB-destructive migrations without Kedar go-ahead; prefer additive run/feed/digest fields.
- Keep non-code wake path and resident/live worktrees untouched.
- Reuse existing helpers (`_terminal_status`, `_codex_result_status`, `_safe_teardown_worktree`, `_overlay_runtime_config`) — no parallel re-implementations.
- Full pytest suite + smoke must stay green; new tests fail-first.
- Human merges; agent stops at needs_verification.

## 6. Reviewer round-1 answers folded in
- Q1 → checkpoint-commit + keep worktree, **with** the R2 exclusion fix (keep-dirty-only rejected).
- Q2 → withhold `delivered_ts` until successful reap, **with** R3 bounds + m1 stashed ack_ts.
- Q3 → rate-limit hold-down (R3b) is in scope this round; precise timer-scheduled retry deferred to a follow-up.
