/** Terminal sessions as sidebar rows (Orca-style): which project row and which branch /
 *  checkout each open terminal tab belongs to, and what its row says. Pure — sessions.test.ts.
 *
 *  Placement rules (nothing guessed):
 *  - project row: the row the session was launched from (`tab.rowKey`) when it still exists,
 *    else the first row of the tab's compose project; a home-folder tab (no project) or one
 *    whose stack is gone is "unplaced" (the sidebar's Local group).
 *  - branch: the branch main resolved the session's checkout to (`git worktree list`). A
 *    session in the project folder sits under the PRIMARY checkout. A real worktree branch the
 *    sidebar does not list yet gets its own (non-primary) checkout row — it is real data from
 *    main, not a guess. No branch data at all → the session nests directly under the project. */
import type { HostCheckout } from '../../../shared/types'
import { kindLabel, type TermTab } from './termTabs'

/** `done` = a live agent finished its turn (hook-reported ✓); `ok` = the process exited 0. */
export type SessionStatus = 'starting' | 'running' | 'idle' | 'attention' | 'done' | 'ok' | 'error'

export function sessionStatus(tab: TermTab): SessionStatus {
  if (tab.status === 'starting') return 'starting'
  if (tab.status === 'failed') return 'error'
  if (tab.status === 'exited') return tab.exit && tab.exit.exitCode === 0 && !tab.exit.signal ? 'ok' : 'error'
  const meta = tab.meta
  if (!meta) return 'idle'
  switch (meta.status) {
    case 'working':
      return 'running'
    case 'done':
      return 'done'
    case 'attention':
      return 'attention'
    case 'error':
      return 'error'
    case 'idle':
      return 'idle'
  }
  // A meta from an older main without `status`: alive is not working — spin only while busy.
  if (meta.attention) return 'attention'
  return meta.busy ? 'running' : 'idle'
}

/** Row title: the user's name for it, else the program's own window title (Claude Code's
 *  task summary), else the launcher name ("zsh", "Claude", "Codex"). */
export function sessionTitle(tab: TermTab): string {
  return tab.customTitle ?? tab.meta?.title ?? kindLabel(tab.kind, tab.shell)
}

/** The muted fragment after " - ": latest meaningful output, or the exit / start state. */
export function sessionSnippet(tab: TermTab): string | null {
  if (tab.status === 'failed') return tab.error ?? 'failed to start'
  if (tab.status === 'starting') return 'starting…'
  const snip = tab.meta?.snippet ?? null
  if (tab.status === 'exited' && tab.exit) {
    const how = tab.exit.signal ? `killed (signal ${tab.exit.signal})` : `exited ${tab.exit.exitCode}`
    return snip ? `${how} · ${snip}` : how
  }
  // Nothing to add when the snippet would just repeat the title.
  return snip && snip !== sessionTitle(tab) ? snip : null
}

export function statusLabel(status: SessionStatus): string {
  switch (status) {
    case 'starting':
      return 'starting'
    case 'running':
      return 'working'
    case 'idle':
      return 'idle'
    case 'attention':
      return 'waiting for you'
    case 'done':
      return 'done'
    case 'ok':
      return 'finished'
    case 'error':
      return 'failed'
  }
}

/** Accessible name / tooltip for a session row. A hook-reported status reads "done · 2m ago"
 *  (time of the agent's last lifecycle event); otherwise "idle · active 2m ago". */
export function sessionLabel(tab: TermTab, now = Date.now()): string {
  const snip = sessionSnippet(tab)
  const ago = sessionAgo(tab, now)
  const status = sessionStatus(tab)
  const hooked = isLive(tab) && typeof tab.meta?.statusAt === 'number'
  const when = ago ? (ago === 'now' ? 'just now' : `${ago} ago`) : null
  const tail = when ? (hooked ? ` · ${when}` : ` · active ${when}`) : ''
  return `${sessionTitle(tab)}${snip ? ` - ${snip}` : ''} · ${statusLabel(status)}${tail}`
}

/** Compact relative time ("now", "5m", "3h", "2d") of the last agent lifecycle event when the
 *  status is hook-reported, else of the last output. */
export function sessionAgo(tab: TermTab, now = Date.now()): string | null {
  const at = tab.meta?.statusAt
  const t = isLive(tab) && typeof at === 'number' && Number.isFinite(at) ? at : tab.meta?.lastActivity
  if (typeof t !== 'number' || !Number.isFinite(t)) return null
  const m = Math.max(0, Math.floor((now - t) / 60_000))
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  if (m < 1440) return `${Math.floor(m / 60)}h`
  return `${Math.floor(m / 1440)}d`
}

export function isLive(tab: TermTab): boolean {
  return tab.status === 'running' || tab.status === 'starting'
}

export interface RowRef {
  key: string
  stack: { project: string }
  checkouts: HostCheckout[] | null
}

export interface RowSessions {
  /** Sessions per checkout branch (keys are HostCheckout.branch). */
  byBranch: Map<string, TermTab[]>
  /** Real branches sessions are on that the row's checkouts don't list (worktrees). */
  extraCheckouts: HostCheckout[]
  /** Sessions with no branch data → directly under the project. */
  loose: TermTab[]
  all: TermTab[]
}

export interface SessionGroups {
  byRow: Map<string, RowSessions>
  /** Home-folder sessions and sessions whose project is gone. */
  unplaced: TermTab[]
}

export function groupSessions(rows: readonly RowRef[], tabs: readonly TermTab[]): SessionGroups {
  const byRow = new Map<string, RowSessions>()
  const unplaced: TermTab[] = []
  const rowByKey = new Map(rows.map((r) => [r.key, r]))
  for (const tab of tabs) {
    let row = tab.rowKey ? rowByKey.get(tab.rowKey) : undefined
    if (row && tab.project !== null && row.stack.project !== tab.project) row = undefined
    if (!row && tab.project !== null) row = rows.find((r) => r.stack.project === tab.project)
    if (!row) {
      unplaced.push(tab)
      continue
    }
    let g = byRow.get(row.key)
    if (!g) {
      g = { byBranch: new Map(), extraCheckouts: [], loose: [], all: [] }
      byRow.set(row.key, g)
    }
    g.all.push(tab)
    const checkouts = row.checkouts ?? []
    const primary = checkouts.find((c) => c.primary) ?? null
    let branch: string | null = null
    if (tab.branch && checkouts.some((c) => c.branch === tab.branch)) branch = tab.branch
    else if (tab.branch && checkouts.length > 0) {
      if (!g.extraCheckouts.some((c) => c.branch === tab.branch)) {
        g.extraCheckouts.push({ branch: tab.branch, primary: false, detached: false, repo: primary?.repo ?? null })
      }
      branch = tab.branch
    } else if (!tab.branch && primary && !tab.launchBranch) branch = primary.branch
    if (branch === null) g.loose.push(tab)
    else {
      const list = g.byBranch.get(branch) ?? []
      list.push(tab)
      g.byBranch.set(branch, list)
    }
  }
  return { byRow, unplaced }
}

/** Running (or starting) sessions — the count badge on a collapsed project. */
export function liveCount(tabs: readonly TermTab[] | undefined): number {
  return (tabs ?? []).filter(isLive).length
}
