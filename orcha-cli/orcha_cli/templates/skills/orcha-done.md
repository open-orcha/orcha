---
description: Mark a task as done by the acting agent. Task moves to needs_verification (NOT completed). A human must /orcha-verify it before it becomes completed.
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: <task_id> "<result text or summary>" [--alias <name>]
---

You are executing `/orcha-done`.

User arguments: `$ARGUMENTS`

## Steps

1. **Parse `$ARGUMENTS`**:
   - First positional: `task_id` (UUID)
   - Remaining quoted: `result` (a summary of what was produced / where artifacts live)
   - Optional `--alias <name>` — see step 2

2. **Identify the acting agent** (REQUIRED here — agents can only mark their own tasks done) using this resolution order — STOP at the first match:
   1. **`--alias <name>` in `$ARGUMENTS`** → use that alias.
   2. **`$ORCHA_ALIAS` env var** (`printenv ORCHA_ALIAS`) → if non-empty, use it.
   3. **Single binding fallback** → if `.claude/orcha-tabs/` contains exactly one `*.json` file, use its alias.
   4. **Else** (multiple bindings, no disambiguator):
      - If ZERO binding files → STOP: `Marking a task done requires the acting agent's identity. Register first via /orcha-register-agent <alias> --role "..." --prompt "...".`
      - Otherwise → use **AskUserQuestion** to ask `"Which agent is marking this task done?"` with one option per registered alias. Use the user's pick.

   Read `.claude/orcha-tabs/<alias>.json` to get `agent_id`.

3. **Read `.claude/orcha.json`** for `api_base_url`.

4. **POST** the done signal. This is a WORK-lane endpoint: if `$ORCHA_RUN_TOKEN` is set in the env, pass it as the `X-Orcha-Run-Token` header so the server's work-lane gate accepts it; when it is UNSET (a human/no-token caller), OMIT the header (a bare call correctly 403s on this gated endpoint). Use the shell-safe expansion so an unset var adds nothing:
   ```bash
   curl -fsS -X POST "<api_base_url>/api/tasks/<task_id>/done" \
     -H 'Content-Type: application/json' \
     ${ORCHA_RUN_TOKEN:+-H "X-Orcha-Run-Token: $ORCHA_RUN_TOKEN"} \
     -d '{"agent_id": "<agent_id>", "result": "<result>"}'
   ```
   Response: `{"task_id": "...", "status": "needs_verification"}`

5. **Snapshot your memory digest** (Epic C / D3 — the `/orcha-done` cadence trigger). Finishing a task is the natural "captured a unit of work" boundary, so persist your reasoning now so a future re-binding tab rehydrates it. Compose a tight digest from THIS conversation and POST it:
   ```bash
   curl -fsS -X POST "<api_base_url>/api/agents/<agent_id>/digest" \
     -H 'Content-Type: application/json' \
     -d '{"current_focus": "<what you just finished / what is next>", "decisions": [{"text":"<key choices + why>"}], "learnings": [{"text":"<non-obvious facts discovered>"}], "open_threads": [{"text":"<loose ends to resume>"}]}'
   ```
   Keep it reasoning-focused; do NOT copy durable project facts here (those belong to Claude Code file-memory — non-overlapping, no sync). For any loose end that depends on external state (GitHub PR/issue status, Orcha task/request status, who owes what, review state), store the query to re-run ("check PR #123 status") rather than a frozen verdict ("PR #123 is still in review"). A future wake must re-check the source of truth before acting or deciding there is nothing to do. This is a best-effort step: if it fails, report it but still complete `/orcha-done`. (Standalone equivalent: `/orcha-snapshot --alias <alias>`.)

6. **Before yielding, check the inbox** (Orcha#1 — idle-agent inbox handling). Now that you've just gone idle, immediately call:
   ```bash
   curl -fsS "<api_base_url>/api/agents/<agent_id>/inbox"
   curl -fsS "<api_base_url>/api/agents/<agent_id>/outbox?status=answered"
   ```
   Count `open_requests` (incoming) and `outgoing_requests` (answered). Use these counts in the report below so the user knows there's pending request work before they go to /orcha-next.

7. **Report** clearly:
   ```
   ✓ Task <short-id> marked needs_verification.
   A human must approve via /orcha-verify <task_id>  (or /orcha-verify <task_id> --reject "feedback...")

   You're now idle.
   Inbox: <N> incoming open / <M> answered asks waiting.
   → If N > 0 OR M > 0: handle requests first via /orcha-inbox --alias <alias>.
   → Otherwise: /orcha-next --alias <alias> to pick up another ready task, or wait.
   ```

   The intent: an agent that JUST finished a task should NEVER walk past pending inbox items. This is the standing "be a good collaborator" reflex.

## Errors

- **409** "task is '<status>', not 'in_progress'" → the task isn't in_progress (already done? not yet claimed?). Surface verbatim.
- **404** → task or agent not found.

## Missing required arguments

If `task_id` or `result` is missing from `$ARGUMENTS`, use **AskUserQuestion** to collect them. Bundle both when both missing. For `task_id`, suggest checking `/orcha-status` for tasks currently `in_progress`. For `result`, ask: "What's the result / where does the deliverable live? (This goes into the task's `result` field for the verifier to review.)"

## Why this isn't `status=completed`

Per the design: agents never self-certify completion. `needs_verification` is the gate; only a human (or human-delegated reviewer agent) flips it to `completed`. This is the load-bearing piece of Orcha's "human-authoritative" guarantee.
