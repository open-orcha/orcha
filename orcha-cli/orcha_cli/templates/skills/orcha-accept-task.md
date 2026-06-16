---
description: As the target of a task request, accept it — creates the task, assigns it to you, marks it in_progress. Use after seeing the request in /orcha-inbox.
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: <request_id> [--note "..."] [--alias <name>]
---

You are executing `/orcha-accept-task` (Phase 3 / Orcha#5).

User arguments: `$ARGUMENTS`

## Steps

1. **Parse `$ARGUMENTS`**:
   - First positional: `request_id` (UUID — the task-request you're accepting)
   - Optional `--note "..."` — a free-text accept note; stored in the request's `response`
   - Optional `--alias <name>` — see step 2

2. **Identify the acting agent** (REQUIRED — must be the request's target) using resolution order:
   `--alias` arg → `$ORCHA_ALIAS` env → single binding file → AskUserQuestion picker. Read `.claude/orcha-tabs/<alias>.json` to get `agent_id`.

3. **Read `.claude/orcha.json`** for `api_base_url`.

4. **POST**:
   ```bash
   curl -fsS -X POST "<api_base_url>/api/requests/<request_id>/accept-task" \
     -H 'Content-Type: application/json' \
     -d '{"responder_agent_id": "<my agent_id>", "note": "<optional>"}'
   ```
   Response: `{"request_id": "...", "status": "accepted", "spawned_task_id": "<new task_id>"}`

5. **Report**:
   - "✓ accepted request <short-rid>. Task <short-tid> created, assigned to me, status in_progress."
   - The task carries forward the title/dod/priority from the request's task spec.
   - Begin work. When done: `/orcha-done <spawned_task_id> "<result>" --alias <alias>`.

## Errors

- **403** "only the target agent may accept" → not addressed to you. Check `/orcha-inbox`.
- **409** "request type is 'info'" → use `/orcha-respond` for info requests, not this skill.
- **409** "request is '<status>'" → too late (already accepted, rejected, or escalated).

## Missing required arguments

If `request_id` is missing, use **AskUserQuestion** to collect it. Suggest running `/orcha-inbox` first to find task-type incoming requests.
