---
description: Create a new task in the current Orcha container (optionally assigned to an agent, optionally with dependencies).
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: "<title>" --dod "..." [--description "..."] [--priority N] [--assign <alias>] [--depends-on <task_id> ...] [--review-chain "..."] [--handoff-to "..."] [--autonomy "..."] [--notes "..."]
---

You are executing `/orcha-task-new`.

User arguments: `$ARGUMENTS`

This is a workspace-local API recipe, so it remains usable even when the runtime does not advertise
a named task-creation tool. The source of truth is `.claude/orcha.json` plus the acting alias binding,
not a hosted page found through browser tabs. Never use Chrome/browser discovery as a fallback for
this command. If the local configuration or API is unavailable, stop and ask the human; do not create
the task in another Orcha instance.

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

4. **Conversation-lane self-handoff check before POST.** If `ORCHA_CONVERSATION_WORKER=1` and this task is assigned to the calling agent themself, pause before posting and decide whether the task overlaps the live conversation context you alone currently hold (for example: "continue what we were just doing", "turn your current findings into a task", "have yourself finish this"). Apply this ONLY for that self-referential/overlap case:
   - Do only the tiny resident-only slice that depends on that live context.
   - Put the result into the initial `description` or `protocol.notes` as already completed, so the worker spawned by this create call inherits it and does not redo it.
   - If the result truly needs a separate task-thread note, create the task unassigned first, post the note, then assign it; do not create-and-assign before the note exists.
   - For unrelated tasks, or anything larger than a tiny context-only slice, do no work inline and keep the normal fresh handoff path.

5. **POST** the task. **Include `protocol` only if at least one of `--review-chain` / `--handoff-to` / `--autonomy` / `--notes` was given** — and put only the fields actually supplied inside it (omit the rest; the server stores only set keys and leaves the protocol NULL when the block is absent). **Capture the HTTP status code separately from the body** (plain `curl -fsS` swallows the response body on any non-2xx — you'd see only a generic `curl: (22) ...` and lose the server's real error detail, which is exactly the "silent failure narrated as success" gap GH #152 closes):
   ```bash
   resp=$(curl -sS -w '\n%{http_code}' -X POST "<api_base_url>/api/containers/<cid>/tasks" \
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
     }')
   http_code=$(tail -n1 <<<"$resp")
   body=$(sed '$d' <<<"$resp")
   ```
   (Drop the `"protocol"` key entirely when no protocol flags were passed.)
   On 2xx, `$body` is `{"task_id": "...", "status": "...", "assignee_alias": "...", "depends_on": [...]}`.

   **On any non-2xx `$http_code` — including ones not enumerated below — this is a HARD STOP, not a warning:** do not report a `task_id`, do not say the task was created, do not proceed to step 6. Print `$body` verbatim (the real server error) and stop. GH #152: a SessionEnd audit independently cross-checks any "task X created" claim you make against the live DB and hard-fails loudly on a mismatch — but the first line of defense is simply never making that claim when the POST didn't actually 2xx.

6. **Verify the task through the same configured local API before reporting success or a link.**
   Parse `task_id` from the successful response body, then read the configured container back:
   ```bash
   task_id=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["task_id"])' <<<"$body")
   verify_resp=$(curl -sS -w '\n%{http_code}' \
     "<api_base_url>/api/containers/<cid>?task_limit=1000")
   verify_code=$(tail -n1 <<<"$verify_resp")
   verify_body=$(sed '$d' <<<"$verify_resp")
   ```
   Continue only when `verify_code` is 2xx, `verify_body.container.id` equals `<cid>`, and the returned
   `verify_body.tasks` contains `task_id`. This read-back proves the task is visible in the configured
   local Orcha container. The canonical local task link is
   `<api_base_url>/tasks?task=<task_id>`.

   If verification fails, **do not retry the POST** (that could create a duplicate), do not claim
   success, and do not return a link. Say that the local API may have created task `<task_id>` but its
   visibility could not be verified, surface the verification error, and ask the human to check.

7. **Report** to the user, briefly (only after a confirmed 2xx POST and successful read-back):
   - task_id, status (pending / ready / in_progress)
   - assignee_alias (or "(unassigned)")
   - depends_on (count, if any)
   - the verified local task link: `<api_base_url>/tasks?task=<task_id>`

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
- **Any other non-2xx (including a bare 500 or a connection failure)**: not enumerated above on
  purpose — GH #152. Treat it the same as step 5's hard stop: surface `$body` verbatim, do not
  claim the task exists, do not proceed to step 6.
