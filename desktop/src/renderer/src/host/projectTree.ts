/** D14: the Orca-like tree under one sidebar project, built ONLY from real data on the row:
 *
 *    project
 *    ├─ branch/checkout (primary first)      ← only when the host read real git checkouts
 *    │   └─ live agents working on it
 *    └─ live agents with no known branch     ← directly under the project
 *    "+N more"                               ← D11 cap (3 agents per project in total)
 *
 *  D11 rules still apply: live/relevant agents only (the poller never sends idle ones), the
 *  first LIVE_SHOWN_MAX in the poller's priority order, and "+N more" for the rest. A
 *  non-primary checkout is shown only when one of the SHOWN agents is on it (a worktree
 *  with nobody visible on it would be an empty, unexplained row). */
import type { HostCheckout, HostLiveAgent } from '../../../shared/types'
import type { ProjectRow } from './projectModel'
import type { RowSessions } from '../terminal/sessions'
import type { TermTab } from '../terminal/termTabs'

/** Nested live agents shown per project before "+N more" (D11). */
export const LIVE_SHOWN_MAX = 3

export interface CheckoutNode {
  checkout: HostCheckout
  agents: HostLiveAgent[]
  /** Terminal sessions whose checkout is this branch (terminal/sessions.ts). */
  sessions: TermTab[]
}

export interface ProjectTree {
  checkouts: CheckoutNode[]
  /** Shown agents whose branch is unknown — rendered directly under the project. */
  loose: HostLiveAgent[]
  /** Terminal sessions with no branch data — directly under the project. */
  looseSessions: TermTab[]
  /** Live agents beyond the cap. */
  more: number
  /** Whether the project row has anything to expand (drives the caret). */
  hasChildren: boolean
}

export function buildProjectTree(
  row: Pick<ProjectRow, 'live' | 'liveTotal' | 'checkouts'>,
  sessions?: RowSessions | null
): ProjectTree {
  const live = row.live ?? []
  const shown = live.slice(0, LIVE_SHOWN_MAX)
  const more = Math.max(0, Math.max(row.liveTotal, live.length) - shown.length)
  const checkouts: CheckoutNode[] = []
  const placed = new Set<HostLiveAgent>()
  for (const checkout of [...(row.checkouts ?? []), ...(sessions?.extraCheckouts ?? [])]) {
    const agents = shown.filter((a) => a.branch != null && a.branch === checkout.branch)
    agents.forEach((a) => placed.add(a))
    const onIt = sessions?.byBranch.get(checkout.branch) ?? []
    if (checkout.primary || agents.length > 0 || onIt.length > 0) checkouts.push({ checkout, agents, sessions: onIt })
  }
  // Primary first, whatever order the poller sent.
  checkouts.sort((a, b) => Number(b.checkout.primary) - Number(a.checkout.primary))
  const loose = shown.filter((a) => !placed.has(a))
  const looseSessions = sessions?.loose ?? []
  return {
    checkouts,
    loose,
    looseSessions,
    more,
    hasChildren: checkouts.length > 0 || shown.length > 0 || looseSessions.length > 0
  }
}

/** Compact relative time for the right-aligned column ("now", "5m", "3h", "2d"). */
export function shortAgo(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const m = Math.max(0, Math.floor((now - t) / 60_000))
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  if (m < 1440) return `${Math.floor(m / 60)}h`
  return `${Math.floor(m / 1440)}d`
}
