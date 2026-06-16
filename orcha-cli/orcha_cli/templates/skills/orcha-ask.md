---
description: Send a request from the acting agent. Two modes — info (ask a question, default) or task (`--task`, ask for work). Optionally chain it off another open request as a follow-up.
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: <target_alias> "<payload>" [--task --task-dod "..." [--task-priority N] [--task-description "..."]] [--priority N] [--expires N] [--in-service-of <parent_rid>] [--alias <name>]
---

You are executing `/orcha-ask`.

User arguments: `$ARGUMENTS`

## Steps

1. **Parse `$ARGUMENTS`**:
   - First positional: `target_alias` (the agent you're asking; use a literal dash `-` or `--human` to escalate-to-human from the start).
   - Second positional / remaining quoted: `payload` — for info mode, the question; for task mode, a one-line summary of the ask.
   - Mode flag `--task` (default off → info mode). When set, this is a **task request** (Phase 3 / Orcha#5): the target either `/orcha-accept-task` (creating a real task assigned to them) or `/orcha-reject-task <rid> --reason "..."` (kicking it back). With `--task`, also pass:
     - `--task-dod "..."` (required) — the definition of done for the work
     - `--task-priority N` (default 100)
     - `--task-description "..."` (optional longer body)
   - Optional `--priority N` (default 100; lower = higher) — the *request*'s priority for the inbox, independent of `--task-priority` which the spawned task inherits.
   - Optional `--expires N` (minutes until the request auto-escalates if unanswered; default 60).
   - Optional `--in-service-of <parent_rid>` (UUID): when set, this request is recorded as a child of `parent_rid`.
   - Optional `--alias <name>` (the *requesting* agent — see step 2).

2. **Identify the acting (requesting) agent** (REQUIRED — only registered agents can ask) using this resolution order — STOP at the first match:
   1. **`--alias <name>` in `$ARGUMENTS`** → use that alias.
   2. **`$ORCHA_ALIAS` env var** (`printenv ORCHA_ALIAS`) → if non-empty, use it.
   3. **Single binding fallback** → if `.claude/orcha-tabs/` contains exactly one `*.json` file, use its alias.
   4. **Else** (multiple bindings, no disambiguator):
      - If ZERO binding files → STOP: `Only registered agents can ask. Run /orcha-register-agent <alias> --role "..." --prompt "..." first.`
      - Otherwise → use **AskUserQuestion** to ask `"Which agent is asking this question?"` with one option per registered alias. Use the user's pick.

   Read `.claude/orcha-tabs/<alias>.json` to get `agent_id` (used as `requester_agent_id` in the API call).

3. **Read `.claude/orcha.json`** for `api_base_url` and `current_container_id`.

4. **Build the request body**. If `target_alias` is `-` or `--human`, omit `target_alias` entirely (server treats null target as escalated-to-human at birth). Otherwise include it. If `--in-service-of <parent_rid>` was provided, include `parent_request_id`. For `--task` mode, include `type: "task"` and a nested `task` object with the task spec:
   ```json
   {
     "requester_agent_id": "<from binding>",
     "target_alias": "<target_alias-or-omit>",
     "payload": "<one-line summary>",
     "priority": <N>,
     "expires_minutes": <N>,
     "parent_request_id": "<parent_rid-or-omit>",
     "type": "info"  // OR "task"
     // when type='task', also:
     "task": {
       "title": "<task title>",
       "description": "<optional longer body>",
       "definition_of_done": "<--task-dod>",
       "priority": <--task-priority>
     }
   }
   ```

5. **POST**:
   ```bash
   curl -fsS -X POST "<api_base_url>/api/containers/<cid>/requests" \
     -H 'Content-Type: application/json' \
     -d '<body>'
   ```
   Response: `{"request_id": "...", "type": "info|task", "status": "open", "target_alias": "...", "expires_at": "...", "parent_request_id": "...|null", "chain_depth": N, "task": {...}|null}`

6. **Report** to the user:
   - `request_id` and short summary
   - Target alias (or "(escalated to human)")
   - Expires at (so they know when sweep will auto-escalate)
   - If chained: `chain_depth=N, child of <parent_rid>`
   - Next-step hint: `Target sees this on their next /orcha-inbox. Their answer flips the request to 'answered'; you then /orcha-close <request_id> --alias <your_alias> or /orcha-escalate <request_id> --alias <your_alias>.`

## On chains (Orcha#1)

Use `--in-service-of` when you can't answer an incoming request without first asking somebody else. Example:

> You are Dev. Max asked you `P` (`request_id=<P>`): "What's the API for X?" You don't know without first knowing the auth scheme — but Max set that up. You run:
> `/orcha-ask Max "What auth scheme are we using?" --in-service-of <P>`
> Once Max answers your child, you have what you need to answer P.

Once the child gets answered, **the requester of the parent (Max) will see the chain in their `/orcha-outbox` and know they're a step closer to getting their original answer.** Cycles can't be created by chains alone (parent is immutable at insert), but pathological back-and-forth dialogs can drive `chain_depth` deep — surfaces in `/orcha-status`; human can intervene with `/orcha-escalate` or `/orcha-sweep`.

## Missing required arguments

If `target_alias` or `payload` is missing from `$ARGUMENTS`, use **AskUserQuestion** to collect them:

- For `target_alias`: list other registered agents as options (read from `.claude/orcha-tabs/*.json`, excluding the acting agent's own file) plus a "(escalate to human)" option that means "use `-` as target".
- For `payload`: free-text question — "What's the question to ask?"
- Bundle into one AskUserQuestion call when both are missing.

## Errors

- **404** "no agent aliased '<alias>'" → typo or that agent isn't registered. Surface verbatim.
- **400** target_agent_id and target_alias both specified → I'm sending too much; pick one.
