---
description: Answer a request addressed to the acting agent with your real result. Works for an info request (open → answered) and for a task request you accepted once the work is materially done (accepted → answered).
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: <request_id> "<answer text>" [--alias <name>]
---

You are executing `/orcha-respond`.

User arguments: `$ARGUMENTS`

## What this is for

This is how you give the requester the ANSWER they're waiting on — for an info request (`open`),
or for a task request you accepted (`accepted`) once the work is materially complete. Answering is
the event that WAKES the requester, so the `response` must carry your actual result: what you found,
decided, built, or where it landed. Do NOT send a content-free receipt ("done", "ack", "accepted",
"on it") — that wakes the requester with nothing to act on. If the work isn't materially finished
yet, don't respond; keep working and answer once you have a real result.

## Steps

1. **Parse `$ARGUMENTS`**:
   - First positional: `request_id` (UUID — typically copied from `/orcha-inbox`)
   - Remaining quoted: `response` (your answer)
   - Optional `--alias <name>` — see step 2

2. **Identify the acting agent** (REQUIRED — must be the request's target) using this resolution order — STOP at the first match:
   1. **`--alias <name>` in `$ARGUMENTS`** → use that alias.
   2. **`$ORCHA_ALIAS` env var** (`printenv ORCHA_ALIAS`) → if non-empty, use it.
   3. **Single binding fallback** → if `.claude/orcha-tabs/` contains exactly one `*.json` file, use its alias.
   4. **Else** (multiple bindings, no disambiguator):
      - If ZERO binding files → STOP: `Only the request's target agent can respond. Register first via /orcha-register-agent.`
      - Otherwise → use **AskUserQuestion** to ask `"Which agent is responding?"` with one option per registered alias. Use the user's pick.

   Read `.claude/orcha-tabs/<alias>.json` to get `agent_id` (used as `responder_agent_id`).

3. **Read `.claude/orcha.json`** for `api_base_url`.

4. **POST**:
   ```bash
   curl -fsS -X POST "<api_base_url>/api/requests/<request_id>/respond" \
     -H 'Content-Type: application/json' \
     -d '{"responder_agent_id": "<my agent_id>", "response": "<answer>"}'
   ```
   Response: `{"request_id": "...", "status": "answered"}`

5. **Report**: `request <short-id> answered. Requester wakes on your result; they will /orcha-close <rid> --alias <their_alias> or /orcha-escalate.` If this was a task request you accepted, answering does NOT send the spawned task to verification — run `/orcha-done <spawned_task_id> "<result>"` separately for that.

## Missing required arguments

If `request_id` or `response` is missing from `$ARGUMENTS`, use **AskUserQuestion** to collect them. For `request_id`, suggest running `/orcha-inbox` first to see what's available. For `response`, free-text. Bundle into one call when both are missing.

## Errors

- **403** "only the target agent may respond" → this request is addressed to someone else; check `/orcha-inbox` for what's actually yours.
- **409** "request is '<status>', not 'open'/'accepted'" → already answered/closed, or a task request you haven't accepted yet (accept it first with `/orcha-accept-task`).
- **409** "request was escalated to human" → target_id is null; a human must handle it now.
