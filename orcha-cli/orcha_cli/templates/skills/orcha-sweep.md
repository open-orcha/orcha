---
description: Sweep — escalate (re-target at the human) any open requests whose expires_at has passed. Human-only (API enforces kind='human').
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: "[container_id] [--alias <human alias>]"
---

You are executing `/orcha-sweep` (human-only).

## Steps

1. **Identify the acting human** via 4-step alias resolution; read `.claude/orcha-tabs/<alias>.json` for `agent_id`.

2. **Resolve `container_id`**: first positional in `$ARGUMENTS` if a UUID, else `current_container_id` from `.claude/orcha.json`.

3. **Read `.claude/orcha.json`** for `api_base_url`.

4. **POST**:
   ```bash
   curl -fsS -X POST "<api_base_url>/api/containers/<cid>/sweep?actor_agent_id=<my human agent_id>"
   ```
   Response: `{"escalated_count": N, "request_ids": [...]}`

4. **Report**:
   - If `escalated_count > 0`: list the request ids and tell the user they now appear in the escalations queue.
   - If `0`: `no expired open requests — nothing to sweep.`

## When to run

- Periodically (e.g. via a cron loop in your shell: `while sleep 300; do orcha ... ; done`)
- Manually when you notice an agent has been waiting too long
- Before a portal review session to flush any timed-out requests into the human queue
