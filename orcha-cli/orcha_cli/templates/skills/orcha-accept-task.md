---
description: As the target of a task request, accept it — creates the task, assigns it to you, marks it in_progress. Use after seeing the request in /orcha-inbox.
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: <request_id> [--note "..."] [--alias <name>]
---

You are executing `/orcha-accept-task` (Phase 3 / Orcha#5).

User arguments: `$ARGUMENTS`

## Conversation-worker guardrail (GH #90 — check FIRST)

Check `printenv ORCHA_CONVERSATION_WORKER`. **If it is `1`, you are a conversation embodiment — you may accept (that creates and assigns the task, which wakes a separate task worker), but you must NOT begin the work inline in this session.** Do steps 1–4 to accept, then STOP after the short report: say the request was accepted and the task will be worked by its assigned worker. Do NOT start coding/reviewing/editing or call `/orcha-respond`/`/orcha-done` yourself — the separate task worker does that. When `ORCHA_CONVERSATION_WORKER` is unset/empty, follow the full accept-and-work flow below unchanged.

## Steps

1. **Parse `$ARGUMENTS`**:
   - First positional: `request_id` (UUID — the task-request you're accepting)
   - Optional `--note "..."` — a free-text accept note; stored in the request's `response`
   - Optional `--alias <name>` — see step 2

2. **Identify the acting agent** (REQUIRED — must be the request's target) using resolution order:
   `--alias` arg → `$ORCHA_ALIAS` env → single binding file → AskUserQuestion picker. Read `.claude/orcha-tabs/<alias>.json` to get `agent_id`.

3. **Read `.claude/orcha.json`** for `api_base_url`.

4. **POST**:
   ```bash
   curl -fsS -X POST "<api_base_url>/api/requests/<request_id>/accept-task" \
     -H 'Content-Type: application/json' \
     -d '{"responder_agent_id": "<my agent_id>", "note": "<optional>"}'
   ```
   Response: `{"request_id": "...", "status": "accepted", "spawned_task_id": "<new task_id>", "report_back": "REPORT BACK: ...", "report_back_request_id": "<rid>"}`

5. **Report** — and surface the report-back rule NOW, in this same session:
   - "✓ accepted request <short-rid>. Task <short-tid> created, assigned to me, status in_progress."
   - The task carries forward the title/dod/priority from the request's task spec.
   - **Read the `report_back` field from the response and treat it as a standing instruction for this work** — it is also stored in the spawned task's protocol notes, but you will NOT see it there unless you reload the task protocol, so honor it from here. It tells you: when you've MATERIALLY finished the work, post your real result to the request with `/orcha-respond <report_back_request_id> "<your result>" --alias <alias>` so the requester wakes. That report-back is a distinct step from `/orcha-done` (which only sends the task to human verification).
   - Begin work. When materially done: `/orcha-respond <report_back_request_id> "<result>" --alias <alias>` to answer the request, AND `/orcha-done <spawned_task_id> "<result>" --alias <alias>` to send the task to verification.

## Errors

- **403** "only the target agent may accept" → not addressed to you. Check `/orcha-inbox`.
- **409** "request type is 'info'" → use `/orcha-respond` for info requests, not this skill.
- **409** "request is '<status>'" → too late (already accepted, rejected, or escalated).

## Missing required arguments

If `request_id` is missing, use **AskUserQuestion** to collect it. Suggest running `/orcha-inbox` first to find task-type incoming requests.
