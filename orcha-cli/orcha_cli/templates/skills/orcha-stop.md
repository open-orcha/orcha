---
description: Stop the current Orcha container — sets status to 'completed' (or 'cancelled' if --cancel). Does NOT stop the Docker stack.
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: "[container_id] [--cancel] [--alias <human alias>]"
---

You are executing `/orcha-stop` (human-only — API enforces kind='human').

## Steps

1. **Identify the acting human** via standard 4-step alias resolution; read `.claude/orcha-tabs/<alias>.json` for `agent_id`.

2. **Parse `$ARGUMENTS`**:
   - Optional positional: `container_id` (else use `current_container_id` from `.claude/orcha.json`)
   - Optional flag: `--cancel` — if present, mark `cancelled`; otherwise mark `completed`.

3. **Read `.claude/orcha.json`** for `api_base_url`.

4. **POST**:
   ```bash
   curl -fsS -X POST "<api_base_url>/api/containers/<cid>/status" \
     -H 'Content-Type: application/json' \
     -d '{"status": "completed", "actor_agent_id": "<my human agent_id>"}'
   # or "cancelled" if --cancel
   ```

4. **Report**:
   ```
   container <short-id>: <prev> → <new>

   Note:
   - The Docker stack is still running. To stop it: `orcha down` in your shell.
   - To drop the data too (re-runs migrations next `orcha up`): `orcha down -v`.
   ```

## When to use which

| Action | What it does |
|---|---|
| `/orcha-pause`         | Soft-pause; agents stop claiming work. Reversible with `/orcha-resume`. |
| `/orcha-stop`          | Mark `completed`. Done with this project's objective. |
| `/orcha-stop --cancel` | Mark `cancelled`. Abandoned, won't pretend it was done. |
| `orcha down` (shell)   | Stop the Postgres + portal containers. Data preserved. |
| `orcha down -v` (shell) | Stop and drop the DB volume. Total reset. |
