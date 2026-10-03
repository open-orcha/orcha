/** D14: the project's REAL git checkouts, read on the host (read-only) so the sidebar can show
 *  an Orca-like tree: project → branch/checkout → the live agents working on it.
 *
 *  Sources — nothing here is invented:
 *  - `git -C <stack folder> worktree list --porcelain` (the stack folder is the compose
 *    working_dir label = the project root the host notifier daemon runs agents from). Entry 0
 *    is the main working tree = the PRIMARY checkout; the others are worktrees.
 *  - An agent is placed on a task worktree only when the worktree the notifier creates for it
 *    (`orcha_cli/notifier_worktree_stable.provision_task`:
 *    branch `orcha/task-<safe_ref(alias)>-<safe_ref(task_id)[:12]>`) actually EXISTS in that
 *    list, for the task id the portal snapshot reports (active_run.task_id / current_task).
 *  - When the project runs with worktrees disabled (snapshot `container.worktrees_disabled`),
 *    every agent works in the primary checkout, so live agents sit under it.
 *  Anything else (resident / live-terminal / disposable worktrees, no task id) stays
 *  unattributed: the agent renders directly under its project, never under a guessed branch. */
import { execFile } from 'node:child_process'
import path from 'node:path'
import type { HostCheckout, HostLiveAgent } from '../shared/types'

export interface GitWorktree {
  path: string
  /** Short branch name ("main"), null when detached/bare. */
  branch: string | null
  /** HEAD sha (full), when reported. */
  head: string | null
  detached: boolean
  bare: boolean
}

/** Parse `git worktree list --porcelain` (blank-line separated records). */
export function parseWorktreePorcelain(out: string): GitWorktree[] {
  const trees: GitWorktree[] = []
  let cur: GitWorktree | null = null
  for (const raw of out.split('\n')) {
    const line = raw.trimEnd()
    if (line === '') {
      if (cur) trees.push(cur)
      cur = null
      continue
    }
    const sp = line.indexOf(' ')
    const key = sp < 0 ? line : line.slice(0, sp)
    const value = sp < 0 ? '' : line.slice(sp + 1)
    if (key === 'worktree') {
      if (cur) trees.push(cur)
      cur = { path: value, branch: null, head: null, detached: false, bare: false }
    } else if (!cur) {
      continue
    } else if (key === 'HEAD') cur.head = value || null
    else if (key === 'branch') cur.branch = value.replace(/^refs\/heads\//, '') || null
    else if (key === 'detached') cur.detached = true
    else if (key === 'bare') cur.bare = true
  }
  if (cur) trees.push(cur)
  return trees
}

export type RunGit = (cwd: string, args: string[]) => Promise<string>

const defaultRunGit: RunGit = (cwd, args) =>
  new Promise((resolve, reject) => {
    // --no-optional-locks: a background poller must never take .git/index.lock — a poll
    // killed by the timeout would otherwise leave a stale lock that blocks the user's commits.
    execFile('git', ['--no-optional-locks', '-C', cwd, ...args], { encoding: 'utf8', timeout: 3000, maxBuffer: 512 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout)
    )
  })

/** The folder's worktrees, or null when it is not a git repo / git is unavailable. Never
 *  throws — a missing checkout just means "no branch data" (agents nest under the project). */
export async function readWorktrees(folder: string | null, run: RunGit = defaultRunGit): Promise<GitWorktree[] | null> {
  if (!folder) return null
  try {
    const list = parseWorktreePorcelain(await run(folder, ['worktree', 'list', '--porcelain']))
    return list.length > 0 && !list[0].bare ? list : null
  } catch {
    return null
  }
}

/** Port of orcha_cli.notifier_worktree_base.safe_ref (keep in lockstep). */
export function safeRef(value: string | null | undefined): string {
  let slug = String(value || 'agent').replace(/[^A-Za-z0-9._-]/g, '-')
  slug = slug.replace(/\.+/g, '.').replace(/^[.-]+|[.-]+$/g, '')
  return slug || 'agent'
}

/** The branch provision_task creates for (alias, task). */
export function taskBranch(alias: string, taskId: string): string {
  return `orcha/task-${safeRef(alias)}-${safeRef(taskId).slice(0, 12)}`
}

/** "owner/name" for a GitHub binding; null for local / unbound. */
function repoLabel(githubRepo: string | null, folder: string | null): string | null {
  if (githubRepo && githubRepo !== 'local' && githubRepo.includes('/')) return githubRepo
  return folder ? path.basename(folder) : null
}

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : 'HEAD'
}

/** Pure: a container's checkouts and its live agents with the branch each is verifiably on.
 *  `taskIds` maps a live agent's alias to the task id the snapshot reports it on. */
export function attributeCheckouts(input: {
  worktrees: GitWorktree[] | null
  folder: string | null
  githubRepo: string | null
  worktreesDisabled: boolean
  live: HostLiveAgent[]
  taskIds: Map<string, string>
}): { checkouts: HostCheckout[] | null; live: HostLiveAgent[] } {
  const { worktrees, live } = input
  if (!worktrees || worktrees.length === 0) return { checkouts: null, live }
  const repo = repoLabel(input.githubRepo, input.folder)
  const main = worktrees[0]
  const primary: HostCheckout = {
    branch: main.branch ?? `detached @ ${shortSha(main.head)}`,
    primary: true,
    detached: main.branch === null,
    repo
  }
  const byBranch = new Map<string, GitWorktree>()
  for (const w of worktrees.slice(1)) if (w.branch) byBranch.set(w.branch, w)

  const extra = new Map<string, HostCheckout>()
  const attributed = live.map((a) => {
    const taskId = input.taskIds.get(a.alias)
    if (taskId) {
      const b = taskBranch(a.alias, taskId)
      if (byBranch.has(b)) {
        if (!extra.has(b)) extra.set(b, { branch: b, primary: false, detached: false, repo })
        return { ...a, branch: b }
      }
    }
    if (input.worktreesDisabled) return { ...a, branch: primary.branch }
    return { ...a, branch: null }
  })
  return { checkouts: [primary, ...extra.values()], live: attributed }
}
