# E2 — Resident-session spike: findings

**Time-boxed feasibility spike** to de-risk the resident-worker model before committing E3/E4. Built
by Forge. Prereq ISS-50/#82 merged. Throwaway harness: `spikes/e2/drive_resident.sh`. Environment:
`claude` v2.1.160 (macOS).

> **Source plan:** `docs/orcha-conversation-model.md` §4 (resident session), §8 (task breakdown:
> E1–E4), §9 (open questions/risks the spike answers). That design note was previously untracked
> (local-only); it is **added to the repo in this PR** so these findings map back to the source
> (review #111 [P2]).

## TL;DR — **GO** for the CLI-driven core (E3); interrupt + permission-GUI (E4) need the Agent SDK

The resident multi-turn session works today via the plain CLI and slots straight into our existing
stream → DB → SSE plumbing. The two genuinely-interactive affordances (Stop/interrupt and per-tool
permission approval) are **not** reachable through CLI flags in v2.1.160 — they require the **Claude
Agent SDK** (`canUseTool`, `query.interrupt()`). Recommendation: build E3 on the CLI now; gate E4 on a
small, deliberately-added SDK dependency (validate interrupt + `canUseTool` there).

## What was validated (live)

| # | Question (§9) | Result | Evidence |
|---|---|---|---|
| 1 | **Warm multi-turn** — one process, context retained across turns | ✅ **PASS** | `drive_resident.sh warm`: **single `session_id`** across 2 turns; turn 1→`STORED`, turn 2 recalled the codeword `Zephyr-7` it was told in turn 1 |
| 2 | **Realtime streaming** compatible with ISS-39 | ✅ **PASS** | `--include-partial-messages` emits Anthropic-style `stream_event` deltas (`message_start → content_block_delta×N → message_stop`), all NDJSON — identical line shape the ISS-39 daemon already pumps to `worker_run_lines` → SSE |
| — | **I/O protocol** | ✅ documented | see below |
| 4 | **Permission routing via CLI** | ❌ **not available** | `--permission-mode default` + `--allowedTools 'Read'` (Bash *not* allowed): claude **still ran** `Bash(echo …)`, `permission_denials=[]`. Plain `-p` headless auto-proceeds / inherits parent perms; **no routable permission-prompt event**. No `--permission-prompt-tool` flag exists in v2.1.160 (`claude --help`). |

## I/O protocol (for E3)

- **Spawn:** `claude -p --input-format stream-json --output-format stream-json --include-partial-messages --verbose`
  (boot persona+digest via `--append-system-prompt` / `format_persona`; `--session-id <uuid>` to pin
  identity; `--resume`/`--fork-session` to continue).
- **One user turn on stdin = one NDJSON line:**
  `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}`
  Write the next turn's line when ready; the session stays warm between turns (stdin stays open).
- **Per-turn completion boundary** for reply-capture = the `{"type":"result","subtype":"success",
  "result":"…","session_id":…,"num_turns":…}` event. (`--replay-user-messages` echoes inputs back on
  stdout if the consumer wants a unified ordered log.)
- **Stream shape:** `system/init` → `rate_limit_event` → (`stream_event` deltas if partials on) →
  `assistant` → `result`. Same NDJSON the ISS-39 pump already handles.

## Mapping to reuse (confirmed viable)

| Need | Reuse | Status |
|---|---|---|
| stream-json out → DB → SSE → portal | ISS-39 line-stream + B1/SSE | ✅ same NDJSON; drop-in |
| lease + renewal each tick | #72 `/wake-renew` (+ a `kind`) | ✅ (E1) |
| graceful end + digest-on-exit | #75 graceful kill + #60 C1 → idle-reap→snapshot | ✅ |
| persona/digest boot | `--append-system-prompt` + `format_persona` | ✅ |

## Not validated live (blocked / out of time-box) — with the de-risked path

- **Interrupt (E4):** no CLI interrupt flag / stdin control message surfaced in `claude --help` v2.1.160.
  The **Agent SDK** exposes `query.interrupt()` on the streaming-input query object — that's the
  intended mechanism (Stop button → `interrupt()`; the session survives and accepts the next turn).
  *Also worth a look:* the new `--remote-control` flag (interactive session w/ "Remote Control") may
  offer an external control channel — investigate in E4.
- **Permission GUI routing (E4):** use the Agent SDK **`canUseTool`** callback — it intercepts each
  tool call and returns allow/deny, which is exactly the portal approve/deny GUI hook. (Alternative:
  an MCP `--permission-prompt-tool` server, but no such CLI flag in this version.)
- **Why not demoed here:** the Agent SDK isn't installed in this sandbox, and an agent-initiated
  `pip install claude-agent-sdk` is (correctly) blocked as an undeclared supply-chain dependency. This
  is a deliberate E4 step: add `claude-agent-sdk` (py) or `@anthropic-ai/claude-agent-sdk` (node) to a
  manifest, then validate `canUseTool` + `interrupt()` in a tiny harness. Low risk — these are
  documented first-class SDK features; the spike's purpose was to confirm the CLI core (done) and
  locate the affordances (done).
- **Footprint:** trivial turns ran ~2.3 s each (`duration_ms` per `result`). A real per-session
  RSS/idle-cost measurement needs a longer-lived session — fold into E3's idle-reaper + concurrency-cap
  sizing.

## Recommendation / sequencing impact

1. **E3 (core) — GO on the CLI** as proven: resident `claude -p --input-format stream-json …`, turns
   from the conversation bus → stdin, replies captured at each `result`, streamed via the ISS-39 path.
   No new external dependency.
2. **E4 (affordances) — gate on the Agent SDK.** Add it as a declared dependency, then validate
   `interrupt()` + `canUseTool` (and evaluate `--remote-control`). Until then, E3 ships the
   conversational core; Stop/permission GUI follow in E4.
3. **E1 lease** (`kind`=resident + wake-scan exclusion) is unaffected and can proceed in parallel.

**No product code changed by this spike** — findings + throwaway harness only.
