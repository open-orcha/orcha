---
description: Convert an answered-but-insufficient info request into a real task. Closes the request and creates a new task (optionally assigned).
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: <request_id> "<task title>" --dod "..." [--priority N] [--assign <alias>] [--alias <name>]
---

You are executing `/orcha-convert` (Phase 3 / Orcha#5).

Use this when you asked an info request, got an answer, but the answer is "I know enough to know this needs real work, not just an answer." The answer becomes context; a fresh task carries forward.

User arguments: `$ARGUMENTS`

## Steps

1. **Parse `$ARGUMENTS`**:
   - First positional: `request_id` (UUID — must be in status `answered`)
   - Second positional / quoted: `title` for the new task
   - `--dod "..."` (REQUIRED) — definition of done
   - Optional `--priority N` (default 100)
   - Optional `--assign <alias>` (immediately assigns + claims; otherwise the task starts `ready`)
   - Optional `--alias <name>` — see step 2

2. **Identify the acting agent** (REQUIRED — must be the original requester).

3. **Read `.claude/orcha.json`** for `api_base_url`.

4. **POST**:
   ```bash
   curl -fsS -X POST "<api_base_url>/api/requests/<request_id>/convert-to-task" \
     -H 'Content-Type: application/json' \
     -d '{
       "requester_agent_id": "<my agent_id>",
       "title": "<task title>",
       "definition_of_done": "<--dod>",
       "priority": <N>,
       "assignee_alias": "<alias-or-null>"
     }'
   ```
   Response: `{"request_id": "...", "status": "converted_to_task", "spawned_task_id": "<new>", "assignee_alias": "..."}`

5. **Report**: "✓ request <short-rid> converted. New task <short-tid> <status>. The request's answer remains visible in the request thread for context."

## When to use which

| Situation | Skill |
|---|---|
| Answer was enough; satisfied | `/orcha-close <rid>` |
| Answer was enough but exposes work that needs doing | `/orcha-convert <rid> "<title>" --dod "..." [--assign <alias>]` |
| Answer was insufficient AND nobody existing can handle | `/orcha-suggest-agent <rid> ...` |
| No answer, blocked | `/orcha-escalate <rid>` |

## Errors

- **403** "only the requester may convert" → you didn't ask the original request.
- **409** "request is '<status>', not 'answered'" → only answered info requests convert.
- **409** "only info requests can be converted" → already a task request; just `/orcha-accept-task` or `/orcha-reject-task`.
- **404** on `--assign <alias>` → alias not registered in this container.
