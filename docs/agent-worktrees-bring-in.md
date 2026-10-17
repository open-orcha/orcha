# Agent worktrees: bring changes into main, update from main (GH #288)

Every agent works in its own git worktree under `<project>/.orcha-worktrees` — always.
The former "Disable worktrees" project setting is gone (migration 072 forces it off), and
nothing is carried between checkouts on a worker's start path any more: a worker, resident
or live terminal always starts in its destination. When an earlier checkout still holds
uncommitted work, the task thread gets one notice naming it, and a human collects it with
the explicit action described here.

## What it does

| Action | Direction | What lands where |
|---|---|---|
| **Bring in** | task worktree → main checkout | the agent's delta (commits since the branch forked + its uncommitted and untracked files; never ignored files or Embodent scaffolding). **Apply** (default): as uncommitted, unstaged changes in main's working tree — you review and commit. **Merge**: the agent's uncommitted work is WIP-committed on its branch and the branch is merged `--no-ff` into main's current branch. |
| **Update** | main checkout → task worktree | main's HEAD is merged into the agent's branch and main's uncommitted changes are applied on top, so the branch does not drift. |

Both run on the host (the notifier daemon does the git work; the portal only records the
request and the result) and both follow the same rules:

- **Dry run first, always.** The dialog (or `--dry-run`) shows the files that would change,
  conflicts, whether main moved ahead, which branch main is on, and whether the receiving
  checkout has uncommitted files. Nothing changes until you confirm.
- **Rehearsed in a temporary worktree.** The two checkouts are snapshotted (HEAD + uncommitted,
  scaffolding and ignored files left out) and three-way merged from the recorded sync point.
  Main having moved ahead since the branch forked is the ordinary three-way case. A failed
  rehearsal never touches a real checkout.
- **Conflicts are reported, nothing is applied.** The dialog offers *Ask &lt;agent&gt; to
  resolve them*: a direct prompt that tells the agent to merge the base branch into its own
  worktree and resolve there (it must not touch main). Then bring in again.
- **Your uncommitted files are never committed.** When the receiving checkout is dirty the
  dialog offers a **named stash** (`orcha-bring-in/<worktree>/<stamp>`, or the name you type) —
  ticked by default. It is restored by SHA afterwards and dropped only when the restore was
  clean; if it would conflict it is **kept** and the dialog says so (`git stash list`). *Apply*
  can also run without the stash: the three-way merge then carries your edits too. *Merge*
  needs the stash. Never a bare `git stash` / `stash pop` on the shared stack.
- **Main on another branch** than the agent's base must be confirmed explicitly.
- **Not while the agent runs there.** The buttons are disabled while a run is live in that
  worktree (checked live against `worker_runs`, not the inventory) and come back when it
  finishes.
- **Repeat bring-ins are incremental.** `refs/orcha/bring-in/<worktree>` and
  `<git-common-dir>/orcha/bring-in/<worktree>.json` record the last sync; the next run only
  carries what changed since. The dialog shows "Last brought in …".
- **The agent's worktree is untouched** by *Apply*. *Merge* adds a WIP commit to its branch.
  *Update* changes it by definition (its own uncommitted files are stashed and restored).

## Where

- **Settings › Execution › Agent worktrees** — *Bring in* and *Update* on every task
  worktree row.
- **Code Space › Changes** — an *Agent worktrees* block under the branch bar.
- **Agents page** — the per-agent menu: *Bring changes into main…* / *Update worktree from
  main…* (the agent's current task worktree).
- **CLI** (host, works offline):

  ```sh
  orcha worktrees bring-in <path | task-id-prefix | agent> --dry-run
  orcha worktrees bring-in <…> [--mode apply|merge] [--stash [--stash-message TEXT]] [--allow-other-branch] [--json]
  orcha worktrees update-from-main <…> [--dry-run] [--stash [--stash-message TEXT]] [--json]
  ```

  `orcha worktree` is an alias. `--json` prints the plan / result as one object with `ok`.

## API

`POST /api/containers/{cid}/agent-worktrees/actions` with `action: bring_in |
update_from_main`, the worktree `path` (from the inventory) and `options`
`{dry_run, mode, stash, stash_message, allow_other_branch}`; poll
`GET …/actions/{id}` until the notifier reports `done` (`result` = the plan or the run
result) or `failed` (`error` = the refusal). The full contract is in `/openapi.json`
(`WorktreeActionCreate`, `BringInOptions`). Migration 073 adds the two kinds and the
`options` column to `agent_worktree_actions`.

## Migration from the toggle

Projects that had *Disable worktrees* on are forced back to isolated routing on upgrade. Their
agents start their next run in a fresh worktree from the base branch; their previous
uncommitted work is already in main's working tree (that was the point of the mode), so
nothing is lost and nothing needs carrying. PR #277 (per-stream provenance for the shared
main checkout) is held: the mode it served is gone.
