# Orcha project preferences

This file is the **canonical, agent-read** home for this project's *loosely-hardened* rules — the
`gh`/`git` conventions and house rules the Orcha engine cannot hard-enforce because **agents** (not
the server) drive `gh`/`git`. Every project gets this file at `orcha init`; `orcha up`/`orcha
upgrade` backfill it if missing and safely replace the retired autonomy section in older generated
copies while preserving project-specific rules. Agents read it at task start and obey it.

## Task autonomy — read this first

Task autonomy is the only approval authority. Read the assigned task's live `autonomy` value on
every wake or claim. It has exactly two states and new tasks default to `off`:

| task value | plan and work gate |
|------------|--------------------|
| `off` | Ask for human approval of the plan before starting, and ask for human acceptance of the finished work. |
| `on` | The assigned agent may approve its own exact plan, start automatically, and accept its own exact finished-work revision against the task's requirements and definition of done. |

Only the human project owner may change a task's value. A change affects future actions only;
recorded approvals, completed work, dependencies, holds, schedules, stop instructions and history
stay unchanged. Root tasks remain human-controlled.

Task autonomy never bypasses workflow admission, prerequisites, serial/parallel scheduling,
review or correction gates, evidence checks, cancellation, worker-stop rules, or the human-only
workflow Finish action. Agents may send requests to people or other agents in either state.

The old project `autonomy_level`, enforcement flag and per-agent override are retired authority.
They may remain in stored history for compatibility, but agents must not consult them. Their old
write endpoints fail closed. Free-text protocol notes and this preferences file can tighten
behavior but cannot turn task autonomy on.

Task autonomy does not authorize publishing, deploying, destructive actions, or merging a pull
request. Those actions still require the task's explicit instructions and repository rules; when
unspecified, stop for a person.

## Merge target branch

The branch PRs base on / merge into for this project. Never merge merely because task autonomy is
on; follow the task's explicit human-controlled review and merge instructions.

```
token_efficiency
```

## House rules

Free-text project conventions agents must read. These **TIGHTEN** behavior — they cannot turn task
autonomy on or grant additional authority. One rule per line; append as the project's conventions grow.

```
- PRs base on the merge-target branch and stay OPEN for the human; task autonomy never grants merge permission.
- The "Needs Verification" label rides every merge (house rule — never coded into the engine).
- Per-task review chain: dev → Lens (design/docs) → Gate (code/verify) → Helm → human.
- Post each review verdict / fix on the GitHub PR itself (gh pr review / gh pr comment), not only the request chain.
- Apply the issue's epic label to its PR when one exists.
- Talking to a human (#325): no bare UUIDs, invented shorthand labels (F1/F2/B3), or git SHAs unless they used them first; name what a thing IS in plain English (id in parens only if useful). Lead with the answer, keep it short, match their register. (The engine also injects this guardrail into every wake's system prompt.)
```
