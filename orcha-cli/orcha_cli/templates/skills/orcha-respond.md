---
description: Answer an info request addressed to the acting agent. Flips the request from 'open' to 'answered'.
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: <request_id> "<answer text>" [--alias <name>]
---

You are executing `/orcha-respond`.

User arguments: `$ARGUMENTS`

## Steps

1. **Parse `$ARGUMENTS`**:
   - First positional: `request_id` (UUID — typically copied from `/orcha-inbox`)
   - Remaining quoted: `response` (your answer)
   - Optional `--alias <name>` — see step 2

2. **Identify the acting agent** (REQUIRED — must be the request's target) using this resolution order — STOP at the first match:
   1. **`--alias <name>` in `$ARGUMENTS`** → use that alias.
   2. **`$ORCHA_ALIAS` env var** (`printenv ORCHA_ALIAS`) → if non-empty, use it.
   3. **Single binding fallback** → if `.claude/orcha-tabs/` contains exactly one `*.json` file, use its alias.
   4. **Else** (multiple bindings, no disambiguator):
      - If ZERO binding files → STOP: `Only the request's target agent can respond. Register first via /orcha-register-agent.`
      - Otherwise → use **AskUserQuestion** to ask `"Which agent is responding?"` with one option per registered alias. Use the user's pick.

   Read `.claude/orcha-tabs/<alias>.json` to get `agent_id` (used as `responder_agent_id`).

3. **Read `.claude/orcha.json`** for `api_base_url`.

4. **POST**:
   ```bash
   curl -fsS -X POST "<api_base_url>/api/requests/<request_id>/respond" \
     -H 'Content-Type: application/json' \
     -d '{"responder_agent_id": "<my agent_id>", "response": "<answer>"}'
   ```
   Response: `{"request_id": "...", "status": "answered"}`

   **ISS-24 — already-answered is a safe no-op, not a failure.** The endpoint is idempotent
   for the request's own target: if the request was *already* answered (e.g. the daemon and a
   live `/orcha-listen` both fired, or an at-least-once retry after a dropped response), it
   returns **200** with `"already_answered": true` and echoes the existing `response` —
   it does NOT re-answer or 409. So **inspect the body before reporting**: if
   `already_answered` is true, treat it as done-by-someone-already and report it as a no-op
   (step 5, second form) rather than claiming you just answered. Only `closed`/`accepted`
   requests 409 (a genuine illegal transition).

5. **Report**:
   - Fresh answer (`already_answered` absent/false): `request <short-id> answered. Requester sees the answer; they will /orcha-close <rid> --alias <their_alias> or /orcha-escalate.`
   - Already answered (`already_answered` true): `request <short-id> was already answered (no-op); existing answer left in place.` — do not re-post or duplicate.

## Missing required arguments

If `request_id` or `response` is missing from `$ARGUMENTS`, use **AskUserQuestion** to collect them. For `request_id`, suggest running `/orcha-inbox` first to see what's available. For `response`, free-text. Bundle into one call when both are missing.

## Errors

- **403** "only the target agent may respond" → this request is addressed to someone else; check `/orcha-inbox` for what's actually yours.
- **200** `"already_answered": true` → NOT an error; the request was already answered (idempotent no-op). See step 4 — report it as a no-op, don't retry.
- **409** "request is '<status>', not 'open' — cannot respond" → the request is `closed` or `accepted` (a terminal state); it can't be answered. (An already-`answered` request does NOT 409 — it returns 200 per above.)
- **409** "request was escalated to human" → target_id is null; a human must handle it now.
