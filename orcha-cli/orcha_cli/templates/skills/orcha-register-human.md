---
description: Register an additional human (kind='human') into the current Orcha container. The first human is registered automatically by `orcha init --as <name>`; use this skill only to add MORE humans mid-run.
allowed-tools: Bash, Read, Write, AskUserQuestion
argument-hint: <alias> [--role "..."]
---

You are executing `/orcha-register-human`.

**Auth (#271):** every `curl` to the API sends `-H "Authorization: Bearer <token>"`. `<token>` is the `token` field of the acting binding JSON (`.claude/orcha-tabs/<alias>.json`); if the binding predates tokens (or no binding applies, e.g. bootstrap), read the project runtime credential from `.orcha/runtime-token` instead. On a warn-mode stack a missing token still works (logged); on an enforce stack it 401s.

User arguments: `$ARGUMENTS`

## When to use this

The first human in a container is registered automatically when the user runs `orcha init --as <name>`. Use this skill ONLY when a second (or more) human joins the project mid-run — for example, a teammate steps in to help triage escalations, verify tasks, or pair on a decision.

Humans (`kind='human'`) and AI (`kind='ai'`) are both agents but differ in what they can do:

- **No system prompt.** Humans aren't LLMs; the column stays `NULL`.
- **No initial_task assignment.** Tasks are claimed by agents; humans verify them.
- **Authoritative actions.** Only `kind='human'` may call `/orcha-verify`, `/orcha-decide-suggestion`, `/orcha-pause`, `/orcha-resume`, `/orcha-stop`, `/orcha-sweep`, and accept escalations. The API enforces this with 403 otherwise.

## Steps

1. **Parse `$ARGUMENTS`**:
   - First positional: `alias` — required (e.g. `Priya`)
   - `--role "..."` — optional descriptor (e.g. `"product owner"`, `"oncall"`). Default if omitted: `"human"`.

   If `alias` is missing, use **AskUserQuestion** to collect it before continuing.

2. **Read `.claude/orcha.json`** for:
   - `api_base_url` (required — error → run `orcha init`)
   - `current_container_id` (required — error → run `orcha init` or `/orcha-container`)

3. **POST** to register. `kind` is the only thing that distinguishes this from AI registration; the rest of the body shape is the same minus `prompt` and `initial_task`:
   ```bash
   curl -fsS -H "Authorization: Bearer <token>" -X POST "<api_base_url>/api/containers/<current_container_id>/agents" \
     -H 'Content-Type: application/json' \
     -d '{
       "alias": "<alias>",
       "role": "<role-or-human>",
       "kind": "human"
     }'
   ```
   Response: `{"agent_id": "...", "alias": "...", "container_id": "...", "kind": "human", "initial_task": null, "token": "orcha_h_..."}`

   The response's `token` is this human's capability credential (#271), returned **exactly
   once** — the server stores only its hash. Persist it in the binding below; it is what
   authorizes this human's verify/decide/pause actions on an enforce-mode stack.

4. **Bind this human.** Write `.claude/orcha-tabs/<alias>.json`:
   ```json
   {"alias": "<alias>", "agent_id": "<agent_id>", "container_id": "<container_id>", "kind": "human", "token": "<token from the register response>"}
   ```
   Use the **Write tool**. Overwrite if it already exists.

5. **Print the briefing**:

   ```
   ✓ Human registered

   alias:         <alias>
   role:          <role>
   kind:          human
   agent_id:      <agent_id>
   container_id:  <container_id>
   binding file:  .claude/orcha-tabs/<alias>.json

   === In this Claude Code session you ARE <alias> (a human, not an agent) ===
   • Add `--alias <alias>` to every /orcha-* skill you invoke from this point on
     (work and human-power skills both honor it).
   • For persistence across Claude restarts in this tab, run in your SHELL:
         export ORCHA_ALIAS=<alias>
   • If you are the only registered binding in this project, skills will auto-resolve
     to your file without --alias — but be explicit once others join.

   === Human-only skills you can now call ===
   /orcha-verify <task_id> [--reject "..."]                approve / reject a needs_verification task
   /orcha-decide-suggestion <rid> [--create|--reassign <alias>|--refuse [--reason "..."]]
                                                            decide an agent-suggestion escalation
   /orcha-pause | /orcha-resume                            container lifecycle (soft)
   /orcha-stop [--cancel]                                  mark container completed (or cancelled)
   /orcha-sweep                                            re-target expired open requests at a human

   === Also useful for humans ===
   /orcha-status                                            snapshot of the project
   /orcha-inbox                                             requests waiting on a human
   /orcha-respond <rid> "<answer>"                          answer an info request escalated to you
   /orcha-ask <agent_alias> "<question>"                    ask an agent something directly

   Reminder: humans NEVER receive `initial_task` assignments. Humans verify, decide,
   and answer — agents do the work.
   ```

## Errors

- **409** from the API → alias already exists in this container. Surface verbatim; the user must pick a different alias.
- **404** → `current_container_id` is stale. Re-run `orcha init` or `/orcha-container`.
- **422** → body validation failed (e.g. `prompt` was sent for a human). This skill never sends `prompt` — if you see this, the request was malformed.
