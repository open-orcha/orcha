---
description: Pause the current Orcha container. After this, mutating agent endpoints reject until /orcha-resume.
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: "[container_id] [--alias <human alias>]"
---

You are executing `/orcha-pause` (human-only — API enforces kind='human').

## Steps

1. **Identify the acting human** via the standard 4-step alias resolution. Read `.claude/orcha-tabs/<alias>.json` to get `agent_id`.
2. **Resolve `container_id`**: positional argument if given, else `current_container_id` from `.claude/orcha.json`.
3. **Read `.claude/orcha.json`** for `api_base_url`.
4. **POST** status flip:
   ```bash
   curl -fsS -X POST "<api_base_url>/api/containers/<cid>/status" \
     -H 'Content-Type: application/json' \
     -d '{"status": "paused", "actor_agent_id": "<my human agent_id>"}'
   ```
5. **Report**: `container <short-id> paused (was <prev>) by <human alias>. Use /orcha-resume to bring back online.`

> Note: pausing flips the container row's status only. The Docker stack stays up; use `orcha down` in your shell to stop the stack.
