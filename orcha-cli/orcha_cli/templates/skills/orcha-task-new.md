---
description: Create a new task in the current Orcha container (optionally assigned to an agent, optionally with dependencies).
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: "<title>" --dod "..." [--description "..."] [--priority N] [--assign <alias>] [--depends-on <task_id> ...]
---

You are executing `/orcha-task-new`.

User arguments: `$ARGUMENTS`

## Steps

1. **Parse `$ARGUMENTS`**:
   - First positional: `title` (quoted)
   - `--dod "..."` (**required** — the definition of done)
   - `--description "..."` (optional, longer body)
   - `--priority N` (integer, default 100; lower = higher priority)
   - `--assign <alias>` (optional — assigns + claims for that agent immediately, task starts in_progress)
   - `--depends-on <task_id>` (repeatable; if any present, task starts in status `pending` until deps complete). **The task graph SHOULD be a DAG.** Only direct self-loops are rejected by the DB; transitive cycle checking was scoped out (humans build all edges by design). If you accidentally create a cycle, tasks in the loop will silently stay `pending` forever — visible in `/orcha-status` and fixable by deleting one edge.

   **If `title` or `--dod` is missing, handle per "Missing required arguments" below.**

2. **Read `.claude/orcha.json`** for `api_base_url` and `current_container_id`. If either is missing, tell the user how to fix.

3. **If the calling tab is bound to an agent**, include the agent's `agent_id` as `created_by_agent_id`. Resolution order: `--alias <name>` in `$ARGUMENTS` → `$ORCHA_ALIAS` env → if exactly one `.claude/orcha-tabs/*.json` exists, use it → otherwise leave `created_by_agent_id` as null (this becomes a human-created task). Don't error if no agent is resolvable — task creation is allowed from the human side too.

4. **POST** the task:
   ```bash
   curl -fsS -X POST "<api_base_url>/api/containers/<cid>/tasks" \
     -H 'Content-Type: application/json' \
     -d '{
       "title": "<title>",
       "description": "<description-or-null>",
       "definition_of_done": "<dod>",
       "priority": <priority>,
       "assignee_alias": "<alias-or-null>",
       "depends_on": [<...uuids...>],
       "created_by_agent_id": "<agent-id-or-null>"
     }'
   ```
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
