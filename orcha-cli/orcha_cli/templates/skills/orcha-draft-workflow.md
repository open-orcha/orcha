---
description: Save a workflow DRAFT for a person who asked for one. Preview, save, read it back, post the link. Never starts, prepares or releases it.
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: "<title>" --goal "..." [--for <human alias>] [--serial|--parallel] (steps come from the person's request)
---

You are executing `/orcha-draft-workflow`.

User arguments: `$ARGUMENTS`

Use this only when a **person asked** you to draft a workflow. You save a DRAFT; the person owns it and is the only one who can prepare, release or Start it. Never try to start, prepare, release, edit, re-run, hide or hand over a workflow: the server refuses an agent for all of those (`403 human_required`).

This is a workspace-local API recipe. The source of truth is `.claude/orcha.json` plus your acting alias binding. If the local configuration or API is unavailable, stop and ask the person; never draft in another Orcha instance.

## Steps

1. **Read `.claude/orcha.json`** for `api_base_url` and `current_container_id`. You need the work-session token in `$ORCHA_RUN_TOKEN`; without it the server answers `403` (a chat-only session cannot draft: ask for a task instead).

2. **Find the person and the steps.** The draft belongs to a human project member who is not a viewer:
   - Default: the person who requested the task this session is running. Leave `for_human_id` out. (A session not tied to a task defaults only when you have exactly one task in progress.)
   - If you were asked on behalf of someone else, set `for_human_id` to that member's id (`GET <api_base_url>/api/containers/<cid>`, `alias` and `id` of the humans).
   - If neither is clear the server answers `422 draft_owner_required`. Ask; do not guess.

3. **Build the body.** One JSON object:
   ```json
   {
     "title": "<short name>",
     "goal": "<what a good result looks like>",
     "execution_mode": "serial",
     "for_human_id": "<optional human member id>",
     "tasks": [
       {"client_key": "draft", "title": "...", "definition_of_done": "...", "assignee_id": "<agent id>"},
       {"client_key": "review", "title": "...", "definition_of_done": "...", "assignee_id": "<agent id>", "depends_on": ["draft"]}
     ],
     "idempotency_key": "<fresh unique key; reuse it on a retry>"
   }
   ```
   Steps are assigned to AI agents (a step for a person is not supported yet). `depends_on` takes up to 3 `client_key`s. You cannot bring existing tasks into a draft (`existing_task_ids`): that changes real tasks and stays a person's action.

4. **Preview** (drop `idempotency_key` for this call; it changes nothing). Fix anything the server flags (`422`/`409`) before saving:
   ```bash
   curl -sS -X POST "<api_base_url>/api/containers/<cid>/workflows/preview" \
     -H "Content-Type: application/json" -H "X-Orcha-Run-Token: $ORCHA_RUN_TOKEN" -d @body-without-key.json
   ```

5. **Save the draft.** Capture the status and the body separately so a refusal is readable:
   ```bash
   resp=$(curl -sS -w '\n%{http_code}' -X POST "<api_base_url>/api/containers/<cid>/workflows" \
     -H "Content-Type: application/json" -H "X-Orcha-Run-Token: $ORCHA_RUN_TOKEN" -d @body.json)
   ```
   `201` = saved. On a timeout, retry with the **same** `idempotency_key`: it returns the same workflow instead of making a second one.

6. **Read it back** and check: `GET <api_base_url>/api/workflows/<id>` shows `launch_enabled: false`, `owner_human_id` = the person, `drafted_by_alias` = you, and every step `start_hold: true`. The history reads "Drafted by <you> for <person>".

7. **Post the link** on your task thread (`/orcha-post`), in plain words: the workflow's name, who it is for, that nothing has started, and that the person prepares, releases and starts it from the Workflows page.

8. **Stop there.** Do not start it, and do not say it is running.

## Errors

- `403 human_required` — you tried a person-only action (start, prepare, release, edit, run again, owner change, importing existing tasks). Stop and tell the person.
- `403 work_lane_required` — no usable work-session token.
- `422 draft_owner_required` — no named or requesting person who is a current, non-viewer human member. Ask who it is for.
- `409 idempotency_conflict` — that key was used for a different body. Use a fresh key.
