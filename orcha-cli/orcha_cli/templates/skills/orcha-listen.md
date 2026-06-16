---
description: Wait (long-poll) for the next server-pushed event addressed to me, then act on it. Drastically cheaper than /orcha-checkpoint polling — Claude is only invoked when an event actually arrives.
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: "[--timeout N] [--alias <name>] [--auto-accept-task] [--auto-close]"
---

You are executing `/orcha-listen` (Phase 3 / Orcha#5 — addresses the polling-cost concern from Orcha#3).

## What this does

Connects to `GET /api/agents/<my_id>/wait` — a long-poll endpoint that blocks for up to `--timeout` seconds (default 30, max 120) and returns the next event. Events arrive when:
- An incoming request lands (info or task)
- One of your outgoing requests gets answered
- One of your outgoing requests gets closed by the target
- A task you're assigned to was just verified
- A task gets newly readied (only container-wide events delivered here when relevant)
- A `timeout` event when nothing happened in the window

Unlike `/orcha-checkpoint`, the LLM here is invoked ONCE per real event (plus once per timeout). Polling cost on the DB side is server-internal, free.

## Steps

1. **Identify the acting agent** (4-step resolution; needed for both the URL and the action that follows). Note the resolved `<alias>` — the replay cursor in step 3 is keyed by it.

2. **Read `.claude/orcha.json`** for `api_base_url`.

3. **Read the replay cursor**, then **long-poll once with it** (Orcha#25 — Bug1 fix).

   The `/wait` endpoint returns *the first event newer than `since_ts`*. If you never send `since_ts`, it keeps returning the SAME latest event on every call — you reprocess one event forever and never advance. So each invocation must send the timestamp of the last event you already handled, persisted per-alias between invocations:

   ```bash
   CURSOR_FILE=".claude/orcha-tabs/<alias>.last_event_ts"
   SINCE_TS=$(cat "$CURSOR_FILE" 2>/dev/null || echo 0)
   curl -fsS --max-time 60 "<api_base_url>/api/agents/<agent_id>/wait?since_ts=${SINCE_TS}&timeout=<timeout-or-30>"
   ```
   Response: `{event: "...", ts: <epoch>, ...}` or `{event: "timeout", ts: ...}`.

   **Immediately after a NON-timeout event arrives, write its `ts` back to the cursor file BEFORE you act on it** — so a crash mid-action, or the next loop iteration, won't replay it:
   ```bash
   printf '%s' "<the event's ts>" > ".claude/orcha-tabs/<alias>.last_event_ts"
   ```
   On a `timeout` event, leave the cursor unchanged (nothing was consumed).

   > Why a file and not memory: each `/loop /orcha-listen` iteration is a fresh skill invocation with no shared state, so the cursor has to outlive the process. `.claude/orcha-tabs/<alias>.last_event_ts` sits beside the binding file and is per-agent, so two agents in the same project never clobber each other's position.

4. **Switch on `event`** and act (the cursor has already been advanced in step 3 for any non-timeout event):
   - `timeout` → report "no events in window" and stop. Cursor unchanged. The user can `/loop /orcha-listen ...` to chain another wait.
   - `request_created` → it's an incoming request. Run `/orcha-inbox` to see the full detail, then either:
     - If you can confidently synthesize an answer from context: `/orcha-respond <request_id> "<answer>"`.
     - If it's a task request and you're equipped: `/orcha-accept-task <request_id>`.
     - If you can't / shouldn't: leave it for the human, just report it.
   - `request_answered` → one of your asks got an answer. Read the answer (via `/orcha-outbox?--status=answered`), decide: close, convert, or chain. If `--auto-close` is set AND the answer looks sufficient, call `/orcha-close <request_id>`.
   - `request_closed` → a request you were the target of was just closed by the requester. Acknowledge; usually no action needed.
   - `prompt` → a directed message (A3): the event's `message` field is a human/teammate prompt aimed at you. Act on it specifically — answer it, or do the work it asks for and report back. (`from_agent_id` names the sender, if any.) Don't just treat it as generic inbox noise.
   - `task_assigned` → a new task is yours. Begin work; surface to the user.
   - `task_verified` → a task you did was approved (or rejected with feedback). Tell the user; if rejected, address the feedback.
   - `task_ready` → a previously-blocked task may now be claimable via `/orcha-next`.
   - `agent_suggestion_decided` → if you suggested a new agent, this is the human's verdict. Surface to the user.

5. **Report** what happened compactly. Then stop. The caller's `/loop` (if any) re-enters for the next event.

## Recommended use

```
# in the agent's tab, AFTER /orcha-register-agent:
/loop /orcha-listen --alias <name> [--auto-accept-task] [--auto-close]
```

`/loop` without an interval lets the model self-pace; this skill returns within `--timeout` so the loop fires roughly that often. With server-side push, the inter-event latency is just network + Claude's iteration overhead, not a configured polling cadence.

## Compared to /orcha-checkpoint

| | `/orcha-checkpoint` | `/orcha-listen` |
|---|---|---|
| How it polls | client calls /inbox + /outbox at a fixed cadence | server blocks the connection until something happens |
| LLM cost per quiet minute | 6 / 60 turns (10s / 60s polling) | ≤ 2 turns (one timeout per 30s) |
| Latency to first action on an event | up to interval seconds | sub-second |
| When to use it | when the server doesn't support `/wait` or you want a simple/explicit poll | almost always, now that the server supports it |

`/orcha-checkpoint` remains available for explicit one-shot status checks (the "did anything change?" question) — it just shouldn't be in a tight loop anymore.
