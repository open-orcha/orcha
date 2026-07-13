# Conversation Embodiment: Codex vs Claude

> **Status:** current as of PR #243 (`codex/add-codex-support`), 2026-06-11. Author: Page.
> Line citations are against the PR-243 branch tip (`8b67bc19`); code moves, so treat them as
> "look here," not gospel. Trust the source over this doc and fix the doc when they disagree.

## TL;DR

Orcha runs an agent as **one embodiment at a time** — ephemeral *xor* resident *xor* live-terminal.
How a human↔agent **conversation** is serviced depends entirely on the agent's **runtime**:

| | **Claude runtime** | **Codex runtime** |
|---|---|---|
| Conversation session | **Warm resident** — long-lived `claude -p --input-format stream-json` with an open stdin pipe | **None** — Codex `exec` is one-shot, no stdin protocol |
| Per human turn | Fed into the *same* warm process via stdin | A *fresh* `codex exec --json` worker spawned, replies, exits |
| Embodiment lease | `lease_kind="resident"` | `lease_kind="ephemeral"` |
| Reply transport | Resident emits result → posted to conversation | One-shot worker's final message → posted to conversation |
| Restart safety | pid persistence + reconcile (PR #225, mig 013) | **none on this branch — see Blocker** |

So when you message a **Codex** agent and see an **ephemeral worker** spawn, that is **by design**:
Codex has no warm resident, so *every conversation turn is a one-shot ephemeral worker*.

## The invariant

One embodiment per agent, enforced at the lease layer. `wake_claim` is an atomic single-flight
INSERT/UPDATE that only succeeds if no unexpired lease exists (`main.py` `wake_claim`), and the
wake-scan gate refuses to spawn anything while a lease is live:

```
should_wake = active and wakes_enabled and wake_enabled
              and has_work and is_idle and not in_cooldown
              and not lease_active            # main.py:2335
```

`lease_kind` is one of `ephemeral | resident | live` (`main.py:2213`). A warm resident "holds the
single-embodiment lease, so the wake gate suppresses every ephemeral wake for its duration"
(`main.py:2071`) — remember this; it explains the close→ephemeral hand-off below.

## Claude path — warm resident

```
human posts turn  ──►  conversation_turn event
                       │
       service_residents() (notifier.py) sees pending_human
                       │
       boots a RESIDENT (spawn_resident, notifier.py ~:499)
       claude -p --input-format stream-json, OPEN stdin
       lease_kind="resident"
                       │
       feeds the next human turn via stdin (_next_human_turn)
       result captured ──► POST /api/conversations/{cid}/turns (main.py:1896)
                       │
       stays warm; next turn reuses the same process
                       │
       idle > 900s  ──►  _close_resident(reason="idle")  (notifier.py:1953-1954)
                         releases the lease
```

- Resident idle-reap threshold: `RESIDENT_IDLE_REAP_SECS = 900.0` (`notifier.py:1353`).
- `_close_resident` (`notifier.py:1716`) closes stdin (graceful EOF → SessionEnd/snapshot runs),
  finishes any in-flight run, and releases the embodiment lease.
- Queued extra human turns are fed FIFO to the *same* warm resident once it finishes the current
  turn (`_next_human_turn`); the lease is held throughout, so it is guaranteed the same session.

## Codex path — one-shot ephemeral per turn

Codex's automation surface is `codex exec`, which cannot hold an open stdin stream-json session.
`spawn_resident` explicitly refuses non-Claude runtimes and returns "unsupported." So
`service_residents()` has a dedicated Codex branch (`notifier.py` ~:1962):

```
human posts turn  ──►  conversation_turn event
                       │
       service_residents() Codex branch (notifier.py ~:1962)
       wake-claim  lease_kind="ephemeral"  (notifier.py:1982)
       provision isolated worktree (refuses shared checkout)
       create worker_run (wake_kind=ephemeral)
                       │
       spawn_headless(runtime="codex"):
         codex exec --json --dangerously-bypass-approvals-and-sandbox
                    --skip-git-repo-check [--model …] --output-last-message <f>
       persona/digest prepended to the prompt (no --append-system-prompt for codex)
                       │
       tracked in live_residents[conv_id] with runtime="codex"
                       │
       on proc exit (notifier.py §1, ~:1757): read final message
         (--output-last-message primary, JSONL fallback)
         ──► POST /api/conversations/{cid}/turns
         finish run "exited", release lease, teardown worktree
```

- The reply extractor (`_conversation_reply_text`) accepts both the Codex last-message file and a
  JSONL fallback that tolerates Claude stream-json *and* Codex assistant shapes, so a CLI format
  drift fails soft (a note in the conversation) rather than leaving the tab blank.
- Model→runtime resolution is server-side: `AVAILABLE_MODELS` now carries a `runtime` field and
  `resolve_model_runtime()` maps a persisted model id to `claude|codex` with the same zero-breakage
  fallback as `resolve_model()` (`main.py:266-310`). `gpt-5.x` ids resolve to the codex runtime.

## Why you see "resident closes → ephemeral appears" (even without PR #230)

This is a frequent point of confusion. It is **not** PR #230 (ISS-78 drain-yield) — that code is
**not merged** and is absent on this branch. The close→ephemeral hand-off is produced by
**pre-existing** mechanics:

1. While a **Claude resident** holds its `resident` lease, the wake gate **suppresses every
   ephemeral inbox wake** (`main.py:2071`, `:2335`). Inbox work that arrives mid-conversation
   (a request answer, task message, escalation) is **queued, not run.**
2. The resident **idle-reaps at 900s** → `_close_resident(reason="idle")` **releases the lease**
   (`notifier.py:1953-1954`).
3. The very next wake-scan sees `lease_active=false` + the still-pending inbox work → `should_wake`
   flips true → `tick()` spawns an **ephemeral** worker to drain it.

So: the resident closes, and the previously-suppressed inbox work immediately surfaces as an
ephemeral worker. **PR #230 changes this** (the resident proactively *yields* to an ephemeral drain
to avoid context-bleed into your conversation, instead of waiting up to 15 min for idle-reap and
draining in-session via `build_resident_drain_prompt`, `notifier.py:245`) — it does not *introduce*
the visual.

Other (rarer) producers of the same visual: a **Codex** agent (every turn is a fresh ephemeral by
design) and a **watchdog crash→respawn**. To know which fired for a specific instance, pull the
run/event trace for that agent + timestamp rather than inferring.

## 🔴 Known blocker — Codex conversation workers are not restart/crash-safe

The Codex worker's whole lifecycle — finishing the `worker_run`, posting the reply, releasing the
lease, tearing down the worktree — lives **only in the running daemon's in-memory
`live_residents`** dict. Nothing durable is persisted. If the notifier restarts mid-turn (turnover
is a recurring event here):

1. The new daemon's `live_residents` is empty → the orphaned run is never finished → the row
   **strands as `running` forever.**
2. The orphaned `codex exec` may write its reply to `--output-last-message`, but nobody reads it →
   **the agent's reply is silently dropped.**
3. Once the orphan's wake-lease lapses on TTL (no daemon to renew it), the next `service_residents`
   pass sees `pending_human` still true → **spawns a second Codex worker** for the same turn
   (transient double-spawn if the orphan is still alive).

**Live witness:** on 2026-06-11, Invy's run `fde45231` was stuck `running` with no live process and
`pid=NULL` — exactly this orphan. It had to be reconciled to `killed` by hand.

**Root cause:** this is the Codex analog of what PR #225 fixes for Claude residents (mig 013 pid
persistence + dead-pid boot reconcile). On the PR-243 branch, **migrations stop at 012** and the
Codex run carries no pid, so there is **zero** orphan protection on this path. (A
`013_worker_run_process_tracking.sql` migration is in progress in the working tree at the time of
writing — the fix for this gap.)

**Recommended fix:** persist the Codex worker's pid on the run row and reconcile dead-pid `running`
Codex runs at daemon boot (finish them; re-read `--output-last-message` to recover the reply if
present). Ideally fold into / depend on PR #225 rather than duplicating the mechanism.

## Task-worker continuity (GH #110)

The asymmetry above — **Codex has no SessionEnd hook, so it never writes a continuity digest on
its own**, while Claude's SessionEnd `orcha snapshot` hook only fires on a voluntary clean close —
also bit the *task-wake* code-worker path (a different path from the conversation embodiment above:
`tick` → `spawn_headless` → `reap_workers`, runtime-agnostic). There, a code-touching task worker
that exited cleanly with **uncommitted** changes lost its whole worktree, because `reap_workers`
force-removed the ephemeral worktree (`_teardown_worktree`) after capturing the ≤200 KB diff text.
The next same-agent+same-task wake re-provisioned a fresh **timestamped** worktree from
`origin/main` and started blind. (This is how Andrew's Android APK — built in a timestamped worker
folder — vanished and had to be reconstructed from run logs.)

GH #110 gives task-wake code workers cross-wake continuity, for **both runtimes**:

- **Durable per-(agent+task) worktree/branch.** `_provision_task_worktree` keys a stable
  `orcha/task-<alias>-<task>` branch + `.orcha-worktrees/task-<slug>` worktree (not timestamped).
  First wake creates it from `origin/main`; later wakes **reuse** the dir or **re-add from the
  branch** — never restart from `origin/main`.
- **Preserve on clean exit.** On a clean exit with a dirty tree, `reap_workers` makes a local
  **checkpoint commit** on the task branch (excluding overlaid config like the tracked
  `.claude/settings.json`) and **keeps** the worktree. Never auto-pushes, never opens a PR, never
  bypasses review. The worktree/branch is only torn down once the task is
  completed/verified/cancelled or a PR has captured the work.
- **Terminal-task reclaim.** A tick-time reaper (`reap_terminal_task_worktrees`) sweeps durable
  `orcha/task-*` worktrees once their task reaches a terminal state (`completed`/`cancelled`;
  `verified` collapses to `completed` in this schema) — otherwise the preserved trees would
  accumulate forever. It is conservative by construction: it skips a worktree an in-flight worker
  still holds, **preserves** any dirty tree (uncommitted work is never discarded, excluding the
  overlaid runtime config), and deletes the branch **only** when it carries no commits beyond
  `origin/main` — so a committed branch (necessarily true for any open PR) is always kept. A
  daemon-scope `swept_tasks` set bounds it to one pass per terminal task, and it clears that task's
  bounded-redelivery counter (a terminal task can no longer fail-drain). A checkpoint respawn's
  rebuilt worker now also carries the `task_worktree` flag + withheld cursor across the swap, so a
  respawned task worker's later clean exit still preserves (never force-removes) its durable
  worktree.
- **Reap-time digest synthesis.** Because Codex has no SessionEnd hook, `_synthesize_task_digest`
  posts a minimal continuity digest (`POST /api/agents/{id}/digest`) straight from `reap_workers`
  after a meaningful run — so the next boot resumes from prior state **without** relying on a
  voluntary `/orcha-snapshot`. For Claude it augments the SessionEnd hook; it never clobbers a
  newer agent-written digest.
- **Codex 429 is a failed drain, not a success.** A Codex `rate_limit_event` / `api_error_status:429`
  on a clean exit is classified `rate_limited` (via the existing `_codex_result_status` /
  `_codex_is_rate_limit` scanners), records `status="rate_limited"` on the run, **preserves** the
  worktree, does **not** advance the wake cursor, and does **not** ack/close pending notifications —
  with a bounded-redelivery counter and a rate-limit hold-down so a still-limited worker doesn't
  hot-loop.

This is the task-path analog of the restart-safety gap described in the blocker above: the
conversation path still needs the pid-persist fix; the task path now persists work as a durable
branch + digest instead of holding it only in the daemon's memory.

## Trade-offs

- **One-shot Codex per turn** is simple and crash-isolated *per turn*, but loses warm in-session
  context between turns (each turn re-injects thread history into a fresh `codex exec`), costs a
  cold start per turn, and — until the blocker is fixed — is fragile across daemon restarts.
- **Warm Claude resident** keeps context and is cheap per turn, but holds the embodiment lease,
  which **suppresses inbox wakes** for up to the 900s idle window (the ISS-74 / #230 tension).
- **Security:** Codex spawns with `--dangerously-bypass-approvals-and-sandbox` — it disables the
  *sandbox* on top of approvals (broader than Claude's `--dangerously-skip-permissions`). Defensible
  under the local-trusted-daemon + isolated-worktree model, but a conscious sign-off: Codex agents
  run fully unsandboxed in a worktree off the repo.

## Open questions

1. **Block PR #243 on the restart-safety fix, or merge + fast-follow?** The bug is already live
   (Invy). The in-progress mig 013 suggests "fix first" is the intent — confirm.
2. **Codex turn context:** is re-injecting thread history per turn acceptable long-term, or do we
   want a Codex `resume`-based warm path (the PR mentions live `codex resume` for terminals) for
   headless conversations too?
3. **Sandbox bypass:** sign off on Codex running unsandboxed, or scope it (e.g. allow-list)?
4. **#230 sequencing:** ship the drain-yield so the inbox-suppression window closes, independent of
   the Codex work?

## Source map

- `notifier.py` — `spawn_headless` (~:360, runtime-aware argv), `spawn_resident` (~:499,
  Claude-only), Codex conversation spawn (~:1962), Codex lifecycle (§1, ~:1757), idle-reap
  (`:1953`), `_close_resident` (`:1716`), `build_resident_drain_prompt` (`:245`).
- `main.py` — `AVAILABLE_MODELS`/`resolve_model`/`resolve_model_runtime` (`:266-310`), wake-scan
  gate (`:2335`), lease-suppression note (`:2071`), `POST /api/conversations/{cid}/turns`
  (`:1896`), `wake_claim` single-flight.
- Migrations — `010_wake_kind_ephemeral`, `011_preempt_yield`, `012_resident_cold_resync`
  (013 pid-tracking pending).
- Related: PR #225 (Claude resident pid reconcile), PR #230 (ISS-78 drain-yield), ISS-74
  (resident lease suppresses wakes).
