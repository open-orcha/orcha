---
description: Hand work to QA: file a QA request for the task you finished or are finishing, with what to test and what to prove. The project's QA agent gets a linked task and the result comes back on your task's thread. Plain HTTP, no device and no QA tools needed. Use when your change touches what a user sees, when your task or the project's preferences ask for QA, or when a person asks you to send work to QA.
allowed-tools: Bash, Read
argument-hint: [task_id] [--kind map|explore|draft|check] [--platform ios|android|web] [--focus "<what to look at first>"] [--on-fail report|reopen]
---

You are executing `/orcha-qa-request`. You are handing work to QA, not testing it yourself: no device,
no `mcp__orcha-qa` tools and no QA extra are needed.

User arguments: `$ARGUMENTS`

## 1. When

Hand off when your change touches what a user sees or does, when your task says so, or when a person
asks. Hand off working code: QA tests a build. Skip it for docs, tests or a refactor nothing can see,
and never hand off instead of testing what you can test yourself.

## 2. What to send

Read `.claude/orcha.json` for `api_base_url`, and your agent id from your binding, as `/orcha-post`
does. From the task's thread and your own work, fill in:

- `kind`: `check` runs approved scenarios, `explore` looks for bugs around a change, `map` and `draft`
  fill in the QA tab. Leave it out and QA checks when the project has approved scenarios, else explores.
- `platform`: `ios`, `android` or `web`. Left out, the project's default.
- `focus`: what you changed and what to look at first, in a sentence or two.
- `acceptance`: the lines to prove. Left out, the task's definition of done. Write them as outcomes
  someone can see on the screen.
- `build`: what to test: `branch`, `commit`, `url` (where it runs), `app_path` (a `.app` or `.apk`),
  `notes`. Say it plainly: a QA agent tests whatever is on the device otherwise.
- `scenario_ids` or `tags`: specific scenarios, when you know them.
- `on_fail`: `report` puts the findings on your thread; `reopen` also sends your task back to
  `in_progress` with them, and QA runs again when you finish again, for the project's number of rounds.
  Left out, the project's setting.

## 3. Send it

```bash
curl -sS -X POST "<api_base_url>/api/tasks/<task_id>/qa/requests" -H "Content-Type: application/json" -d '{
  "actor_agent_id": "<your agent id>",
  "kind": "check", "platform": "ios",
  "focus": "The checkout total after a discount code",
  "acceptance": ["A valid code lowers the total shown at checkout"],
  "build": {"branch": "feat/discounts", "commit": "abc1234"},
  "on_fail": "reopen"
}'
```

The answer is `{request, qa_task_id}`. With the CLI the same thing is
`orcha qa request --task <task_id> --kind check --platform ios --focus "..." --acceptance "..." --branch feat/discounts`.
With no task to attach it to, `POST <api_base_url>/api/containers/<cid>/qa/requests` takes the same body,
and the result comes to you.

`409` means QA already has this task open, or the task cannot go to QA: read the sentence and do not
retry. Post the request id on your thread (`/orcha-post`).

## 4. What comes back

When QA finishes you get a `[QA result]` post on your task's thread, and you are woken. The evidence
pack marks the lines it proved. Then:

- **passed**: nothing to do. A QA pass is evidence, not a verdict on your task: it finishes only as the project's rule says.
- **failed**, and your task went back to `in_progress`: fix what it lists, then `/orcha-done` again. QA
  runs again by itself: do not file a second request.
- **failed** with `report`: fix it, or say why not, on the thread.
- **blocked**: QA could not tell. Read why; it proves nothing either way.

Never mark a task verified because QA passed, and never approve a scenario.
