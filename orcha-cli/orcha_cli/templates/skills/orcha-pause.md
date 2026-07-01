---
description: Pause the current Orcha container. After this, mutating agent endpoints reject until /orcha-resume.
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: "[container_id] [--alias <human alias>]"
---

You are executing `/orcha-pause` (human-only — API enforces kind='human').

**Auth (#271):** every `curl` to the API sends `-H "Authorization: Bearer <token>"`. `<token>` is the `token` field of the acting binding JSON (`.claude/orcha-tabs/<alias>.json`); if the binding predates tokens (or no binding applies, e.g. bootstrap), read the project runtime credential from `.orcha/runtime-token` instead. On a warn-mode stack a missing token still works (logged); on an enforce stack it 401s.

## Steps

1. **Identify the acting human** via the standard 4-step alias resolution. Read `.claude/orcha-tabs/<alias>.json` to get `agent_id`.
2. **Resolve `container_id`**: positional argument if given, else `current_container_id` from `.claude/orcha.json`.
3. **Read `.claude/orcha.json`** for `api_base_url`.
4. **POST** status flip:
   ```bash
   curl -fsS -H "Authorization: Bearer <token>" -X POST "<api_base_url>/api/containers/<cid>/status" \
     -H 'Content-Type: application/json' \
     -d '{"status": "paused", "actor_agent_id": "<my human agent_id>"}'
   ```
5. **Report**: `container <short-id> paused (was <prev>) by <human alias>. Use /orcha-resume to bring back online.`

> Note: pausing flips the container row's status only. The Docker stack stays up; use `orcha down` in your shell to stop the stack.
