---
description: Show the acting agent's outgoing requests (any status) — full visibility into what I asked, who I asked, and where each is in the request state machine.
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: "[--status open|answered|closed|all] [--alias <name>]"
---

You are executing `/orcha-outbox`.

User arguments: `$ARGUMENTS`

## Steps

1. **Identify the acting agent** using this resolution order — STOP at the first match:
   1. **`--alias <name>` in `$ARGUMENTS`** → use that alias.
   2. **`$ORCHA_ALIAS` env var** (`printenv ORCHA_ALIAS`) → if non-empty, use it.
   3. **Single binding fallback** → if `.claude/orcha-tabs/` contains exactly one `*.json` file, use its alias.
   4. **Else** (multiple bindings, no disambiguator):
      - If ZERO binding files → STOP: `No registered agents in this project. Run /orcha-register-agent <alias> --role "..." --prompt "..." first.`
      - Otherwise → use **AskUserQuestion** to ask `"Whose outbox should I show?"` with one option per registered alias. Use the user's pick.

   Read `.claude/orcha-tabs/<alias>.json` to get `agent_id`.

2. **Parse `--status`** (optional). Default: API's default (non-closed). If user passed `--status all`, omit the `status` query param so the API returns all statuses including closed. Otherwise pass the value through.

3. **Read `.claude/orcha.json`** for `api_base_url`.

4. **GET**:
   ```bash
   # default
   curl -fsS "<api_base_url>/api/agents/<agent_id>/outbox"
   # with explicit status
   curl -fsS "<api_base_url>/api/agents/<agent_id>/outbox?status=<status>"
   ```
   Response: `{"outgoing_requests": [{ id, status, priority, payload, response, target_alias, parent_request_id, chain_depth, created_at, responded_at, closed_at, expires_at, ... }, ...]}`

5. **Pretty-print** as a compact list, grouped by status. For each row:
   ```
   • <short-rid>  pri=<n>  status=<status>  to <target_alias or "(human)">  depth=<chain_depth>
     <created_at>  Q: <payload-preview>
     [if answered]    A: <response-preview>
     [if chained]     parent: <short-parent-rid>
     [if expires]     expires: <expires_at>
   ```

   If empty: `outbox: 0 requests (status=<filter>)`.

6. **End with hints**:
   - Group counts: `N open, M answered, K closed, ...`
   - For answered: `→ /orcha-close <rid> --alias <alias> to close, or /orcha-ask ... --in-service-of <rid> to ask a follow-up.`
   - For old `open` requests near `expires_at`: `→ consider /orcha-escalate <rid> --alias <alias> if you're blocked.`

## Difference from /orcha-inbox

- **/orcha-inbox**: what's on my plate RIGHT NOW (incoming + answered-asks). The action queue.
- **/orcha-outbox**: full audit of what I asked, regardless of status. The history / debugging view.

Use inbox for routine flow; outbox to debug or review what your past chains look like.
