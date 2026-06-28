---
description: As the original requester, close an answered request (satisfied with the answer). Flips 'answered' to 'closed'. A human can also close ANY open/answered request, with an optional reason (routed to the owner) and nudge (sent to the agent handling it).
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: <request_id> [--alias <name>] [--reason "..."] [--nudge "..."]
---

You are executing `/orcha-close`.

User arguments: `$ARGUMENTS`

## Steps

1. **Parse `$ARGUMENTS`**:
   - First positional: `request_id` (UUID)
   - Optional `--alias <name>` — see step 2
   - Optional `--reason "..."` — a close reason. **Required** when a HUMAN closes a request they did NOT originate (it's routed to the owning agent so it learns why). Ignored when you close your own request.
   - Optional `--nudge "..."` — a short note delivered to the agent currently HANDLING the request (its target) so it learns the request was closed externally and reorients. Works for any closer; independent of `--reason`.

2. **Identify the acting agent** (REQUIRED — must be the request's original requester) using this resolution order — STOP at the first match:
   1. **`--alias <name>` in `$ARGUMENTS`** → use that alias.
   2. **`$ORCHA_ALIAS` env var** (`printenv ORCHA_ALIAS`) → if non-empty, use it.
   3. **Single binding fallback** → if `.claude/orcha-tabs/` contains exactly one `*.json` file, use its alias.
   4. **Else** (multiple bindings, no disambiguator):
      - If ZERO binding files → STOP: `Only the original requester can close. Register first via /orcha-register-agent.`
      - Otherwise → use **AskUserQuestion** to ask `"Which agent is closing this request?"` with one option per registered alias. Use the user's pick.

   Read `.claude/orcha-tabs/<alias>.json` to get `agent_id` (used as `requester_agent_id`).

3. **Read `.claude/orcha.json`** for `api_base_url`.

4. **POST** — include `reason` and/or `nudge` only when given:
   ```bash
   curl -fsS -X POST "<api_base_url>/api/requests/<request_id>/close" \
     -H 'Content-Type: application/json' \
     -d '{"requester_agent_id": "<my agent_id>", "reason": "<reason or omit>", "nudge": "<nudge or omit>"}'
   ```
   Response: `{"request_id": "...", "status": "closed", "forced_by_human": <bool>, "nudged_target": <bool>}`

5. **Report**: `request <short-id> closed.` Add `— nudged the agent handling it.` when `nudged_target` is true.

## Errors

- **403** "only the requester (or a human) may close" → a non-human tried to close a request it didn't originate. Only the owner or a human can.
- **409** "request is '<status>', not 'answered'" → a non-human can only close an `answered` request (a human may force-close from any non-closed status). Already-closed is a safe no-op (200).
- **422** "reason_required" → a human is closing another agent's request without `--reason`. Re-run with `--reason "..."`.

## When to use which

| Situation | Skill |
|---|---|
| Got an answer, satisfied | `/orcha-close <rid>` |
| Got an answer but unsatisfactory | `/orcha-escalate <rid> --reason "..."` (Phase 3 will add `/orcha-convert` to turn it into a task) |
| No answer, blocked | `/orcha-escalate <rid>` or wait for sweep |

## Missing required arguments

If `request_id` is missing from `$ARGUMENTS`, use **AskUserQuestion** to collect it. Suggest checking `/orcha-status` (or the inbox) for `answered` requests where you're the requester.
