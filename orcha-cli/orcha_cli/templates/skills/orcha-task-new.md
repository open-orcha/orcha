---
description: Create a new task in the current Orcha container (optionally assigned to an agent, optionally with dependencies).
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: "<title>" --dod "..." [--description "..."] [--priority N] [--assign <alias>] [--depends-on <task_id> ...] [--review-chain "..."] [--handoff-to "..."] [--autonomy "..."] [--notes "..."]
---

You are executing `/orcha-task-new`.

**Auth (#271):** every `curl` to the API sends `-H "Authorization: Bearer <token>"`. `<token>` is the `token` field of the acting binding JSON (`.claude/orcha-tabs/<alias>.json`); if the binding predates tokens (or no binding applies, e.g. bootstrap), read the project runtime credential from `.orcha/runtime-token` instead. On a warn-mode stack a missing token still works (logged); on an enforce stack it 401s.

User arguments: `$ARGUMENTS`

## Steps

1. **Parse `$ARGUMENTS`**:
   - First positional: `title` (quoted)
   - `--dod "..."` (**required** — the definition of done)
   - `--description "..."` (optional, longer body)
   - `--priority N` (integer, default 100; lower = higher priority)
   - `--assign <alias>` (optional — assigns + claims for that agent immediately, task starts in_progress)
   - `--depends-on <task_id>` (repeatable; if any present, task starts in status `pending` until deps complete). **The task graph SHOULD be a DAG.** Only direct self-loops are rejected by the DB; transitive cycle checking was scoped out (humans build all edges by design). If you accidentally create a cycle, tasks in the loop will silently stay `pending` forever — visible in `/orcha-status` and fixable by deleting one edge.
   - **Protocol (optional — the per-task loop rules the assignee reads FRESH on the wake this create triggers; GH #55).** Setting these at create time (rather than via a later PATCH) is what makes the loop rules apply on the assignee's *first* turn:
     - `--review-chain "..."` — the hand-off loop, e.g. `"Builder → Reviewer → loop until clean → human"`
     - `--handoff-to "..."` — who the assignee returns to first when done
     - `--autonomy "..."` — free text; how far the assignee may go before checking in
     - `--notes "..."` — any other standing rules for this task

   **If `title` or `--dod` is missing, handle per "Missing required arguments" below.**

2. **Read `.claude/orcha.json`** for `api_base_url` and `current_container_id`. If either is missing, tell the user how to fix.

3. **If the calling tab is bound to an agent**, include the agent's `agent_id` as `created_by_agent_id`. Resolution order: `--alias <name>` in `$ARGUMENTS` → `$ORCHA_ALIAS` env → if exactly one `.claude/orcha-tabs/*.json` exists, use it → otherwise leave `created_by_agent_id` as null (this becomes a human-created task). Don't error if no agent is resolvable — task creation is allowed from the human side too.

4. **POST** the task. **Include `protocol` only if at least one of `--review-chain` / `--handoff-to` / `--autonomy` / `--notes` was given** — and put only the fields actually supplied inside it (omit the rest; the server stores only set keys and leaves the protocol NULL when the block is absent):
   ```bash
   curl -fsS -H "Authorization: Bearer <token>" -X POST "<api_base_url>/api/containers/<cid>/tasks" \
     -H 'Content-Type: application/json' \
     -d '{
       "title": "<title>",
       "description": "<description-or-null>",
       "definition_of_done": "<dod>",
       "priority": <priority>,
       "assignee_alias": "<alias-or-null>",
       "depends_on": [<...uuids...>],
       "created_by_agent_id": "<agent-id-or-null>",
       "protocol": { "review_chain": "<...>", "handoff_to": "<...>", "autonomy": "<...>", "notes": "<...>" }
     }'
   ```
   (Drop the `"protocol"` key entirely when no protocol flags were passed.)
   Response: `{"task_id": "...", "status": "...", "assignee_alias": "...", "depends_on": [...]}`

5. **Report** to the user, briefly:
   - task_id, status (pending / ready / in_progress)
   - assignee_alias (or "(unassigned)")
   - depends_on (count, if any)

## Missing required arguments

If `title` or `--dod` is missing from `$ARGUMENTS`, use the **AskUserQuestion** tool to collect them BEFORE the API call:

- Bundle both into a single AskUserQuestion call when both are missing (it supports up to 4 questions).
- "What's the title of this task?" — usually free-text via "Other".
- "What's the definition of done? (Required — agent + verifier use this to know when the task is complete.)"
- After the user answers, resume from step 2.

## Errors

- 404 on `assignee_alias`: that alias isn't a registered agent in this container — surface verbatim.
- 400 on a non-UUID `depends_on`: surface verbatim.
- 400 self-loop rejection (DB CHECK): a task can't depend on itself. Surface verbatim.
