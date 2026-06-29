---
description: Atomically claim the highest-priority ready task for the acting agent. Returns the task to begin work on.
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: "[--alias <name>]"
---

You are executing `/orcha-next`.

User arguments: `$ARGUMENTS`

## Steps

1. **Identify the acting agent** using this resolution order — STOP at the first that matches:
   1. **`--alias <name>` in `$ARGUMENTS`** → use that alias.
   2. **`$ORCHA_ALIAS` env var** (check via `printenv ORCHA_ALIAS` or `echo "$ORCHA_ALIAS"`) → if non-empty, use it.
   3. **Single binding fallback** → if `.claude/orcha-tabs/` contains exactly one `*.json` file, use its alias.
   4. **Else** (multiple bindings, no disambiguator):
      - If ZERO binding files in `.claude/orcha-tabs/` → STOP. Tell the user: `No registered agents in this project. Run /orcha-register-agent <alias> --role "..." --prompt "..." first.`
      - Otherwise → use the **AskUserQuestion** tool to ask `"Which agent should run /orcha-next?"` with one option per registered alias (read filenames from `.claude/orcha-tabs/*.json`). Use the user's pick.

   Once you have the alias, read `.claude/orcha-tabs/<alias>.json` to get `agent_id`. If the file doesn't exist (alias was specified but binding missing), tell the user to register it.

2. **Read `.claude/orcha.json`** for `api_base_url`.

3. **POST** to claim:
   ```bash
   curl -fsS -X POST "<api_base_url>/api/agents/<agent_id>/next"
   ```
   Response is one of:
   - `{"task": {"id": "...", "title": "...", "description": "...", "definition_of_done": "...", "priority": N, "protocol": {...}}}`  → task claimed
   - `{"task": null, "message": "no ready tasks available"}`  → nothing to do

4. **Report & read the FULL task before working** (GH #33):
   - If a task was claimed: print task_id, title, **description**, definition_of_done, priority, and the **`protocol`** (its per-task working agreement — review_chain / handoff_to / autonomy / notes). Then:
     > **Read the full `description` and `definition_of_done` before you start — do not act on the title alone.** Acceptance criteria live in the description and DoD; if they ask for a **loop** or multi-step work, run the loop / complete every step, not a shallow one-pass. **Read the `protocol` too and honor it** — route reviews through its `review_chain`, hand finished work to its `handoff_to`, and follow its `notes`; these are binding. Begin work now. When done, call `/orcha-done <task_id> "<result>" --alias <alias>`. To post progress: `/orcha-post <task_id> "<note>" --alias <alias>`.
   - If nothing was claimed: print the message; suggest `/orcha-status` to inspect the project.

## Errors

- **404** "agent not found" → binding file references a stale agent_id (DB reset?). Tell the user to re-register.
