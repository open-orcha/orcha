/** Pure model for the host sidebar's project list (arch §7.1 / §8, desktop variant).
 *
 *  One row per PROJECT (container) across every local stack; a running stack whose container
 *  list could not be fetched yet, and a stopped stack, each render as one stack-level row
 *  (honest state — never a fake/zero project).
 *
 *  Attention per row ("Needs you" number) — what each value means:
 *  - number: decisions waiting (plans at plan-autonomy, verifications unless autonomy is
 *    full, requests open to a human or escalated), counted by the host poll every 15 s; for
 *    the project currently open in a V2 portal, the portal's own live count for the acting
 *    human (which excludes items assigned to someone else) replaces it;
 *  - null: unknown/unavailable (stopped, not fetched yet, or the fetch failed) — never 0. */
import type { AttentionItem, AttentionSnapshot, HostCheckout, HostLiveAgent, ProjectContainer, Stack } from '../../../shared/types'
import { isDecisionItem } from '../../../shared/types'
import type { ProjectCardData } from '../home/loadProjectCards'

export type RowState = 'running' | 'stopped' | 'starting'

export interface ProjectRow {
  /** Stable key: `<project>:<cid>` for a container row, `<project>` for a stack row. */
  key: string
  stack: Stack
  container: ProjectContainer | null
  name: string
  state: RowState
  /** Decisions waiting; null = unknown/unavailable. */
  attention: number | null
  /** True when the count may be low (snapshot capped) — render `N+`. */
  partial: boolean
  /** Where the number came from, for the tooltip. */
  attentionSource: 'host' | 'portal' | 'none'
  /** Why attention is null, for the tooltip/label. */
  unavailableReason: string | null
  pinned: boolean
  /** The container's own lifecycle word when it is NOT plainly active ("paused",
   *  "archived"…), so every surface shows the same state; null when active/unknown. */
  containerStatus: string | null
  /** D11: agents live in this project right now (working / needs review / blocked), from the
   *  host poll. null = unknown (stopped, not fetched yet, or unreachable) — render nothing. */
  live: HostLiveAgent[] | null
  /** Total live agents (≥ live.length) for "+N more". */
  liveTotal: number
  /** D14: the project's real git checkouts (primary first) from the host poll; null = no
   *  branch data (then agents nest directly under the project). */
  checkouts: HostCheckout[] | null
}

const QUIET_STATUSES = new Set(['active', 'running', 'live'])

/** A container's non-default lifecycle word (null = active / not reported). */
export function containerStatusWord(status: string | null | undefined): string | null {
  if (!status) return null
  const s = status.trim().toLowerCase()
  return s && !QUIET_STATUSES.has(s) ? s : null
}

export interface PortalAttention {
  cid: string | null
  count: number | null
  partial: boolean
}

export interface ActiveContext {
  project: string | null
  /** cid of the open project (from the portal's reported route), null when single/unknown. */
  cid: string | null
  /** Live attention the V2 portal reported for the open project, if any. */
  portalAttention: PortalAttention | null
}

export function rowKey(project: string, cid: string | null): string {
  return cid ? `${project}:${cid}` : project
}

function hostAttention(
  stack: Stack,
  cid: string | null,
  status: AttentionSnapshot | null
): Pick<ProjectRow, 'attention' | 'partial' | 'attentionSource' | 'unavailableReason'> {
  const none = { attention: null, partial: false, attentionSource: 'none' as const }
  if (!stack.running) return { ...none, unavailableReason: 'stopped' }
  const p = status?.projects.find((x) => x.project === stack.project)
  if (!p) return { ...none, unavailableReason: 'not checked yet' }
  if (!p.ok) return { ...none, unavailableReason: 'unavailable — last check failed' }
  if (cid === null) {
    // Stack-level row (container list not loaded): only meaningful as the stack total.
    const total = p.containers.reduce((n, c) => n + c.count, 0)
    return p.containers.length
      ? { attention: total, partial: p.containers.some((c) => c.partial), attentionSource: 'host', unavailableReason: null }
      : { ...none, unavailableReason: 'not checked yet' }
  }
  if (p.unavailable.includes(cid)) return { ...none, unavailableReason: 'unavailable — last check failed' }
  const c = p.containers.find((x) => x.cid === cid)
  if (!c) return { ...none, unavailableReason: 'not checked yet' }
  return { attention: c.count, partial: c.partial, attentionSource: 'host', unavailableReason: null }
}

/** A container's live agents from the host poll, or null whenever the project's data is not
 *  known to be current (stopped, never fetched, last fetch failed) — never stale/fake agents. */
function hostLive(
  stack: Stack,
  cid: string,
  status: AttentionSnapshot | null
): Pick<ProjectRow, 'live' | 'liveTotal' | 'checkouts'> {
  const none = { live: null, liveTotal: 0, checkouts: null }
  if (!stack.running) return none
  const p = status?.projects.find((x) => x.project === stack.project)
  if (!p || !p.ok || p.unavailable.includes(cid)) return none
  const c = p.containers.find((x) => x.cid === cid)
  if (!c || !Array.isArray(c.live)) return none
  const checkouts = Array.isArray(c.checkouts) && c.checkouts.length > 0 ? c.checkouts : null
  return { live: c.live, liveTotal: Math.max(c.liveTotal ?? c.live.length, c.live.length), checkouts }
}

/** Build ordered sidebar rows. Order: pinned first, then the local order list, then
 *  discovery order (stable). */
export function buildProjectRows(input: {
  stacks: Stack[]
  cards: ProjectCardData[]
  attention: AttentionSnapshot | null
  pinned: Set<string>
  order: string[]
  active: ActiveContext
}): ProjectRow[] {
  const { stacks, cards, attention, pinned, order, active } = input
  const rows: ProjectRow[] = []
  for (const stack of stacks) {
    const stackCards = cards.filter((c) => c.stack.project === stack.project)
    if (stack.running && stackCards.length > 0) {
      stackCards.forEach((card, index) => {
        const cid = card.container.id
        let att = hostAttention(stack, cid, attention)
        const isActive =
          active.project === stack.project && (active.cid === cid || (active.cid === null && index === 0))
        const pa = active.portalAttention
        if (isActive && pa && (pa.cid === cid || pa.cid === null) && pa.count !== null) {
          att = { attention: pa.count, partial: pa.partial, attentionSource: 'portal', unavailableReason: null }
        }
        rows.push({
          key: rowKey(stack.project, cid),
          stack,
          container: card.container,
          name: card.container.name,
          state: 'running',
          ...att,
          pinned: pinned.has(cid),
          containerStatus: containerStatusWord(card.container.status),
          ...hostLive(stack, cid, attention)
        })
      })
    } else {
      rows.push({
        key: rowKey(stack.project, null),
        stack,
        container: null,
        name: stack.projectShort,
        state: stack.running ? 'starting' : 'stopped',
        ...hostAttention(stack, null, attention),
        pinned: false,
        containerStatus: null,
        live: null,
        liveTotal: 0,
        checkouts: null
      })
    }
  }
  const rank = (r: ProjectRow): number => {
    const i = order.indexOf(r.key)
    return i < 0 ? Number.MAX_SAFE_INTEGER : i
  }
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => Number(b.r.pinned) - Number(a.r.pinned) || rank(a.r) - rank(b.r) || a.i - b.i)
    .map(({ r }) => r)
}

/** Status band a row belongs to — the ONE rule the Projects manager (filter pills, bands,
 *  health chip) and the tray share, so "Starting" / "Paused" read the same everywhere. A
 *  paused or still-starting project is never counted as "Running" (desktop r1 review). */
export type ProjectBand = 'running' | 'starting' | 'paused' | 'stopped'

export function bandOf(row: Pick<ProjectRow, 'state' | 'containerStatus'>): ProjectBand {
  if (row.state === 'stopped') return 'stopped'
  if (row.state === 'starting') return 'starting'
  if (row.containerStatus) return 'paused'
  return 'running'
}

/** One band for a whole compose stack (the tray lists stacks): running if any of its projects
 *  runs, else starting, else paused, else stopped. `word` is the visible label — a paused
 *  band uses the containers' own word ("paused", "archived") when they agree. */
export function stackBand(rows: Array<Pick<ProjectRow, 'state' | 'containerStatus'>>): { band: ProjectBand; word: string } {
  const bands = rows.map(bandOf)
  for (const b of ['running', 'starting'] as const) {
    if (bands.includes(b)) return { band: b, word: b === 'starting' ? 'starting…' : 'running' }
  }
  if (bands.includes('paused')) {
    const words = new Set(rows.filter((r) => bandOf(r) === 'paused').map((r) => r.containerStatus))
    const only = words.size === 1 ? [...words][0] : null
    return { band: 'paused', word: only ?? 'inactive' }
  }
  return { band: 'stopped', word: 'stopped' }
}

/** Top "Needs you" total across local projects: the sum of KNOWN row counts. `partial`
 *  means a count was CAPPED (render `N+`); projects whose count is unknown/unavailable are
 *  reported separately in `unknown` (said in words in the tooltip — never an unexplained
 *  `+`, desktop r1 review). */
export function totalAttention(rows: ProjectRow[]): { count: number | null; partial: boolean; unknown: number } {
  let count = 0
  let known = 0
  let unknown = 0
  let partial = false
  for (const r of rows) {
    if (r.state === 'stopped') continue
    if (r.attention === null) {
      unknown += 1
      continue
    }
    known += 1
    count += r.attention
    partial ||= r.partial
  }
  return { count: known === 0 ? null : count, partial, unknown }
}

/** The oldest-listed decision item to open when "Needs you" is clicked with no V2 project
 *  open (works with any portal version: it's a plain /tasks or /requests deep link). */
export function firstDecision(items: AttentionItem[]): AttentionItem | null {
  return items.find(isDecisionItem) ?? null
}

/** The portal's project sections. The host sidebar does NOT render these (design directive
 *  D1: projects are single rows; sections live in the portal's own tab bar) — they are kept
 *  only to map a reported route to "Needs you" / "Settings" highlighting. */
export const SECTIONS = [
  { key: 'overview', label: 'Overview', path: '/' },
  { key: 'tasks', label: 'Tasks', path: '/tasks' },
  { key: 'agents', label: 'Agents', path: '/agents' },
  { key: 'requests', label: 'Requests', path: '/requests' },
  { key: 'code', label: 'Code', path: '/code' },
  { key: 'github', label: 'GitHub', path: '/github' },
  { key: 'activity', label: 'Activity', path: '/activity' },
  { key: 'metrics', label: 'Metrics', path: '/metrics' }
] as const

export type SectionKey = (typeof SECTIONS)[number]['key'] | 'needs' | 'settings'

/** Which section a portal pathname belongs to (for highlighting). */
export function sectionForPath(pathname: string | null | undefined): SectionKey | null {
  if (!pathname) return null
  if (pathname === '/') return 'overview'
  if (pathname.startsWith('/needs')) return 'needs'
  if (pathname.startsWith('/settings') || pathname.startsWith('/members')) return 'settings'
  const hit = SECTIONS.find((s) => s.path !== '/' && (pathname === s.path || pathname.startsWith(`${s.path}/`)))
  return hit ? hit.key : null
}

/** "updated 5m ago" only when stale (> 2 min), from an ISO timestamp. */
export function staleLabel(iso: string | null, now: number): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const mins = Math.floor((now - t) / 60_000)
  if (mins < 2) return null
  if (mins < 60) return `updated ${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `updated ${hours}h ago`
  return `updated ${Math.floor(hours / 24)}d ago`
}
