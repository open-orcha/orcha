---
description: Human decides what to do with an agent suggestion — create the new agent, reassign the task to an existing agent, or refuse the request.
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: <request_id> [--create | --reassign <alias> | --refuse [--reason "..."]] [--alias <human alias>]
---

You are executing `/orcha-decide-suggestion` (Phase 3 / Orcha#5). This is a **human-only** action — the load-bearing piece of "agents propose, humans decide."

**Auth (#271):** every `curl` to the API sends `-H "Authorization: Bearer <token>"`. `<token>` is the `token` field of the acting binding JSON (`.claude/orcha-tabs/<alias>.json`); if the binding predates tokens (or no binding applies, e.g. bootstrap), read the project runtime credential from `.orcha/runtime-token` instead. On a warn-mode stack a missing token still works (logged); on an enforce stack it 401s.

User arguments: `$ARGUMENTS`

## Steps

1. **Parse `$ARGUMENTS`**:
   - First positional: `request_id` (UUID — the request with `target_id=null` AND `detail.proposed_alias` set)
   - **Exactly one of**:
     - `--create` — accept the suggestion; the API spawns the proposed agent and re-targets the request at them.
     - `--reassign <alias>` — point the request at an existing agent instead. They must still `/orcha-accept-task`.
     - `--refuse [--reason "..."]` — reject the work entirely. The request closes with `rejection_reason` recorded.
   - `--alias <human alias>` — see step 1 (identifies which human is deciding; required by the API as `actor_agent_id`)

2. **Read `.claude/orcha.json`** for `api_base_url`. Optionally fetch `/api/containers/{cid}` to preview the suggestion (proposed_alias, proposed_role, rationale) before deciding — surface to the user so they're informed.

3. **POST** to decide:
   ```bash
   # --create:
   curl -fsS -H "Authorization: Bearer <token>" -X POST "<api_base_url>/api/agent-suggestions/<request_id>/decide" \
     -H 'Content-Type: application/json' \
     -d '{"kind": "create", "actor_agent_id": "<my human agent_id>"}'

   # --reassign:
   curl -fsS -H "Authorization: Bearer <token>" -X POST "<api_base_url>/api/agent-suggestions/<request_id>/decide" \
     -H 'Content-Type: application/json' \
     -d '{"kind": "reassign", "target_alias": "<existing alias>", "actor_agent_id": "<my human agent_id>"}'

   # --refuse:
   curl -fsS -H "Authorization: Bearer <token>" -X POST "<api_base_url>/api/agent-suggestions/<request_id>/decide" \
     -H 'Content-Type: application/json' \
     -d '{"kind": "refuse", "reason": "<--reason>", "actor_agent_id": "<my human agent_id>"}'
   ```

4. **Report** based on the response:
   - `create` → "✓ New agent <new_alias> created (agent_id <short>). The original request is now targeted at them; they'll see it in their inbox and can `/orcha-accept-task`."
   - `reassign` → "✓ Request re-targeted at <target_alias>. They'll see it in their inbox; they still need to `/orcha-accept-task` (or `/orcha-reject-task`)."
   - `refuse` → "✓ Request closed with reason: <reason>. Original requester sees it in `/orcha-outbox`."

## Errors

- **409** "container is at the <N>-agent cap" → `create` would exceed `containers.max_auto_agents`. Reassign instead, or bump the cap via direct SQL if you really need more.
- **409** "request has no agent-suggestion to decide on" → not a suggestion-escalated request; use `/orcha-escalate` resolution paths instead.
- **404** alias not found (for `--reassign`).

## Missing required arguments

If no `--create`/`--reassign`/`--refuse` is specified, use **AskUserQuestion** to present the choice as three options + show the proposed agent details inline so the human has context to decide.
