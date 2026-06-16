---
description: Create a new Orcha container (project / milestone) with a root objective.
allowed-tools: Bash, Read, Edit, AskUserQuestion
argument-hint: "<name>" [--description "..."]
---

You are executing the `/orcha-container` slash command.

User arguments: `$ARGUMENTS`

## Steps

1. **Parse `$ARGUMENTS`** — first positional is the container `name` (often quoted). Optional `--description "..."` flag. Container names are typically the high-level objective (e.g. `"Build a news app"`).

   **If `name` is missing, handle per "Missing required arguments" below — do NOT proceed without it.**

2. **Read `.claude/orcha.json`** (via the Read tool) to get `api_base_url`. If the file doesn't exist, or doesn't have `api_base_url`, **stop** and tell the user:
   > Orcha isn't initialized in this project. Run `orcha init` in your shell first.

3. **POST** to create the container, substituting the parsed name/description and the `api_base_url` you just read:
   ```bash
   curl -fsS -X POST "<api_base_url>/api/containers" \
     -H 'Content-Type: application/json' \
     -d '{"name": "<name>", "description": "<description-or-null>"}'
   ```
   The response is JSON: `{"container_id": "...", "root_task_id": "..."}`.

4. **Update `.claude/orcha.json`** (via the Edit tool) — set `current_container_id` to the returned `container_id`. Preserve all other keys (especially `api_base_url`). If `current_container_id` already existed, **overwrite it** — the user is switching contexts.

5. **Report** to the user, briefly:
   - `container_id`
   - `root_task_id`
   - Portal URL: `<api_base_url>/` (paste the container_id into the input to inspect)

If the API returns a non-2xx, surface the error body verbatim and stop.

## Missing required arguments

If `name` is missing from `$ARGUMENTS`, use the **AskUserQuestion** tool to collect it:

- One question: "What's the high-level objective for this container? (e.g. \"Build a news app\")"
- Options can include 1–2 suggested phrasings if you can infer them from prior conversation context; otherwise let the user free-type via "Other".
- Optionally also ask for `--description` (a longer body) in the same AskUserQuestion call.
- After the user answers, resume from step 2.
