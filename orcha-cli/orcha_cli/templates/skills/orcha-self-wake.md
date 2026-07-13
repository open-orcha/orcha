---
description: Schedule or cancel a one-shot wake for the task the acting agent is actively working.
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: "<task_id> --in <duration> --context \"...\" [--alias <name>] | --cancel <task_id> [--all] [--alias <name>]"
---

You are executing `/orcha-self-wake` (GH #122).

User arguments: `$ARGUMENTS`

## Steps

1. **Parse `$ARGUMENTS`**:
   - Schedule form:
     - First positional: `task_id` (UUID)
     - Required `--in <duration>` where duration is like `90s`, `10m`, or `2h` (60 seconds to 24 hours)
     - Required `--context "..."` — a short, non-empty wait-point to inject on resume
     - Optional `--alias <name>`
   - Cancel form:
     - `--cancel <task_id>` to cancel this task's self-wake
     - Optional `--all` to cancel every pending self-wake for the acting agent
     - Optional `--alias <name>`

2. **Identify the acting agent** using the same resolution order as `/orcha-done`:
   `--alias` arg → `$ORCHA_ALIAS` env → single binding file → AskUserQuestion picker.
   Read `.claude/orcha-tabs/<alias>.json` to get `agent_id`.

3. **Read `.claude/orcha.json`** for `api_base_url`.

4. **Schedule** by POSTing a WORK-lane request. Convert the duration to seconds; reject anything
   below 60 seconds before calling the API. Pass the token header plainly quoted; do not use
   zsh `${VAR:+...}` header expansion because it can collapse the `-H` argument.
   ```bash
   curl -fsS -X POST "<api_base_url>/api/agents/<agent_id>/self-wake" \
     -H 'Content-Type: application/json' \
     -H "X-Orcha-Run-Token: $ORCHA_RUN_TOKEN" \
     -d '{"task_id": "<task_id>", "delay_secs": 600, "context": "<context>"}'
   ```

5. **Cancel** with:
   ```bash
   curl -fsS -X DELETE "<api_base_url>/api/agents/<agent_id>/self-wake?task_id=<task_id>" \
     -H "X-Orcha-Run-Token: $ORCHA_RUN_TOKEN"
   ```
   For `--all`, call `...?all=true` instead of `task_id=...`.

6. **Report**:
   - Schedule: `✓ scheduled a one-shot wake for <time>. Exit now instead of polling.`
   - Cancel: `✓ cancelled <N> scheduled wake(s).`

## Errors

- **403** → this is a work-lane-only command. It needs a valid `X-Orcha-Run-Token`.
- **409** → the task is not currently `in_progress` for this active assignee.
- **422** → duration is outside 60 seconds to 24 hours, context is blank, or context is too long.
