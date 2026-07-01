---
description: One periodic-poll iteration for the acting agent — fetch inbox + answered outgoing, surface (and optionally auto-close) what's actionable, report current status and the suggested next-check interval. Pair with /loop for autonomous polling.
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: "[--alias <name>] [--idle-interval N] [--working-interval N] [--auto-close]"
---

You are executing `/orcha-checkpoint`.

**Auth (#271):** every `curl` to the API sends `-H "Authorization: Bearer <token>"`. `<token>` is the `token` field of the acting binding JSON (`.claude/orcha-tabs/<alias>.json`); if the binding predates tokens (or no binding applies, e.g. bootstrap), read the project runtime credential from `.orcha/runtime-token` instead. On a warn-mode stack a missing token still works (logged); on an enforce stack it 401s.

User arguments: `$ARGUMENTS`

## Steps

1. **Identify the acting agent** (4-step resolution: --alias > $ORCHA_ALIAS > single-binding > AskUserQuestion picker). Read `.claude/orcha-tabs/<alias>.json` to get `agent_id`.

2. **Read `.claude/orcha.json`** for `api_base_url`.

3. **Parse polling cadence** (in seconds, integers):
   - `--idle-interval N` from `$ARGUMENTS` → otherwise `$ORCHA_IDLE_INTERVAL` env → otherwise **10**.
   - `--working-interval N` from `$ARGUMENTS` → otherwise `$ORCHA_WORKING_INTERVAL` env → otherwise **30**.
   - `--auto-close` flag toggle (default OFF).

4. **GET** both endpoints:
   ```bash
   curl -fsS -H "Authorization: Bearer <token>" "<api_base_url>/api/agents/<agent_id>/inbox"
   curl -fsS -H "Authorization: Bearer <token>" "<api_base_url>/api/agents/<agent_id>/outbox?status=answered"
   ```

5. **Act, where reasonable.** For each:

   **incoming open** request:
   - If you can synthesize a confident answer from prior context in this conversation → `POST /api/requests/<rid>/respond` with `{"responder_agent_id": "<my agent_id>", "response": "<answer>"}`.
   - If you cannot → leave it open and just list it.
   - Never invent answers. When in doubt, leave it for the human.

   **answered outgoing** request (where you are the requester):
   - If `--auto-close` was passed AND the response looks sufficient → `POST /api/requests/<rid>/close` with `{"requester_agent_id": "<my agent_id>"}`.
   - Otherwise list it as "ready to close or chain off."
   - If the request has `parent_request_id` AND that parent is in your incoming list → flag `★ unblocks parent <short-parent-rid>` — you can now answer the parent.

6. **GET the agent's own row** to learn current status (after step 5's actions may have changed it):
   ```bash
   curl -fsS -H "Authorization: Bearer <token>" "<api_base_url>/api/containers/<cid>" \
     | python3 -c "import sys,json;d=json.load(sys.stdin);a=[a for a in d['agents'] if a['id']=='<agent_id>'][0];print(a['status'])"
   ```
   (Or read the snapshot once at the start and reuse.)

7. **Pick the next interval** based on current status:
   - `idle` → `<idle-interval>` seconds
   - `working` or `awaiting_request` or `awaiting_human` → `<working-interval>` seconds
   - `terminated` or `blocked` → don't suggest a next check; tell the user to intervene
   - For unrecognised statuses → fall back to working interval

8. **Report** compactly:
   ```
   checkpoint: <alias>  status=<status>  turns=<n>/<budget>

   incoming: <N> open
     • <short-rid>  from <requester_alias>  pri=<n>  "<payload preview>"
     [if you auto-answered]   ✓ answered: <rid>
     ...

   answered outgoing: <M> waiting
     • <short-rid>  to <target_alias>  "<answer preview>"
       [if chained AND unblocks an incoming]  ★ unblocks parent <short-rid>
     [if --auto-close used]  ✓ closed: <rid>
     ...

   actions: <K> taken (answered=<a>, closed=<b>)
   next check suggested in <interval>s (status=<status>)
   ```

## Periodic loop pattern

The checkpoint is a single iteration. To run it on a recurring schedule, pair with `/loop`:

```
/loop <interval> /orcha-checkpoint --alias <name> [--auto-close]
```

But since the right interval depends on status (idle=10s, working/waiting=30s), the
recommended pattern is:

```
/loop /orcha-checkpoint --alias <name> [--auto-close]
```

Omit the interval — `/loop` lets the model self-pace based on the "next check suggested in Ns" line at the end of each checkpoint's output. The agent reads its own recommendation and waits the right amount.

## Why this is "good collaborator" behavior, not autonomous decision-making

- Auto-responding only fires when the answer is **confidently derivable** from context, never invented. When unclear, hand to human.
- Auto-closing is **opt-in** via `--auto-close`. Default is just "surface for the user."
- No action escalates work; only the human and explicit agent invocations create new tasks / new agents.
- Per the design, this preserves the human-authoritative principle: the verification gate, agent creation, and approve/reject flows still belong to the human; the agent just stops being a passive idle blob between turns.
