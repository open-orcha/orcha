# Clean up inactive worktrees

Use **Preview project-wide cleanup** in the portal's worktree settings or the desktop Storage view. The preview includes this repository's linked worktrees in any location, including detached checkouts and other branch names. Confirm **Save work and remove … folders** only after reviewing the list. Automatic cleanup keeps its existing conservative scope.

The command-line equivalent is:

```sh
orcha worktrees preview --project /path/to/project
orcha worktrees execute PREVIEW_ID --project /path/to/project
orcha worktrees status PREVIEW_ID --project /path/to/project --json
orcha worktrees pending --project /path/to/project --json
```

All four commands support `--json`. A caller can choose a UUID with `preview --plan-id UUID`, then poll `status UUID` while the foreground command runs. `execute` confirms only that saved preview. Retrying the same identifier reconciles saved outcomes; it never applies the preview to a replacement checkout. Preview and removal run on the host, outside the portal request and notifier wake loops.

If the host stops, use **Retry interrupted cleanup** in the portal to resume the same saved plan. The host first checks that the previous execution no longer holds the plan's exclusive lock. Folders already removed are reported from their saved receipts. A folder being cleaned up is reserved until completion or recovery; other folders and running commands remain available during slow copying or removal.

Desktop Storage also reads saved unfinished attempts when opened, including cleanup
started directly from the CLI. Choose **Review unfinished cleanup**, inspect its saved
folders, then **Retry interrupted cleanup**. This uses the original plan even after an
app restart. `worktrees pending` lists the same attempts without contacting the portal;
actual recovery still requires complete activity evidence. A surviving cleanup child
keeps its lock, so retry cannot duplicate an operation that is still running.

Use `preview` or `status` to inspect a cleanup without removing anything. `execute --dry-run` is refused. Legacy `clean` and `remove` commands also refuse removal without a reachable project portal; `--offline` remains available for listing and dry-run inspection.

The project's portal must be reachable and support the new activity endpoint. Missing activity evidence blocks cleanup. In-progress tasks remain protected between worker runs, including renamed or detached task checkouts matched through run history or their stable paths. Live runs, sessions, previews, Git locks, managed commands awaiting reconciliation, and newly provisioned checkouts are also protected. Put a `.orcha-keep` file in a checkout, or use `git worktree lock`, to retain it explicitly. The main checkout is always excluded.

The host's process check refuses cleanup if `lsof` reports an ambiguous folder name
(including backslash or caret escapes), unsupported output, or no usable folders.
This can retain unrelated inactive folders too: the display format cannot reliably
distinguish control characters from literal escape text. No filename is guessed.
See [lsof's output encoding rules](https://lsof.readthedocs.io/en/stable/manpage/).

Leftover directories are included only under the project's managed worktree root. Removal requires previously recorded repository ownership and the same directory identity. Unknown historical leftovers, symlink paths, nested repositories, and folders that cannot be inspected are retained with an explanation. Cleanup does not search arbitrary folders for orphan directories.

## Git compatibility and conversation startup

Cleanup and its checkout-startup guards support Git 2.23 and newer. Orcha continues to
use the first `git` on each process's `PATH`; it does not silently select another
installation. The CLI, desktop child and background service can inherit different
paths. In particular, changing Git in an interactive shell does not change an already
running service's saved path. Check the Git used by the process that reports the error.

Repository lookup uses `rev-parse --git-common-dir` and `--absolute-git-dir`, resolves
relative results against the queried checkout, and verifies the directories and their
relationship before creating any state. A successful exit with an echoed unsupported
option is not valid repository information. Access errors and malformed results block
the operation; only Git's explicit no-repository result allows the existing non-Git
project fallback.

When Git supports `worktree list --porcelain -z`, Orcha validates the complete records.
Git 2.23's older text output omits locks and does not quote unusual paths, so Orcha
does **not** guess from those lines. Only an explicit unsupported `-z` response permits
the fallback: verify the common directory, each stored checkout pointer, commit and
lock directly. This preserves spaces, quotes, tabs, newlines and carriage returns in
filenames. Ambiguous or unavailable records retain folders. On old Git, a separate
Git-directory layout whose main checkout cannot be verified requires a Git version
with `worktree list -z` support. Preview and merge-rehearsal creation use the older
atomic `--lock` option; labeling that exact lock never temporarily unlocks it.

Installing this functionality does not intentionally disable conversation wakes.
Cleanup reserves only the checkout it is handling. If a conversation needs that
checkout, its Conversation tab explains the reservation and points to cleanup
recovery. Git/storage errors also produce a visible startup explanation. Queued
messages remain pending, retries back off from five seconds to two minutes, and a
successful startup clears the notice. The lifecycle lock is acquired without waiting;
contention defers startup rather than hanging the notifier or skipping the guard.
The managed-command registration lock is also checked without waiting during startup,
including while older cleanup code holds it during removal.
An interrupted cleanup keeps its reservation until the same saved plan is recovered.
Preview failure and cancelling before confirmation do not reserve a checkout for removal.

## Saved work and disk space

Before removal, files are copied and verified in private local storage under `<git common directory>/orcha/worktree-cleanup/saved/`. This includes ignored configuration, ordinary source files, uncommitted work, staged-only content, symlink values, file modes, and tracked deletions. These archives are never task attachments and are outside the working tree, so normal Git commits do not include them.

Recognized ignored dependency/cache directories can be discarded: package-manager-marked `node_modules`, Python environments with `pyvenv.cfg`, and Python/tool caches. Tracked contents prevent that exemption. Links are not followed, nested repositories prevent removal, and common credential/configuration files inside dependencies are still saved. Arbitrary `build` and `dist` folders are preserved because their names alone do not prove that they are disposable.

Existing branches stay. Recovery references under `refs/orcha/cleanup/` retain each commit and the staged index tree, including detached commits. These references are local; normal branch pushes do not publish them. Each archive has a manifest, the original index, a staged recovery tree, and a `tracked.patch` for tracked edits/deletions. Recovery should be done into a new checkout: inspect the manifest, recreate the saved commit, apply the patch, and copy the saved files as needed. Symlink targets and original file modes are recorded in the manifest rather than creating live links in the archive.

Preview sizes describe allocated checkout space **before** saving files. Archives still occupy disk space; shared filesystem blocks and unknown sizes also mean that reclaimed disk space can differ from the estimate. The final list identifies exactly which folders were removed or retained. A changed checkout, changed files, unavailable activity evidence, or a preservation failure keeps that folder.

## API

`POST /api/containers/{cid}/agent-worktrees/cleanup` queues `phase: preview` or `phase: execute` with the completed preview's `plan_id`. It uses the existing human settings permission. The returned action can be polled at `/api/containers/{cid}/agent-worktrees/actions/{aid}` for incremental results. The host reports progress through `/api/agent-worktrees/actions/{aid}/progress` and obtains complete activity evidence through `/api/containers/{cid}/agent-worktrees/cleanup-context`. The generated OpenAPI document describes these request bodies.
