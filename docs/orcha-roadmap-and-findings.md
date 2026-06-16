# Orcha — Roadmap & Findings (reconstructed after DB loss)

> Reconstructed by **Tim** (TPM agent) on 2026-05-31 after `orcha init --force` dropped the
> Postgres volume and wiped the live coordination DB (container `af1de676`, agents, and task
> `328b9ddf` with the full feedback synthesis). The **code** survived in PRs #39/#40/#41 and the
> `integration/all-epics` branch; this file restores the **roadmap + findings** that lived only in
> the task thread.

## How we got here
Human (kedar) ran a dogfooding exercise: leader agent **Tim** interviewed the human + ran 3
interviewer agents (Reese/Page/Dock), synthesized a numbered top-10, regrouped into 3 epics,
spun up implementer agents (Forge/Frame/Vault), and drove them to PRs — all while using Orcha
live so its own pain points surfaced.

## The numbered top-10 → regrouped into 3 epics (+ standalone)

**Epic A — Wake & Self-Movement** (PR #41 `feature/epic-a-wake-autostart`, merged-ready, CI green)
- **#1 Notifier daemon + reachability registry** — one persistent non-AI daemon watches Postgres,
  resolves per-agent reachability, emits out-of-band WAKE (tmux send-keys for live-context;
  headless `claude -p` for out-of-band admin). ON by default; disable optional. Phase-0 = cron
  self-rearm stopgap (shipped, demonstrably caught a missed event). Subsumes Orcha#5 + #33.
- **#2 Auto-start on ready tasks** — auto-claim+begin iff assigned AND ready AND no wait-instruction
  AND not paused AND idle AND budget-ok; NEVER touches the verify gate; initial_task made consistent.
  Daemon-side wake idempotency via `agent_wake_state.delivered_ts` + cooldown.

**Epic B — Portal Control Surface** (PR #40 `feat/epic-b-portal-control`, P1+P2 only; P3/P4 GATED)
- **#3 Verify/Reject buttons** (backend existed; identity = (c)+(a) no-auth MVP). ✅ shipped
- **#6 Authoritative-close-with-implications** (aggregate downstream tasks/agents/child-requests). ✅ P2
- **#7 Decision-checkpoint** (agents surface decisions; human approve / STOP-with-rollback). GATED
- **#8 Human-only HOLD state** (agent STOPS + rolls back; AI agents can't hold). GATED
- **#9 Task-thread view + summarize in portal** (+ fix the 422 body-cap bug). partial
- One frozen STOP contract for #7+#8: `agent_held{agent_id,task_id?,held_by,reason}` + `hold_lifted`,
  emitted server-side by the Epic-B endpoint, consumed agent-side by Epic A's wake handler.

**Epic C — Persistence & Resume** (PR #39 `feat/epic-c-agent-digest`, merged-ready, CI green)
- **#4 Per-agent memory digest** — DB table `agent_memory_digests(agent_id, container_id,
  snapshot_ts, current_focus, decisions[], learnings[], open_threads[])`; agent-authored; snapshot
  on cadence + on /orcha-done. COMPLEMENTS Claude Code file-memory (no sync; CC owns durable
  user/project facts, the digest owns per-agent work/reasoning state).
- **#5 Auto-resume on SessionStart + rehydrate** — hook detects stack, rebinds alias, prints
  "where we left off". Depends on #4.

**#10 Rename `container` → `workspace`** — human-confirmed; one atomic isolated PR; PARKED to avoid churn.

## Backlog / candidate issues (ranking deferred)
- **#11 Leader team-provisioning** — let a leader agent emit a multi-agent roster the human bulk-spawns
  (extends /orcha-suggest-agent). (CAND-A)
- **#12 Ambient-context background subagent** — watcher feeds cross-discussion context to working agents
  (cost-flagged, opt-in).
- **#13 Portal authentication** — real per-human login (MVP is no-auth).
- **Per-agent isolated git worktree by default** — multi-agent same-directory safety. Provision a
  worktree+branch at /orcha-register-agent. (Proven live by the B/C branch tangle.)
- **Wake must drain FULL inbox; notifications need ack/auto-close** — anti-queue-stranding.
- **Consumer-side request/event idempotency** — `/wait` is caller-cursor at-least-once with no
  server-side per-consumer ack; mutation endpoints 409 on repeat (safe, not idempotent). Directions:
  consumer-offset/ack table; make respond/close/accept return 200-on-repeat; idempotency keys.
- **Shared machine-state isolation** — agents share the machine `gh` active account; it flipped from
  kedar1607→nazuka-quantal mid-session and broke repo access. Same class as the worktree tangle.
- **task-message body 422 cap** — silent failure on long /orcha-post bodies; add clear error + client guard.

## Findings (surfaced live by dogfooding)
1. **Wake/idle is the #1 pain** — an idle Claude tab never resumes on its own; demonstrated live when
   Forge/Frame/Vault sat idle with unread requests. Fix = Epic A.
2. **Reviewer blind-spot** — the leader (and human) can't see other agents' task threads or in-tab
   approvals via the event bus; only direct-addressed requests wake you. Strengthens #7 + #9.
3. **Orcha authority ≠ harness authority** — a human decision relayed through the Orcha message bus
   does NOT satisfy Claude Code's per-session permission layer for destructive ops (force-push needed
   in-session human auth). Bounds the "human-authoritative" premise; candidate: define what Orcha can
   authorize vs what must be in-session.
4. **Plan-approval vs verify ambiguity** — agents treated `/orcha-verify` as the gate and built risky
   work on-branch before plan approval; nothing on main so authority held at verify. = the #7 gap.
5. **Worktree isolation** — sharing one checkout tangled Epic B/C branches silently; agents with their
   own worktrees were unaffected. → isolation should be default.
6. **`orcha init --force` is destructive** — overwrites `.orcha/` and creates a NEW container; combined
   with a `-v` it wiped the DB. The safe relaunch is **`orcha up`** (keeps the pgdata volume) or
   **`orcha connect <project>`**. NEVER `orcha down -v` / `init --force` to relaunch. This is the exact
   "reconnect to the same container" goal Epic C targets — make `orcha up` the obvious default and guard
   the destructive paths.

## What's safe vs lost (post-wipe)
- SAFE: PRs #39/#40/#41 (GitHub), `integration/all-epics` (local), worktrees `Orcha-epicA/B/C` (local).
- LOST: container `af1de676`, agents Reese/Page/Dock/Forge/Frame/Vault, task `328b9ddf` thread,
  request/audit trail. Not recoverable (volume dropped, no backup).
