---
description: Register an AI agent (kind='ai') into the current Orcha container, optionally with an initial task it starts working on immediately. For humans, use `/orcha-register-human` instead.
allowed-tools: Bash, Read, Edit, Write, AskUserQuestion
argument-hint: <alias> --role "..." --prompt "..." [--initial-task "..." --task-dod "..." [--task-description "..."] [--task-priority N]]
---

You are executing `/orcha-register-agent`. This creates an **AI agent** (`kind='ai'`). The first human was registered at `orcha init --as <name>`; to add more humans mid-run use `/orcha-register-human` — those rows skip `--prompt`, can't be assigned tasks via `initial_task`, and gain access to human-only skills (`/orcha-verify`, `/orcha-decide-suggestion`, `/orcha-pause`, `/orcha-resume`, `/orcha-stop`, `/orcha-sweep`).

User arguments: `$ARGUMENTS`

## Steps

1. **Parse `$ARGUMENTS`.** Required:
   - First positional: `alias` (e.g. `Max`)
   - `--role "..."` (e.g. `"product/research"`)
   - `--prompt "..."` (the system prompt defining this agent)

   Optional (use ALL if any are present):
   - `--initial-task "..."` — title of an opening task to claim immediately
   - `--task-dod "..."` — definition of done for that task (**required if `--initial-task` is given**)
   - `--task-description "..."` — longer task body (optional)
   - `--task-priority N` — integer (default 100; lower = higher priority)

   **If any of `alias`, `--role`, `--prompt` is missing — or if `--initial-task` was given without `--task-dod` — handle it per "Missing required arguments" below. Do NOT silently default. Do NOT error out without giving the user a chance to supply the values.**

2. **Read `.claude/orcha.json`** (via Read tool):
   - `api_base_url` (required — error to user → run `orcha init`)
   - `current_container_id` (required — error → run `/orcha-container "..."`)

3. **Build the request body**. If `--initial-task` was supplied, include the `initial_task` object:
   ```json
   {
     "alias": "<alias>",
     "role": "<role>",
     "prompt": "<prompt>",
     "initial_task": {
       "title": "<initial-task>",
       "description": "<task-description-or-null>",
       "definition_of_done": "<task-dod>",
       "priority": <task-priority-or-100>
     }
   }
   ```
   Without `--initial-task`, omit the `initial_task` field entirely.

4. **POST** to register:
   ```bash
   curl -fsS -X POST "<api_base_url>/api/containers/<current_container_id>/agents" \
     -H 'Content-Type: application/json' \
     -d '<body>'
   ```
   Response: `{"agent_id": "...", "alias": "...", "container_id": "...", "initial_task": {...} | null}`

5. **Bind this agent.** Write the binding file **keyed by alias** (NOT by tty — tty is unreliable in Claude Code's non-TTY Bash subprocess and collides across tabs). The file path is `.claude/orcha-tabs/<alias>.json` with content:
   ```json
   {"alias": "<alias>", "agent_id": "<agent_id>", "container_id": "<container_id>"}
   ```
   Use the **Write tool**. If `.claude/orcha-tabs/<alias>.json` already exists (re-registering a returning alias), overwrite it.

   **Cleanup pass:** also check `.claude/orcha-tabs/` for any stale `default.json` or `ttys*.json` files (legacy tty-keyed bindings). If found, delete them — they're orphans from the old binding scheme and will confuse the single-binding fallback used by work skills.

5b. **Record wake reachability (Epic A).** Immediately after writing the binding, run:
   ```bash
   orcha reachability --alias <alias>
   ```
   This records this session's `headless_cwd` (the project dir, where the notifier daemon
   spawns a `claude -p` worker to wake the agent) plus a tmux pane if you happen to be under
   tmux. Without it the daemon sees the agent's events but can't reach it ("unreachable").
   This makes the agent **wakeable the moment it registers** — no manual step. (The
   SessionStart hook re-asserts it every session; this call covers the just-registered
   agent now.) If `orcha` isn't on PATH, POST it directly:
   `POST <api_base_url>/api/agents/<agent_id>/reachability {"headless_cwd": "<project dir>"}`.

6. **Print the briefing** to the user, formatted like this:

   ```
   ✓ Agent registered

   alias:         <alias>
   role:          <role>
   agent_id:      <agent_id>
   container_id:  <container_id>
   binding file:  .claude/orcha-tabs/<alias>.json

   === In this Claude Code session you ARE <alias> ===
   • Add `--alias <alias>` to EVERY /orcha-* work skill you invoke from this point on
     (e.g. `/orcha-next --alias <alias>`, `/orcha-post <tid> "..." --alias <alias>`).
     The skills will use the alias to look up the binding file and your agent_id.
   • For persistence across Claude restarts in this tab, run in your SHELL:
         export ORCHA_ALIAS=<alias>
     Then any new Claude session launched in this shell will pick it up automatically
     without you having to add --alias to every command.
   • If only ONE agent is registered in this project, work skills will auto-resolve
     to that single binding file without --alias or $ORCHA_ALIAS — but be explicit
     once a second agent joins.

   === System prompt ===
   <prompt>

   === Initial task ===                       (only if initial_task was created)
   task_id:            <task_id>
   title:              <title>
   definition_of_done: <dod>
   status:             in_progress (claimed by you)

   Begin work on this task now. As you work:
     /orcha-post <task_id> "<update>" --alias <alias>   - append a progress note
     /orcha-done <task_id> "<result>" --alias <alias>   - mark done (human will verify)

   === Available skills (Phases 1 + 2) ===
   (Every work / request skill below accepts `--alias <name>` to disambiguate
   which registered agent is acting. In this session, that's: `--alias <alias>`.)

   General:
   /orcha-status [container_id]         snapshot of the project

   Work loop (always pass --alias <alias>):
   /orcha-next                                claim the next ready task
   /orcha-task-new "<title>" --dod "..."      create a task (--assign <alias> to give it to someone)
   /orcha-post <task_id> "<msg>"              append to a task's thread
   /orcha-done <task_id> "<result>"           mark a task done (awaits human verify)

   Agent-to-agent INFO requests (Phase 2; always pass --alias <alias>):
   /orcha-inbox                                                 incoming open + my asks now answered (two-section)
   /orcha-outbox [--status open|answered|closed|all]            full audit of my outgoing requests
   /orcha-ask <target_alias> "<question>" [--priority N] [--expires N] [--in-service-of <parent_rid>]  ask another agent
   /orcha-respond <request_id> "<answer>"                       answer an info request addressed to me
   /orcha-close <request_id>                                    close an answered request (satisfied)
   /orcha-escalate <request_id> [--reason "..."]                push to human (no/poor answer)
   /orcha-convert <request_id> "<title>" --dod "..."            convert an answered info request into a task

   Agent-to-agent TASK requests (Phase 3 / Orcha#5; always pass --alias <alias>):
   /orcha-ask <alias> "<summary>" --task --task-dod "..."       ask another agent to do work
   /orcha-accept-task <request_id> [--note "..."]               accept a task request → creates+claims the task
   /orcha-reject-task <request_id> --reason "..."               reject a task request (requester decides next)
   /orcha-suggest-agent <rid> --proposed-alias <name> --proposed-role "..." --proposed-prompt "..." --rationale "..."
                                                                propose to the human a new agent be created
   /orcha-decide-suggestion <rid> [--create|--reassign <alias>|--refuse [--reason "..."]]   (HUMAN ONLY)

   Request-chain idiom (info): if Max asks you Q1 and you need to ask Sam Q2 to answer Q1, run
   /orcha-ask Sam "Q2" --in-service-of <Q1's request_id> --alias <your alias>

   Server-pushed events (Orcha#5; recommended polling):
   /orcha-listen [--timeout 30] [--auto-accept-task] [--auto-close]   wait for next event
   /loop /orcha-listen --alias <alias>                          recurring; ~zero LLM cost per quiet
                                                                minute (1 timeout/30s) vs ~6 turns/min
                                                                with /orcha-checkpoint polling.

   Older polling (still available, costs more LLM):
   /orcha-checkpoint --alias <alias> [--auto-close]   one-shot inbox+outbox check
   /loop /orcha-checkpoint --alias <alias>            recurring (idle 10s / working 30s)

   STRONGLY recommended after registration: start `/loop /orcha-listen --alias <alias>`.
   The server pushes; you act only when something happens.

   Human-only (do NOT call these on your own behalf):
   /orcha-verify <task_id> [--reject "..."]            approve or reject a needs_verification task
   /orcha-decide-suggestion <rid> ...                  decide an agent-suggestion escalation
   /orcha-pause | /orcha-resume | /orcha-stop          container lifecycle
   /orcha-sweep                                        escalate any expired open requests

   Important rule (still holds): agents NEVER create other agents — they SUGGEST via
   /orcha-suggest-agent. The human decides via /orcha-decide-suggestion. The proposed
   alias / role / prompt / rationale get stored on the request; the human reads them,
   then either creates the agent, reassigns to an existing one, or refuses the request.

   NOT IN ORCHA TODAY — do NOT invent endpoints:
   • automated transitive cycle rejection on task DAG   → cut by design
     (humans are the only edge-builders; cycles produce visible deadlock)

   If a user asks for something not in the list, SURFACE the limitation back.
   Do NOT invent endpoint paths, field names, or message types.
   ```

## Missing required arguments

If any required argument is missing from `$ARGUMENTS`, use the **AskUserQuestion** tool to collect the missing value(s) BEFORE making any API call:

- Bundle all missing required args into a SINGLE AskUserQuestion call (up to 4 questions at once).
- For each missing arg, write a clear question with a short "why" and 1–3 sensible default suggestions as options (the user can also free-type via the built-in "Other"). Examples:
  - `alias` missing → "What alias should this agent use? Aliases identify the agent in commands and the portal." Options: short single-word picks.
  - `--role` missing → "What's this agent's role?" Options: a few typical roles ("engineering", "product/research", "architect", "qa") + Other.
  - `--prompt` missing → "What's the system prompt for this agent? (Press skip to auto-synthesize from --role.)" — see special case below.
  - `--task-dod` missing when `--initial-task` is set → "What's the definition of done for that initial task? Required so the agent + verifier know when it's complete."
- After the user answers, resume from step 2 — do NOT re-invoke `/orcha-register-agent`.

### Special case for `--prompt` (deliberate feature, not a bug)

When asking for `--prompt`, if the user **explicitly leaves the answer empty** (skips or types blank), fall back to **synthesizing a system prompt from the `--role` value**. A reasonable synthesis: `You are <alias>, a <role>. Cooperate with other agents through Orcha requests; never self-certify completion (a human verifies your work).`

When synthesis happens, include this line at the top of the briefing:
```
⚠ system prompt was auto-synthesized from --role because you left the prompt blank.
   Re-register with `--prompt "..."` (or restart and answer the prompt question) to override.
```

Synthesis ONLY happens after an explicit empty answer — never silently when `--prompt` is just missing.

## Errors

- **409** from the API → alias already exists in this container. Surface verbatim.
- **404** → the `current_container_id` is stale (DB reset). Tell user to re-run `/orcha-container`.
- If `--initial-task` is rejected by the API (validation error), the agent row was still created but the task wasn't. Tell the user.
