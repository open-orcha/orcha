---
description: As the requester of a rejected (or just escalated) request, propose to the human that a new agent be created to handle this. The human decides — create, reassign, or refuse.
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: <request_id> --proposed-alias <name> --proposed-role "..." --proposed-prompt "..." --rationale "..." [--alias <name>]
---

You are executing `/orcha-suggest-agent` (Phase 3 / Orcha#5).

**This is the "agents propose, humans decide" path. You don't create the agent — you suggest it. The human reviews via `/orcha-decide-suggestion` and may create, reassign the task to an existing agent, or refuse the request entirely.**

User arguments: `$ARGUMENTS`

## Steps

1. **Parse `$ARGUMENTS`**:
   - First positional: `request_id` (UUID — the rejected or unresolvable request)
   - `--proposed-alias <name>` (REQUIRED) — what to call the new agent (must be unique in the container)
   - `--proposed-role "..."` (REQUIRED) — one-line role description
   - `--proposed-prompt "..."` (REQUIRED) — full system prompt for the new agent
   - `--rationale "..."` (REQUIRED) — why this agent rather than reassigning to an existing one
   - Optional `--alias <name>`

2. **Identify the acting agent** (REQUIRED — must be the *requester* of the request you're escalating with suggestion).

3. **Read `.claude/orcha.json`** for `api_base_url`.

4. **POST**:
   ```bash
   curl -fsS -X POST "<api_base_url>/api/requests/<request_id>/suggest-agent" \
     -H 'Content-Type: application/json' \
     -d '{
       "requester_agent_id": "<my agent_id>",
       "proposed_alias": "<name>",
       "proposed_role": "<role>",
       "proposed_prompt": "<prompt>",
       "rationale": "<why>"
     }'
   ```
   Response: `{"request_id": "...", "status": "open", "target_id": null, "suggestion": {...}}`

5. **Report**:
   - "✓ suggestion logged. Request <short-rid> is now in the human's escalations queue with a proposed agent <name> (<role>). Human will `/orcha-decide-suggestion <rid> --create | --reassign <alias> | --refuse`."
   - You go back to your own task while waiting. Your status auto-flips to `awaiting_request` (or stays there) since the request is still open.

## Errors

- **403** "only the requester may suggest" → you're not the original asker.
- **409** "request is '<status>'" → wrong state; suggestion is meaningful when the request is open or rejected.

## Missing required arguments

Use **AskUserQuestion** for any missing field. The rationale prompt is the most important — push the agent to explain why the existing agent roster isn't enough.
