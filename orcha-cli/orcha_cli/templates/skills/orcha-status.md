---
description: Print a human-friendly snapshot of the current Orcha container (agents, tasks, requests).
allowed-tools: Bash, Read
argument-hint: "[container_id]"
---

You are executing the `/orcha-status` slash command.

User arguments: `$ARGUMENTS`

## Steps

1. **Resolve `container_id`**:
   - If `$ARGUMENTS` contains a UUID-shaped token, use it.
   - Otherwise read `.claude/orcha.json` (via Read tool) and use `current_container_id`.
   - If neither is available, stop and tell the user to either pass an id or run `/orcha-container` first.

2. **Read `api_base_url`** from `.claude/orcha.json`. Error helpfully if missing.

3. **GET** the snapshot:
   ```bash
   curl -fsS "<api_base_url>/api/containers/<cid>"
   ```
   Response shape:
   ```json
   {
     "container": { "id", "name", "status", "root_task_id", "created_at", ... },
     "agents":   [ { "alias", "role", "status", "turns_used", "turn_budget", "last_heartbeat_at", ... }, ... ],
     "tasks":    [ { "id", "title", "status", "priority", "is_root", ... }, ... ],
     "requests": [ { "id", "type", "status", "priority", ... }, ... ]
   }
   ```

4. **Pretty-print** as a compact summary. Do NOT dump raw JSON unless the user explicitly asks. Use a format like:

   ```
   container <id> — <name> (<status>)
     root_task_id: <id>
     created_at:   <ts>

   agents (N):
     • <alias>  <role>  status=<status>  turns=<used>/<budget>  hb=<ts or '-'>
       waiting_on (if non-empty):
         → <target_alias>: "<payload_preview>" (depth=<chain_depth>, asked <relative time>)
         → ...
     ...

   tasks (N):
     • <short-id>…  pri=<n>  <status>  <title>  [root]?
     ...

   requests (N):
     • <short-id>…  <type>  pri=<n>  <status>  depth=<chain_depth>
     ... or "(none)" if empty
   ```

   For `agents.waiting_on`: each agent has a `waiting_on` array in the API response. Each entry is `{request_id, target_alias, payload_preview, chain_depth, created_at, expires_at}`. Only show the indented `waiting_on` block under an agent when `len(waiting_on) > 0`. This is what makes "Bob is awaiting_request — he's stuck on Sam answering X" visible at a glance.

   **Heartbeat staleness**: don't flag a stale `last_heartbeat_at` as "agent died" when status starts with `awaiting_` — parked agents naturally don't heartbeat.

5. **404 from the API** → the container id is stale (DB reset?). Tell the user.
