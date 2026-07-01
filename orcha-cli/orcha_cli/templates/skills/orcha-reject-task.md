---
description: As the target of a task request, reject it with a reason. The requester can then re-ask, suggest a new agent, or escalate.
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: <request_id> --reason "..." [--alias <name>]
---

You are executing `/orcha-reject-task` (Phase 3 / Orcha#5).

**Auth (#271):** every `curl` to the API sends `-H "Authorization: Bearer <token>"`. `<token>` is the `token` field of the acting binding JSON (`.claude/orcha-tabs/<alias>.json`); if the binding predates tokens (or no binding applies, e.g. bootstrap), read the project runtime credential from `.orcha/runtime-token` instead. On a warn-mode stack a missing token still works (logged); on an enforce stack it 401s.

User arguments: `$ARGUMENTS`

## Steps

1. **Parse `$ARGUMENTS`**:
   - First positional: `request_id` (UUID)
   - `--reason "..."` (REQUIRED — the requester reads this verbatim to decide their next move)
   - Optional `--alias <name>`

2. **Identify the acting agent** (REQUIRED — must be the request's target).

3. **Read `.claude/orcha.json`** for `api_base_url`.

4. **POST**:
   ```bash
   curl -fsS -H "Authorization: Bearer <token>" -X POST "<api_base_url>/api/requests/<request_id>/reject-task" \
     -H 'Content-Type: application/json' \
     -d '{"responder_agent_id": "<my agent_id>", "reason": "<--reason>"}'
   ```
   Response: `{"request_id": "...", "status": "rejected", "reason": "..."}`

5. **Report**: "✓ rejected request <short-rid>. Reason recorded: <reason>. Requester will see it in their /orcha-outbox and choose: re-ask, suggest a new agent (`/orcha-suggest-agent`), or escalate."

## Why a reason is required

The requester needs enough context to decide between (a) asking a different existing agent, (b) escalating to the human with `/orcha-suggest-agent` proposing a new agent be created, or (c) just escalating with `/orcha-escalate`. A blank rejection forces them to guess.

## Errors

- **403** "only the target agent may reject" → not addressed to you.
- **409** "request type is 'info'" → use `/orcha-respond` for info requests; this skill is task-only.
- **409** "request is '<status>'" → too late.

## Missing required arguments

If `request_id` or `--reason` is missing, use **AskUserQuestion**. For reason, suggest 2-3 common templates: "outside my expertise", "would block my current task", "definition of done unclear", + free-text.
