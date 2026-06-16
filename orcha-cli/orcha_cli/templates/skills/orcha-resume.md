---
description: Resume a paused Orcha container — sets status back to active.
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: "[container_id] [--alias <human alias>]"
---

You are executing `/orcha-resume` (human-only — API enforces kind='human').

## Steps

1. **Identify the acting human** via the standard 4-step alias resolution; read `.claude/orcha-tabs/<alias>.json` for `agent_id`.
2. Resolve `container_id` — positional or from `.claude/orcha.json`.
3. Read `api_base_url` from `.claude/orcha.json`.
4. POST:
   ```bash
   curl -fsS -X POST "<api_base_url>/api/containers/<cid>/status" \
     -H 'Content-Type: application/json' \
     -d '{"status": "active", "actor_agent_id": "<my human agent_id>"}'
   ```
5. Report: `container <short-id> resumed (was <prev>) by <human alias>.`
