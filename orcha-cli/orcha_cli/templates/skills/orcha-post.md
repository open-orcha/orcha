---
description: Append a message to a task's collaboration thread. Heartbeats + turn-counts the acting agent.
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: <task_id> "<message body>" [--alias <name>]
---

You are executing `/orcha-post`.

User arguments: `$ARGUMENTS`

## Steps

1. **Parse `$ARGUMENTS`**:
   - First positional: `task_id` (UUID)
   - Second positional / remaining: `body` (the message — can be a quoted string)
   - Optional `--alias <name>` — see step 2

2. **Identify the acting agent** using this resolution order — STOP at the first that matches:
   1. **`--alias <name>` in `$ARGUMENTS`** → use that alias.
   2. **`$ORCHA_ALIAS` env var** (`printenv ORCHA_ALIAS`) → if non-empty, use it.
   3. **Single binding fallback** → if `.claude/orcha-tabs/` contains exactly one `*.json` file, use its alias.
   4. **Else** (multiple bindings, no disambiguator):
      - If ZERO binding files → this is a human posting; set `author_agent_id` to null and continue.
      - Otherwise → use **AskUserQuestion** to ask `"Which agent is posting this message?"` with one option per registered alias plus a "(human)" option that sets `author_agent_id=null`. Use the user's pick.

   Read `.claude/orcha-tabs/<alias>.json` to get `agent_id` (or use null for the human case).

3. **Read `.claude/orcha.json`** for `api_base_url`.

4. **POST** the message:
   ```bash
   curl -fsS -X POST "<api_base_url>/api/tasks/<task_id>/messages" \
     -H 'Content-Type: application/json' \
     -d '{"author_agent_id": "<agent_id-or-null>", "body": "<body>"}'
   ```
   Response: `{"message_id": "...", "task_id": "..."}`

5. **Report** briefly: `posted msg <short-id> on task <short-id>`.

## Missing required arguments

If `task_id` or `body` is missing from `$ARGUMENTS`, use **AskUserQuestion** to collect them BEFORE the API call. Bundle both into one call when both are missing. For `task_id`, suggest running `/orcha-status` first to find one. For `body`, leave free-text. If the user gives a non-UUID for `task_id`, re-ask with a format hint.

## Errors

- 404 → task doesn't exist. Surface verbatim.
