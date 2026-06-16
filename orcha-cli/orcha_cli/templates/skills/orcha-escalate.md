---
description: As the original requester, push a request to a human reviewer (clears target_id). Use when answer is unsatisfactory or none came.
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: <request_id> [--reason "..."] [--alias <name>]
---

You are executing `/orcha-escalate`.

User arguments: `$ARGUMENTS`

## Steps

1. **Parse `$ARGUMENTS`**:
   - First positional: `request_id` (UUID)
   - Optional `--reason "..."` (recommended — recorded in the audit event)
   - Optional `--alias <name>` — see step 2

2. **Identify the acting agent** (REQUIRED — must be the request's original requester) using this resolution order — STOP at the first match:
   1. **`--alias <name>` in `$ARGUMENTS`** → use that alias.
   2. **`$ORCHA_ALIAS` env var** (`printenv ORCHA_ALIAS`) → if non-empty, use it.
   3. **Single binding fallback** → if `.claude/orcha-tabs/` contains exactly one `*.json` file, use its alias.
   4. **Else** (multiple bindings, no disambiguator):
      - If ZERO binding files → STOP: `Only the original requester can escalate. Register first via /orcha-register-agent.`
      - Otherwise → use **AskUserQuestion** to ask `"Which agent is escalating this request?"` with one option per registered alias. Use the user's pick.

   Read `.claude/orcha-tabs/<alias>.json` to get `agent_id` (used as `requester_agent_id`).

3. **Read `.claude/orcha.json`** for `api_base_url`.

4. **POST**:
   ```bash
   curl -fsS -X POST "<api_base_url>/api/requests/<request_id>/escalate" \
     -H 'Content-Type: application/json' \
     -d '{"requester_agent_id": "<my agent_id>", "reason": "<reason-or-null>"}'
   ```
   Response: `{"request_id": "...", "status": "open", "target_id": null, "escalated": true}`

5. **Report**: `request <short-id> escalated to human (was targeted at <prev>). It will appear in escalations on the portal.`

## Errors

- **403** "only the requester may escalate" → not your request.
- **409** "request is '<status>'" → already closed (nothing to escalate).

## What "escalate" means

The request stays in `status='open'` but `target_id` is set to NULL. The portal's
**Escalations queue** (Phase 6 will surface this prominently) shows all requests
with `target_id=null`. A human resolves them.

## Missing required arguments

If `request_id` is missing from `$ARGUMENTS`, use **AskUserQuestion** to collect it. Suggest checking your open requests (you can ask the user to run `/orcha-status` first). Optionally also ask for `--reason` in the same call — strongly recommended since it's recorded in the audit event.
