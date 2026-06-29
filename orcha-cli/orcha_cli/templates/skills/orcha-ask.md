---
description: Send a request from the acting agent. Two modes — info (ask a question, default) or task (`--task`, ask for work). Optionally chain it off another open request as a follow-up.
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: <target_alias> "<payload>" [--task --task-dod "..." [--task-priority N] [--task-description "..."] [--review-chain "..."] [--handoff-to "..."] [--autonomy "..."] [--notes "..."]] [--on-task <task_id>] [--priority N] [--expires N] [--in-service-of <parent_rid>] [--alias <name>]
---

You are executing `/orcha-ask`.

User arguments: `$ARGUMENTS`

## Steps

1. **Parse `$ARGUMENTS`**:
   - First positional: `target_alias` (the agent you're asking; use a literal dash `-` or `--human` to escalate-to-human from the start).
   - Second positional / remaining quoted: `payload` — for info mode, the question; for task mode, a one-line summary of the ask.
   - **Task vs info — choose correctly (GH #71).** Any **sizable / actionable work** you want *done* goes out as a **task request** (`--task`), not info. That includes — but isn't limited to — **code review or sign-off, writing/updating documentation, writing or changing code, or anything that produces an artifact or a PR**. Reserve plain **info** for a genuine quick question the target answers from their own knowledge (no deliverable). **If in doubt, it's a task.** A task request gets its own task-bound lifecycle; an info request answered while the requester already has a live "body" can be closed by a drain turn without the work ever starting (#72). The server enforces this: an info request to another agent that reads like work is rejected with a nudge to add `--task` (see Errors).
   - Mode flag `--task` (default off → info mode). When set, this is a **task request** (Phase 3 / Orcha#5): the target either `/orcha-accept-task` (creating a real task assigned to them) or `/orcha-reject-task <rid> --reason "..."` (kicking it back). With `--task`, also pass:
     - `--task-dod "..."` (required) — the definition of done for the work
     - `--task-priority N` (default 100)
     - `--task-description "..."` (optional longer body)
     - **Protocol (optional; GH #55)** — the loop rules the spawned task inherits the moment the target accepts (read on the wake that accept triggers, so the rules apply on turn one). Include only the ones you set: `--review-chain "..."` (the hand-off loop), `--handoff-to "..."` (who the assignee returns to first), `--autonomy "..."` (free text), `--notes "..."` (other standing rules).
   - Optional `--priority N` (default 100; lower = higher) — the *request*'s priority for the inbox, independent of `--task-priority` which the spawned task inherits.
   - Optional `--expires N` (minutes until the request auto-escalates if unanswered; default 60).
   - Optional `--in-service-of <parent_rid>` (UUID): when set, this request is recorded as a child of `parent_rid`.
   - **Optional `--on-task <task_id>` (GH #56 — the originating task).** The task **you (the requester)** are working on as you send this ask. When the answer comes back, your wake attaches to THIS task — its thread shows the activity and you wake with that task's protocol loaded (instead of a guess at your "one in_progress task", which is wrong when you have several). **You supply it** — the backend never guesses it. Set it to the id of the task this ask is in service of; **omit it for a conversation / taskless ask** (null is always fine). If `$ORCHA_ALIAS` and a current task are in scope and you know which task you're working on, fill it in. The backend **validates** a supplied id: it must be a real task in this container that you participate in (own / assignee / creator / collaborator), else the request is rejected (400) — so don't paste an id from another project or a stale one.
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
     "originating_task_id": "<--on-task-or-omit>",  // #56: the task YOU are working on; omit for taskless asks
     "type": "info"  // OR "task"
     // when type='task', also:
     "task": {
       "title": "<task title>",
       "description": "<optional longer body>",
       "definition_of_done": "<--task-dod>",
       "priority": <--task-priority>,
       // #55 — include `protocol` only if any protocol flag was given; put only the set keys inside it:
       "protocol": { "review_chain": "<...>", "handoff_to": "<...>", "autonomy": "<...>", "notes": "<...>" }
     }
   }
   ```
   (Omit the `"protocol"` key entirely when no protocol flags were passed — a request with no protocol spawns a task with a NULL protocol, same as before.)

5. **POST**:
   ```bash
   curl -fsS -X POST "<api_base_url>/api/containers/<cid>/requests" \
     -H 'Content-Type: application/json' \
     -d '<body>'
   ```
   Response: `{"request_id": "...", "type": "info|task", "status": "open", "target_alias": "...", "expires_at": "...", "parent_request_id": "...|null", "chain_depth": N, "originating_task_id": "...|null", "task": {...}|null}`

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
- **400** "originating_task_id must be a task in this container that the requester participates in" → the `--on-task` id is stale, foreign, or one you don't work on. Drop it (null is fine) or pass the correct task you're working on.
- **422** "This reads like a work request … add `--task`" (GH #71) → you sent sizable work (review / sign-off / docs / coding) as an `info` request. Resend as a **task**: add `--task --task-dod "..."` (and a `--task-description`/`--task-priority` if useful). If it really *is* a quick knowledge question, rephrase it so it reads as a question, not a work instruction.
