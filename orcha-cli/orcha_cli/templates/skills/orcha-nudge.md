---
description: Nudge a request — a standalone wake-up for whoever owns the NEXT ACTION (open → the target who still owes an answer; answered → the requester who must act on it). Does NOT change the request's state.
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: <request_id> [--alias <name>] [--note "..."]
---

You are executing `/orcha-nudge`.

User arguments: `$ARGUMENTS`

## What a nudge does

A nudge is a **standalone wake-up**, fully decoupled from closing a request. It NEVER changes
the request's state — it just wakes whoever owns the next action so they resume:

- request is **open** → wakes the **target** (they still owe an answer)
- request is **answered** → wakes the **requester** (they must act on the answer or close it)

If the next action is owned by a human (an escalated-to-human request, a human target/requester,
or no target at all), there's no agent to wake via a poke — that's a clean no-op, not an error.

## Steps

1. **Parse `$ARGUMENTS`**:
   - First positional: `request_id` (UUID)
   - Optional `--alias <name>` — see step 2
   - Optional `--note "..."` — a short note included in the nudge the recipient sees.

2. **Identify the acting agent** (must be a HUMAN — nudging is an operator wake action) using this
   resolution order — STOP at the first match:
   1. **`--alias <name>` in `$ARGUMENTS`** → use that alias.
   2. **`$ORCHA_ALIAS` env var** (`printenv ORCHA_ALIAS`) → if non-empty, use it.
   3. **Single binding fallback** → if `.claude/orcha-tabs/` contains exactly one `*.json` file, use its alias.
   4. **Else** (multiple bindings, no disambiguator):
      - If ZERO binding files → STOP: `No registered agents in this project. Register first via /orcha-register-agent.`
      - Otherwise → use **AskUserQuestion** to ask `"Which human is nudging this request?"` with one option per registered alias. Use the user's pick.

   Read `.claude/orcha-tabs/<alias>.json` to get `agent_id` (used as `actor_agent_id`).

3. **Read `.claude/orcha.json`** for `api_base_url`.

4. **POST** — include `note` only when given:
   ```bash
   curl -fsS -X POST "<api_base_url>/api/requests/<request_id>/nudge" \
     -H 'Content-Type: application/json' \
     -d '{"actor_agent_id": "<my agent_id>", "note": "<note or omit>"}'
   ```
   Response: `{"request_id": "...", "status": "<unchanged>", "nudged": <bool>, "nudged_role": "target"|"requester", "nudged_agent_id": "<id or null>"}`

5. **Report** in plain English:
   - `nudged:true` → `Nudged the <nudged_role> on request <short-id>.` (e.g. "Nudged the target…").
   - `nudged:false` → `Nothing to wake on request <short-id> — a human owns the next action.`

## Errors

- **403** "only a human may nudge a request" → a non-human tried to nudge. Run as a human.
- **409** "this request was accepted and became a task — nudge the task, not the request" → the
  request was accepted; wake the spawned task instead.
- **409** "nothing to nudge: request is '<status>'" → the request is terminal (rejected /
  converted_to_task / closed); there's no next action to nudge.

## When to use which

| Situation | Skill |
|---|---|
| Someone owes the next action and you want to wake them | `/orcha-nudge <rid>` |
| You're done with an answered request and want to resolve it | `/orcha-close <rid>` |
| The answer was unsatisfactory / none came | `/orcha-escalate <rid>` |

## Missing required arguments

If `request_id` is missing from `$ARGUMENTS`, use **AskUserQuestion** to collect it. Suggest
checking `/orcha-status` (or the inbox) for an `open` or `answered` request.
