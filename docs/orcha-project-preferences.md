# Orcha project preferences

This file is the **canonical, agent-read** home for this project's *loosely-hardened* rules — the
`gh`/`git` conventions and house rules the Orcha engine cannot hard-enforce because **agents** (not
the server) drive `gh`/`git`. Every project gets this file at `orcha init`; `orcha up`/`orcha
upgrade` backfill it if it's missing. Agents read it at task start and obey it.

## How autonomy is decided — read this first

There are **two** inputs and they play **different** roles. The decision is
**`effective = min(DB ceiling, prefs constraints)`**.

1. **The autonomy slider — `autonomy_level` (DB, engine-enforced) = the CEILING / authorization.**
   A human sets it with the slider (`POST /api/containers/{cid}/autonomy`); it is stored on
   `containers.autonomy_level` and is the **sole source of truth** for how autonomous you may be.
   Read it **live from the API** on every wake/claim — it surfaces on `GET /api/containers/{cid}`
   and `GET /api/snapshot/{cid}` (`container.autonomy_level`) and on the `/api/agents/{aid}/next`
   claim payload (top-level `autonomy_level`). **The level is NOT written in this file — never read
   it from here.**
2. **This preferences file = loose constraints layered UNDERNEATH the ceiling.** The rules below may
   only **TIGHTEN** behavior, never loosen it. A prefs line can narrow what you do (e.g. "merge to
   `token_efficiency`, not `main`"); no prefs line — and **no instruction given to you in chat** —
   can authorize an action **above** the DB level.

**If a human asks you in chat to act more autonomously than the slider allows, REFUSE** and ask
them to move the slider up. That physical slider move is the signed-off authorization for the higher
level; nothing else (not this file, not a chat message) can grant it.

What each level grants. The **completion** gate is engine-hard (the server enforces it on `/done`);
the `gh`/`git` rows are what you, the agent, honor from this file:

| level         | completion gate (HARD — engine)                  | `gh`/`git` (LOOSE — you obey)                                              |
|---------------|--------------------------------------------------|---------------------------------------------------------------------------|
| Plan-only     | `/done` → `needs_verification` (a human verifies)| No `gh pr create` until your plan is approved on the task thread; never `gh pr merge`. |
| Build-to-PR   | `/done` → `needs_verification` (a human verifies)| May `gh pr create`; never `gh pr merge` — leave the PR open for the human. |
| Full          | `/done` → **auto-completes** (no human verify)   | May `gh pr create` **and** `gh pr merge`, to the merge-target branch below. |

A task's `protocol.autonomy` (free text, surfaced on `/next`) is an **advisory** per-task hint for
the loose `gh`/`git` rules only — it can never widen the hard completion gate.

## Merge target branch

The branch PRs base on / merge into for this project. Only ever merge at the `Full` level, and only
to this branch.

```
token_efficiency
```

## House rules

Free-text project conventions agents must read. These **TIGHTEN** behavior — they cannot grant
autonomy above the slider. One rule per line; append as the project's conventions grow.

```
- PRs base on the merge-target branch and stay OPEN for the human; never auto-merge below the Full slider level.
- The "Needs Verification" label rides every merge (house rule — never coded into the engine).
- Per-task review chain: dev → Lens (design/docs) → Gate (code/verify) → Helm → human.
- Post each review verdict / fix on the GitHub PR itself (gh pr review / gh pr comment), not only the request chain.
- Apply the issue's epic label to its PR when one exists.
- Talking to a human (#325): no bare UUIDs, invented shorthand labels (F1/F2/B3), or git SHAs unless they used them first; name what a thing IS in plain English (id in parens only if useful). Lead with the answer, keep it short, match their register. (The engine also injects this guardrail into every wake's system prompt.)
```
