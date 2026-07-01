---
description: Resume a paused Orcha container — sets status back to active.
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: "[container_id] [--alias <human alias>]"
---

You are executing `/orcha-resume` (human-only — API enforces kind='human').

**Auth (#271):** every `curl` to the API sends `-H "Authorization: Bearer <token>"`. `<token>` is the `token` field of the acting binding JSON (`.claude/orcha-tabs/<alias>.json`); if the binding predates tokens (or no binding applies, e.g. bootstrap), read the project runtime credential from `.orcha/runtime-token` instead. On a warn-mode stack a missing token still works (logged); on an enforce stack it 401s.

## Steps

1. **Identify the acting human** via the standard 4-step alias resolution; read `.claude/orcha-tabs/<alias>.json` for `agent_id`.
2. Resolve `container_id` — positional or from `.claude/orcha.json`.
3. Read `api_base_url` from `.claude/orcha.json`.
4. POST:
   ```bash
   curl -fsS -H "Authorization: Bearer <token>" -X POST "<api_base_url>/api/containers/<cid>/status" \
     -H 'Content-Type: application/json' \
     -d '{"status": "active", "actor_agent_id": "<my human agent_id>"}'
   ```
5. Report: `container <short-id> resumed (was <prev>) by <human alias>.`
