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

## PR human-attribution (agent-opened PRs)

An Orcha agent opens PRs authenticated as the GitHub App, so the PR **author** shows the bot — but
the author line then hides the human who TRIGGERED the work. Every agent-opened PR MUST additionally
attribute that human (docs/agent-prs.md). Fetch the requester from
`GET /api/agents/<agent_id>/protocol?task_id=<task_id>` → `requested_by {alias, github_login, git_email}`.
Two pieces, both required:

1. **Highlighted blockquote as the FIRST line of the PR body** (renders prominently at the top):

   ```
   > 🧑 Triggered by @<github_login> via Orcha task <task_id>
   ```

   Fallback when the human has no registered `github_login`: use the display alias with NO `@`.
   Never omit the line — always include the task id even without a handle.

2. **`Co-authored-by` trailer on the branch's final commit** (blank line, then the trailer):

   ```
   Co-authored-by: <alias> <git_email>
   ```

   When `git_email` is null, use `<github_login>@users.noreply.github.com` (GitHub still links the
   commit to their account); when both are null, skip the trailer but keep the blockquote.

This is attribution ON a PR the task and repository rules already allow — it never authorizes
opening or merging one.

## Merge target branch

The branch PRs base on / merge into for this project. Never merge merely because task autonomy is
on; follow the task's explicit human-controlled review and merge instructions.

```
main
```

## House rules

Free-text project conventions agents must read. These **TIGHTEN** behavior — they cannot turn task
autonomy on or grant additional authority. One rule per line; append as the project's conventions grow.

```

```
