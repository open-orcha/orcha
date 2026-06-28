# Orcha — Conversation & Resident-Worker Model

> **Status:** design note (2026-06-04). An **improvement** to the episodic-agent model — not a
> pivot. We keep everything we have (ephemeral wakes, DB-bus, human-authority gates, continuity)
> and *add* a resident-session mode so a human can converse with an agent in the portal with a
> CLI-like feel. Source: extended Kedar×Tim brainstorm.

---

## 1. Why
Today an agent = many short headless `claude -p` wakes (episodic). That's great for *delegated,
verifiable* work, but it can't host a real back-and-forth (explaining nuanced intent, running tools
interactively, pair-debugging) — which is the core of agentic dev. We don't want to force users
back to raw CLI tabs. So: **portal orchestrates; the CLI is summoned only for the rare cases that
truly need a terminal; and most conversation moves into the portal** via a resident session.

## 2. Three communication modes (match the mode to the work)
| Mode | When | Channel | Worker |
|---|---|---|---|
| **Delegate** | Scoped, parallelizable, verifiable work (the 80%) | Task + DoD + context up front; structured async clarification | **Ephemeral** wake |
| **Steer** | Quick nudge / status / course-correct | Async prompt → reply | Ephemeral, or absorbed by a live resident |
| **Pair** | Deep/exploratory/interactive (the hard 20%) | Live conversation, streaming | **Resident** session |

The deep conversational loop doesn't disappear — it lives in **Pair** mode, now hostable *in the
portal* (resident session) instead of only a CLI tab.

## 3. The invariant: ONE embodiment per agent
**Per agent, ≤1 worker at a time. Ephemeral and resident are two MODES of the same agent and are
mutually exclusive.** Two embodiments of one agent would mean two writers on the same worktree,
double thread-posts, and — worst — **two divergent continuity (digest) streams that clobber each
other.** The persona+digest model assumes *one stream of consciousness per agent*.

- "Two workers at once" only ever means **two different agents** (e.g. Tim resident + Forge
  ephemeral) — normal fleet parallelism — **or** the one resident doing conversation *and* work
  in-process.
- If you want an agent to "grind in the background while we chat," it **delegates to another agent**
  (a different embodiment), it does not fork itself.
- **Live (resident) outranks autonomous (ephemeral).** While a resident is alive, it is the live
  listener; the daemon stands down for that agent and the resident **absorbs** incoming events.

### Per-agent state machine
```
        ┌──────────── idle timeout → snapshot digest → release lease ─────────┐
        ▼                                                                      │
   IDLE (0 workers)                                                            │
     │  ├── autonomous event ──► EPHEMERAL (1) ─ do work ─► exit ─► IDLE       │
     │  └── human prompt ───────► RESIDENT  (1) ────────────────────────────── ┘
     │                               ├─ holds + renews a LIVE lease
     │                               ├─ absorbs events for this agent (daemon stands down)
     │                               ├─ does conversation AND work in-process
     │                               └─ supports interrupt + permission/ask-human GUI
```
Per agent: **0** (idle) or **1** (ephemeral XOR resident). Events use the ephemeral path *only when
no resident is alive*; the resident is *human-prompt-initiated*.

## 3a. Queuing while busy (no mid-run fork)
A busy agent does **not** spawn a sub-agent to handle incoming work mid-run, and never forks a second
embodiment. **Today (episodic):** an event arriving while a worker runs is a no-op for that run —
it **queues**, and the daemon **re-wakes** the agent after it exits (single-flight; cf. wake-latency
PART 2 / ISS-21). **Resident:** identical principle — incoming messages / requests / nudges **queue
and serialize** into the one live session (FIFO, with priority ordering for high-priority events).
Real parallelism = delegate to **another agent**, never a second self. (Future option: let the
resident *peek* the queue and interleave between turns — but still one turn at a time, one embodiment.)

## 4. Resident session (the build, a.k.a. "Option B")
Swap the one-shot `claude -p <prompt> --output-format stream-json` (`notifier.py:239`) for a
**resident** `claude --input-format stream-json --output-format stream-json` that boots once
(persona+digest+history), **stays alive**, reads each human turn from stdin, and streams output
continuously. A resident process has a **live I/O channel**, so it *also* gives us true interrupt +
interactive tools — which the spawn-per-turn path could not. One build, three wins.

**Reuse (already built):**
| Need | Reuse |
|---|---|
| stream-json out → DB → SSE → portal | ISS-39 line-stream + B1/SSE client |
| lease + renewal each tick | #72 (`/wake-renew`) — extend with a `kind` |
| graceful end + digest-on-exit | #75 graceful kill + #60 C1 digest → repurpose as idle-reap → snapshot |
| persona/digest boot | `format_persona` |

**New:** resident-session spawn mode · conversation turn-bus (DB) · session lifecycle + idle reaper
· embodiment lease (`kind`) + wake-scan exclusion · interrupt + permission/ask-human GUI routing ·
resident-session resource caps + per-conversation budget.

## 5. The four mechanisms that make it feel live
1. **Warm daemon + renewed lease** — daemon is always up; the resident's lease is renewed for the
   session's life (the worker stays warm; per-turn cost ≈ new tokens only). *Residual: a one-time
   boot, not per-turn.*
2. **Cache-friendly injection** — stable prefix (persona+digest+history) + new message as suffix →
   Anthropic prompt cache (~5-min TTL) makes continuous back-and-forth cheap; full re-pay only
   across long gaps (acceptable).
3. **Interrupt** — a **Stop** button. Resident → true in-process interrupt; (fallback path for
   ephemeral = graceful-kill + respawn with the partial output injected). Generously renew the lease
   on stop (anticipate a reply within ~300s). Recommend dictation/STT to shorten human reply time.
4. **Interactive tools without a terminal** — slash/skill autocomplete in the composer; autonomous
   MCP calls (already headless-capable); **per-tool permission approval** routed to a portal GUI via
   `--permission-prompt-tool` / `canUseTool`; **clarifying questions** via an ask-human tool that
   blocks on a GUI answer; MCP OAuth handled by the web portal.

### 5.2 Warm-zone backlog drain — resident vs. ephemeral (GH #58)

While a resident holds the single-embodiment lease, the server's wake gate suppresses every ephemeral
wake for that agent, so its non-conversation notifications (task-thread notes, request answers,
decisions, assignments) **queue**. They must be drained without (a) bleeding task reasoning into the
warm conversation's context window and (b) breaking the one-embodiment invariant. The rule:

- **One already-awake run drains everything it CAN handle in that run, acking each as it goes** —
  never one fresh wake per notification. The server classifies each pending event into a *drain
  bucket* (`_drain_class` in `main.py`) and records a per-event ack in `agent_event_acks` (migration
  030), advancing the wake cursor to the **contiguous floor** — the ts just below the oldest
  still-unhandled waking event — so an event a run could not handle still re-surfaces instead of being
  skipped by a blanket high-water jump.
- **A row is left UNACKED for a fresh, protocol-bound ephemeral only when the current run cannot/should
  not handle it:**
  - **TASK_BOUND** (a task-thread message; a request answer carrying its originating task; a
    `plan_approval` decision on a live task) is handled **only by a run whose context == that task**; a
    different-task run leaves it pending.
  - **NEW_WORK** (an assignment/readiness on a `ready` task; a task-type request) is consumed at the
    `/next` claim or accept/reject seam — a drain never acks it.
  - **DIRECTIVE** (an assignment/rework on an `in_progress` task — incl. a `task_verified{approved:false}`
    rejected verify) is surfaced as the assignee's wake reason but acked only at that worker's clean
    completion / terminal seam (`/done`, cancel, unassign), never by an unrelated drain.
  - **FYI** and **taskless-actionable** rows need no task protocol, so **any** awake run may ack them.
- **Resident vs. ephemeral for the queued backlog:** the resident carries **no injected task
  protocol**, so its warm-zone drain **sidecar** (a throwaway one-shot in its own session, lease KEPT)
  handles **only FYI + taskless-actionable** rows. If the backlog contains **any** TASK_BOUND /
  NEW_WORK / DIRECTIVE row, the resident **yields its lease** so `tick()`'s next ephemeral — booted
  *with that task's protocol* — drains the whole backlog (the FYI rows ride along). The sidecar / worker
  posts the exact ids it handled to `POST /api/agents/{aid}/events/ack-handled` on a **clean exit
  only**; a crash marks nothing, so the events re-surface (no loss, no double-handling — the
  single-flight lease and per-event ack keep concurrent awake runs from racing).

## 6. What is genuinely CLI-only (needs a real PTY)
After the above, the irreducible "needs a terminal" set is small:
1. **Interactive TTY programs** — debuggers (`pdb`/`gdb` stepping), REPLs you drive, `vim`/curses
   apps, `git rebase -i`, `ssh`, `htop`.
2. **Interactive shell auth/credential prompts** — `gcloud auth login`, `sudo` password, 2FA at a
   prompt, the `! command` class.
3. *(Fidelity-only)* zero-latency rapid pairing with instant interrupt-and-continue.

**An embedded terminal (xterm.js) in the portal absorbs 1 & 2.** So "CLI-only" really means "needs a
terminal *surface*" — which the portal can host on demand. The genuinely-can't-be-in-the-portal set,
given an embedded terminal, is **effectively empty.**

## 7. Conversation options considered
- **A. Async turn-based** (ephemeral spawn-per-turn + history inject + reply-on-exit) — cheap,
  reuses the wake model; per-turn boot tax, no in-process interrupt. Good for slow Q&A.
- **B. Resident session** (chosen) — warm process, sub-second turns, true interrupt + interactive
  tools. Bigger build; resource cost; needs idle reaper + embodiment lease.
- **C. Embedded terminal** (`orcha use` in xterm.js) — full fidelity for the PTY residue, low effort.

**Decision: build B** (resident session) as the conversational core, **+ permission/ask-human GUI
routing**, **+ embedded terminal (C)** for the PTY residue. A remains the cheap fallback for pure
async pings.

## 8. Task breakdown
> Sequencing: **ISS-50 (heartbeat) → E1 lease → E2/E3 spike → DESIGN → Frame surface + Forge build**,
> with Vault continuity alongside. Keep it tight.

**Engine (Forge)**
- **ISS-50** heartbeat-on-poll — *in flight*; prerequisite for the lease/presence.
- **E1 — Embodiment lease:** add `kind` (ephemeral|resident) to the wake lease; wake-scan **excludes**
  agents holding a resident lease (enforce single-embodiment). Graceful handoff ephemeral↔resident
  (reuse #75 + #60).
- **E2 — Resident-session spike (time-boxed):** prove `claude --input-format stream-json` as a
  warm, multi-turn session fed from the DB bus, streaming to portal via existing SSE; demo interrupt
  + one permission-routed tool call. *De-risks before the full build.*
- **E3 — Conversation turn-bus + lifecycle:** conversation table; portal turn → resident stdin;
  reply-capture (reuse ISS-39); spawn-on-first-message, idle-timeout reaper, snapshot-on-end,
  concurrent-session cap + per-conversation budget.
- **E4 — Interactive affordances:** Stop/interrupt; `--permission-prompt-tool`/`canUseTool` →
  portal permission GUI; ask-human tool that blocks on a GUI answer.

**Continuity (Vault)**
- **V1 — Conversation-history injection:** inject last-N turns + persona + digest at boot,
  **cache-friendly prefix ordering**. Extends `build_wake_prompt`/`format_persona`.
- **V2 — Resident digest-on-end:** snapshot the resident's digest on idle-reap/exit (adapt C1).

**Surface (Frame)** — *blocked on DESIGN (§9)*
- **S1 — Conversation panel** (agent view): composer + message list + per-turn collapsible work log
  (SSE) + presence/status (idle·waking·working·replied).
- **S2 — Permission + ask-human GUI:** approve/deny tool cards; clarifying-question cards.
- **S3 — Pair / embedded terminal:** "Pair with this agent" → embedded xterm.js running `orcha use`
  (the PTY catch-all) with snapshot-back on close.
- **S4 — Slash/skill autocomplete** in the composer.
- **S5 — Stop button + presence indicator.**

## 9. Open questions / risks
- **Resident resource footprint** per session → idle reaper + concurrency cap are mandatory.
- **Exact behavior of `claude --input-format stream-json`** as a resident multi-turn session
  (warm context, interrupt, permission routing) — the E2 spike must validate before committing E3/E4.
- **Cost** — warm sessions are cheap per-turn but hold context; long idle sessions must be reaped;
  consider per-conversation budgets.
- **Embedded terminal security** (xterm.js → a real shell in the portal) — local/trusted only to
  start; revisit before any remote/multi-tenant deployment.
