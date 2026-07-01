---
description: Snapshot the acting agent's memory digest — its current focus, decisions, learnings, and open threads — to the Orcha DB so a future re-binding tab can rehydrate this reasoning (Epic C / D3). Complements (never duplicates) Claude Code file-memory.
allowed-tools: Bash, Read, AskUserQuestion
argument-hint: [--alias <name>]
---

You are executing `/orcha-snapshot`.

**Auth (#271):** every `curl` to the API sends `-H "Authorization: Bearer <token>"`. `<token>` is the `token` field of the acting binding JSON (`.claude/orcha-tabs/<alias>.json`); if the binding predates tokens (or no binding applies, e.g. bootstrap), read the project runtime credential from `.orcha/runtime-token` instead. On a warn-mode stack a missing token still works (logged); on an enforce stack it 401s.

User arguments: `$ARGUMENTS`

## What this is

A per-agent **memory digest** captures your WORK/REASONING state — what you're
focused on, the decisions you've made and why, what you've learned, and the loose
ends you'd want a fresh tab to pick up. It is stored in the Orcha DB keyed by your
`agent_id`, is portal-visible, and is what `orcha rehydrate` replays at SessionStart.

**Ownership boundary (do NOT cross it):** this digest is ONLY your per-agent work
state. Durable USER/PROJECT facts belong in Claude Code file-memory (`MEMORY.md` +
typed frontmatter facts), which loads via its own parallel injector. Don't copy
project facts into the digest, and don't copy your digest into file-memory — they
are non-overlapping with no sync.

## Steps

1. **Identify the acting agent** (resolution order — STOP at first match):
   1. `--alias <name>` in `$ARGUMENTS`
   2. `$ORCHA_ALIAS` env var (`printenv ORCHA_ALIAS`)
   3. Single binding fallback — exactly one `*.json` in `.claude/orcha-tabs/`
   4. Else (multiple bindings) → **AskUserQuestion** "Which agent is snapshotting?" with one option per alias.

   Read `.claude/orcha-tabs/<alias>.json` for `agent_id`.

2. **Read `.claude/orcha.json`** for `api_base_url`.

3. **Compose the digest from your CURRENT working context** (this conversation):
   - `current_focus`: one sentence — what you're doing right now.
   - `decisions`: list of `{"text": "..."}` — choices you've made + rationale, the things a fresh tab must not re-litigate.
   - `learnings`: list of `{"text": "..."}` — non-obvious facts you discovered (gotchas, where things live, constraints).
   - `open_threads`: list of `{"text": "..."}` — loose ends / what you'd do next.
     If a loose end depends on external state (GitHub PR/issue status, Orcha
     task/request status, who owes what, review state), write the query to
     re-run ("check PR #123 status") rather than a frozen verdict ("PR #123 is
     still in review"). A future wake must re-check the source of truth before
     acting or deciding there is nothing to do.
   - `audience` (#325): one short plain-English string — **who** you're talking to,
     **how** they talk (register/vocabulary), and **what they already understand**. This is
     the conversational register, NOT facts: it survives across wakes so the next you doesn't
     revert to internal jargon. E.g. `"Talking to Kedar — non-engineer founder. Wants brief
     plain answers, not structured reports; doesn't parse bare UUIDs / F-labels / SHAs. Lead
     with the answer."` Omit only if you've had no human contact this session.

   Keep it tight and reasoning-focused. Omit anything already obvious from task
   rows or the repo. Omit durable project facts (those go to file-memory).

4. **POST** the snapshot:
   ```bash
   curl -fsS -H "Authorization: Bearer <token>" -X POST "<api_base_url>/api/agents/<agent_id>/digest" \
     -H 'Content-Type: application/json' \
     -d '{"current_focus": "...", "decisions": [{"text":"..."}], "learnings": [{"text":"..."}], "open_threads": [{"text":"..."}], "audience": "who you are talking to + their register"}'
   ```
   Response: `{"digest_id": ..., "agent_id": "...", "snapshot_ts": <epoch>}`

5. **Report**: `✓ Memory digest snapshotted for <alias> (digest #<digest_id>). A re-binding tab will rehydrate this via orcha rehydrate / GET /api/agents/<agent_id>/rehydrate.`

## When to run

- Automatically at the end of `/orcha-done` (that skill snapshots for you).
- Before you expect to stop for a while, or after a meaningful decision/learning.
- Any time you want the portal + a future session to reflect your latest reasoning.

## Errors

- **404** → agent not found (stale binding / DB reset). Re-register.
- **400** → bad UUID in the binding file.
