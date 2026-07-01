---
description: Read a task's collaboration thread — the messages agents and humans have posted to it, oldest→newest. Read-only counterpart to /orcha-post.
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: <task_id> [--limit N] [--alias <name>]
---

You are executing `/orcha-thread`.

**Auth (#271):** every `curl` to the API sends `-H "Authorization: Bearer <token>"`. `<token>` is the `token` field of the acting binding JSON (`.claude/orcha-tabs/<alias>.json`); if the binding predates tokens (or no binding applies, e.g. bootstrap), read the project runtime credential from `.orcha/runtime-token` instead. On a warn-mode stack a missing token still works (logged); on an enforce stack it 401s.

User arguments: `$ARGUMENTS`

## Steps

1. **Parse `$ARGUMENTS`**:
   - First positional: `task_id` (UUID)
   - Optional `--limit N` — show only the newest `N` messages (still printed oldest→newest)
   - Optional `--alias <name>` — accepted for family consistency but **unused**: reading a
     thread needs no agent identity, so unlike `/orcha-post` this skill does NOT resolve an
     acting agent. Ignore it if present.

2. **Read `.claude/orcha.json`** for `api_base_url`.

3. **GET** the thread:
   ```bash
   curl -fsS -H "Authorization: Bearer <token>" "<api_base_url>/api/tasks/<task_id>/messages"
   ```
   If `--limit N` was given, append the query param:
   ```bash
   curl -fsS -H "Authorization: Bearer <token>" "<api_base_url>/api/tasks/<task_id>/messages?limit=<N>"
   ```
   Response: `{"task_id": "...", "messages": [...]}`. Each message is
   `{message_id, author_id, author_alias, is_human, body, created_at}`, ordered `created_at` ASC.
   With `?limit=N` the response also carries `has_more`, `next_before`, `next_before_id` — a
   `(created_at, id)` keyset for loading the page of earlier messages.

4. **Pretty-print** the thread (mirror the portal task-thread render). For each message, oldest→newest:
   ```
   thread for task <short-task-id> — <count> message(s)

     <author_alias or "(human)">  <created_at>
       <body>

     ...
   ```
   - Resolve the speaker: use `author_alias` when present; if `is_human` is true and there's no
     alias (a NULL-author free-text human post), print `(human)`.
   - Indent the body; preserve its line breaks.
   - Empty thread → `(no messages yet)`.
   - If `--limit N` was used AND `has_more` is true → footer:
     `(showing newest <N>; <count> shown — earlier messages exist. Re-run with a larger --limit to see more.)`

5. **Report** nothing further — the printed thread is the result.

## Missing required arguments

If `task_id` is missing from `$ARGUMENTS`, use **AskUserQuestion** to collect it. Suggest running
`/orcha-status` first to find a task id. If the user gives a non-UUID, re-ask with a format hint.

## Errors

- **400** "task_id is not a valid UUID" → the id is malformed. Surface verbatim.
- **404** → task doesn't exist. Surface verbatim.
