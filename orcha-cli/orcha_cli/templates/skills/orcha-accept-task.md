---
description: As the target of a task request, accept it — creates the task, assigns it to you, marks it in_progress. Use after seeing the request in /orcha-inbox.
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: <request_id> [--note "..."] [--alias <name>]
---

You are executing `/orcha-accept-task` (Phase 3 / Orcha#5).

User arguments: `$ARGUMENTS`

## Steps

1. **Parse `$ARGUMENTS`**:
   - First positional: `request_id` (UUID — the task-request you're accepting)
   - Optional `--note "..."` — a free-text accept note; stored in the request's `response`
   - Optional `--alias <name>` — see step 2

2. **Identify the acting agent** (REQUIRED — must be the request's target) using resolution order:
   `--alias` arg → `$ORCHA_ALIAS` env → single binding file → AskUserQuestion picker. Read `.claude/orcha-tabs/<alias>.json` to get `agent_id`.

3. **Read `.claude/orcha.json`** for `api_base_url`.

4. **POST**. This accept begins work on the task (WORK-lane transition): if `$ORCHA_RUN_TOKEN` is set in the env, pass it as the `X-Orcha-Run-Token` header so the server's work-lane gate accepts it; when it is UNSET (a human/no-token caller), OMIT the header (a bare call correctly 403s on this gated endpoint). Use the shell-safe expansion so an unset var adds nothing. **Capture the HTTP status code separately from the body** (plain `curl -fsS` swallows the response body on any non-2xx — you'd see only a generic `curl: (22) ...` and lose the server's real error detail, which is exactly the "silent failure narrated as success" gap GH #152 closes):
   ```bash
   resp=$(curl -sS -w '\n%{http_code}' -X POST "<api_base_url>/api/requests/<request_id>/accept-task" \
     -H 'Content-Type: application/json' \
     ${ORCHA_RUN_TOKEN:+-H "X-Orcha-Run-Token: $ORCHA_RUN_TOKEN"} \
     -d '{"responder_agent_id": "<my agent_id>", "note": "<optional>"}')
   http_code=$(tail -n1 <<<"$resp")
   body=$(sed '$d' <<<"$resp")
   ```
   On 2xx, `$body` is `{"request_id": "...", "status": "accepted", "spawned_task_id": "<new task_id>", "report_back": "REPORT BACK: ...", "report_back_request_id": "<rid>"}`.

   **On any non-2xx `$http_code` — including ones not enumerated below — this is a HARD STOP, not a warning:** do not report a `spawned_task_id`, do not say you accepted/started the task, do not proceed to step 5. Print `$body` verbatim (the real server error) and stop. GH #152: a SessionEnd audit independently cross-checks any "task X created/started" claim you make against the live DB and hard-fails loudly on a mismatch — but the first line of defense is simply never making that claim when the POST didn't actually 2xx.

5. **Report** (only after a confirmed 2xx) — and surface the report-back rule NOW, in this same session:
   - "✓ accepted request <short-rid>. Task <short-tid> created, assigned to me, status in_progress."
   - The task carries forward the title/dod/priority from the request's task spec.
   - **Read the `report_back` field from the response and treat it as a standing instruction for this work** — it is also stored in the spawned task's protocol notes, but you will NOT see it there unless you reload the task protocol, so honor it from here. It tells you: when you've MATERIALLY finished the work, post your real result to the request with `/orcha-respond <report_back_request_id> "<your result>" --alias <alias>` so the requester wakes. That report-back is a distinct step from `/orcha-done` (which only sends the task to human verification).
   - Begin work. When materially done: `/orcha-respond <report_back_request_id> "<result>" --alias <alias>` to answer the request, AND `/orcha-done <spawned_task_id> "<result>" --alias <alias>` to send the task to verification.

## Errors

- **403** "only the target agent may accept" → not addressed to you. Check `/orcha-inbox`.
- **409** "request type is 'info'" → use `/orcha-respond` for info requests, not this skill.
- **409** "request is '<status>'" → too late (already accepted, rejected, or escalated).
- **Any other non-2xx (including a bare 500 or a connection failure)**: not enumerated above on
  purpose — GH #152. Treat it the same as step 4's hard stop: surface `$body` verbatim, do not
  claim the task exists or that you started it, do not proceed to step 5.

## Missing required arguments

If `request_id` is missing, use **AskUserQuestion** to collect it. Suggest running `/orcha-inbox` first to find task-type incoming requests.
