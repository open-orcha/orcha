---
description: Show what's on the acting agent's plate — incoming requests (need to answer) AND outgoing requests now answered (close or use to resume a parent). Two sections.
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: "[--alias <name>]"
---

You are executing `/orcha-inbox`.

## Steps

1. **Identify the acting agent** using this resolution order — STOP at the first match:
   1. **`--alias <name>` in `$ARGUMENTS`** → use that alias.
   2. **`$ORCHA_ALIAS` env var** (`printenv ORCHA_ALIAS`) → if non-empty, use it.
   3. **Single binding fallback** → if `.claude/orcha-tabs/` contains exactly one `*.json` file, use its alias.
   4. **Else** (multiple bindings, no disambiguator):
      - If ZERO binding files → STOP: `No registered agents in this project. Run /orcha-register-agent <alias> --role "..." --prompt "..." first.`
      - Otherwise → use **AskUserQuestion** to ask `"Which agent's inbox should I show?"` with one option per registered alias. Use the user's pick.

   Read `.claude/orcha-tabs/<alias>.json` to get `agent_id`.

2. **Read `.claude/orcha.json`** for `api_base_url`.

3. **GET both endpoints** in parallel:
   ```bash
   curl -fsS "<api_base_url>/api/agents/<agent_id>/inbox"
   curl -fsS "<api_base_url>/api/agents/<agent_id>/outbox?status=answered"
   ```
   - `/inbox` returns `{"open_requests": [...]}` — requests addressed to me, status `open`
   - `/outbox?status=answered` returns `{"outgoing_requests": [...]}` — my asks that have been answered (each row includes `target_alias`, `parent_request_id`, `chain_depth`, `response`)

4. **Pretty-print as two sections**. Don't dump raw JSON.

   ```
   inbox for <alias> — incoming (N) + my answered asks (M)

   ── INCOMING (need to answer) ──
     • <short-rid>  pri=<n>  from <requester_alias>   chain_depth=<d>  (expires <ts>)
       <payload-first-line-truncated-to-~120-chars>
     ...
     (or "(none — nothing addressed to you)" if empty)

   ── MY ASKS NOW ANSWERED (close or resume) ──
     • <short-rid>  to <target_alias>   chain_depth=<d>   (answered <ts>)
       Q: <payload-preview>
       A: <response-preview>
       → if this request has parent_request_id AND that parent's target is YOU and parent.status='open':
         "  ★ unblocks: parent <short-parent-rid> — you can now answer it"
       → otherwise: "  next: /orcha-close <rid> --alias <alias>"
     ...
     (or "(none — no answers waiting)" if empty)
   ```

   To compute the "unblocks" cross-reference: for each answered outgoing whose `parent_request_id` is non-null, check if that parent exists in the incoming list (step 3's `/inbox` result). If yes, mark it as unblocking.

5. **End with hints**:
   - If incoming non-empty: `To answer: /orcha-respond <rid> "<answer>" --alias <alias>. To escalate: /orcha-escalate <rid> --alias <alias>.`
   - If answered-asks non-empty: `To close: /orcha-close <rid> --alias <alias>. To chain off an answer: /orcha-ask ... --in-service-of <parent_rid>.`
   - If both empty: `Inbox clear. /orcha-next to pick up a task, or wait.`

## Note

Task requests (`/orcha-ask --task ...`) and the agent-suggestion path are Phase 3; they'll show up in incoming alongside info requests when shipped. Chain support (`--in-service-of`) and outbox merge ship now (Orcha#1).
