/** Orcha V2 desktop embedded-mode contract (docs/orcha-v2-architecture.md §7).
 *
 *  Single source of truth for the typed messages exchanged between the desktop host
 *  (Electron main + manager renderer) and an embedded portal WebContentsView. The portal
 *  mirrors these types in `frontend/src/state/host.ts` (Agent B).
 *
 *  PURE module: no Electron / Node imports. It is bundled into the dedicated portal preload
 *  (src/preload/portal.ts — sandboxed, so it must stay self-contained), into main (which
 *  re-validates everything the preload sends), and into the renderer (types only). */

export const EMBED_VERSION = 1 as const

/** Fixed IPC channels. The portal preload only ever touches these two — no generic invoke. */
export const EMBED_TO_HOST_CHANNEL = 'orcha:embed:toHost'
export const EMBED_TO_PORTAL_CHANNEL = 'orcha:embed:toPortal'

/** additionalArguments keys main passes to each portal view's preload. */
export const EMBED_ORIGIN_ARG = '--orcha-embed-origin='
export const EMBED_PROJECT_ARG = '--orcha-embed-project='

/** `theme`: the host owns the colour theme. The desktop drives nativeTheme.themeSource from
 *  Settings › Appearance, so the portal ignores its own stored theme preference and follows
 *  `prefers-color-scheme` (which Electron keeps equal to the desktop's choice, live). */
export type HostCapability = 'sidebar' | 'notifications' | 'stackControl' | 'theme' | 'revealPath'
/** `revealPath`: the portal may ask the host to show an agent worktree in Finder (main only
 *  accepts a path directly inside that stack's own `<folder>/.orcha-worktrees/`). */
export const HOST_CAPABILITIES: readonly HostCapability[] = ['sidebar', 'notifications', 'stackControl', 'theme', 'revealPath']

/** How long main waits for a portal's `ready` before falling back to the legacy
 *  (pre-V2 portal) layout: slim TopBar above the view, no host sidebar. */
export const EMBED_READY_TIMEOUT_MS = 3000

/** Cap on live-agent rows accepted from the portal (sidebar shows ≤ 5). */
export const LIVE_AGENTS_MAX = 5

// ---- Messages -------------------------------------------------------------------------

/** host → portal. The preload delivers these to callbacks the portal registered via `on`. */
export type HostToPortal =
  | { type: 'navigate'; path: string }
  | { type: 'openSearch' }
  | { type: 'hostModal'; open: boolean }

export interface LiveAgent {
  alias: string
  status: string
  task: string | null
  updatedAt: string | null
}

export type HostAction = 'startStack' | 'stopStack' | 'openManager' | 'addProject'
export const HOST_ACTIONS: readonly HostAction[] = ['startStack', 'stopStack', 'openManager', 'addProject']

/** portal → host. */
export type PortalToHost =
  | { type: 'ready'; version: 1 }
  | { type: 'route'; path: string; search: string; title: string }
  | { type: 'attention'; cid: string | null; count: number | null; partial: boolean }
  | { type: 'liveAgents'; cid: string | null; agents: LiveAgent[] }
  | { type: 'requestHostAction'; action: HostAction }
  | { type: 'revealPath'; path: string }

/** What the portal preload exposes as `window.orchaHost` (only on the expected origin). */
export interface OrchaHostApi {
  version: 1
  capabilities: HostCapability[]
  /** Compose project of the stack this view belongs to, e.g. "orcha-foo". */
  project: string
  send(msg: PortalToHost): void
  on(cb: (msg: HostToPortal) => void): () => void
  /** Dictation: ask macOS for microphone access (resolves to the access state). */
  requestMicAccess?(): Promise<string>
}

/** Main → manager renderer: a validated portal message, tagged with the SENDER's stack
 *  (derived by main from the sending webContents — never from the message itself). */
export interface EmbedEvent {
  project: string
  msg: PortalToHost
}

/** Per-view embed state main reports alongside `orcha:portalActive`.
 *  - pending: loading, no `ready` yet → host lays out as V2 (sidebar) optimistically;
 *  - v2:      portal answered `ready` → host sidebar + view right of it;
 *  - legacy:  no `ready` within EMBED_READY_TIMEOUT_MS → old slim TopBar layout. */
export type EmbedMode = 'pending' | 'v2' | 'legacy'

// ---- Validation (shared by preload and main — main re-validates, never trusts preload) --

/** Single leading slash only — no protocol-relative `//` and no `/\` (URL parsers treat a
 *  backslash as a separator too). Same rule as deepLink.ts / orcha:portalShow. */
export const SAFE_PATH_RE = /^\/(?![/\\])/

const MAX_STR = 2048
const MAX_SHORT = 256

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown, max = MAX_STR): string | null {
  return typeof v === 'string' && v.length <= max ? v : null
}

function strOrNull(v: unknown, max = MAX_SHORT): string | null | undefined {
  if (v === null || v === undefined) return null
  return typeof v === 'string' && v.length <= max ? v : undefined
}

export function isSafePath(path: unknown): path is string {
  return typeof path === 'string' && path.length <= MAX_STR && SAFE_PATH_RE.test(path)
}

/** Validate + normalize an untrusted portal → host message. Unknown types, extra-large
 *  strings, unsafe paths and malformed shapes return null (dropped). Output objects are
 *  rebuilt field-by-field so no unexpected property ever crosses the boundary. */
export function parsePortalMessage(raw: unknown): PortalToHost | null {
  if (!isObj(raw) || typeof raw.type !== 'string') return null
  switch (raw.type) {
    case 'ready':
      return raw.version === EMBED_VERSION ? { type: 'ready', version: 1 } : null
    case 'route': {
      const path = str(raw.path)
      const search = str(raw.search ?? '')
      const title = str(raw.title ?? '', MAX_SHORT)
      if (path === null || !SAFE_PATH_RE.test(path) || search === null || title === null) return null
      if (search !== '' && !search.startsWith('?')) return null
      return { type: 'route', path, search, title }
    }
    case 'attention': {
      const cid = strOrNull(raw.cid)
      if (cid === undefined) return null
      const count = raw.count
      if (count !== null && !(typeof count === 'number' && Number.isInteger(count) && count >= 0)) return null
      return { type: 'attention', cid, count: count as number | null, partial: raw.partial === true }
    }
    case 'liveAgents': {
      const cid = strOrNull(raw.cid)
      if (cid === undefined || !Array.isArray(raw.agents)) return null
      const agents: LiveAgent[] = []
      for (const a of raw.agents.slice(0, LIVE_AGENTS_MAX)) {
        if (!isObj(a)) return null
        const alias = str(a.alias, MAX_SHORT)
        const status = str(a.status, MAX_SHORT)
        const task = strOrNull(a.task, MAX_STR)
        const updatedAt = strOrNull(a.updatedAt)
        if (alias === null || status === null || task === undefined || updatedAt === undefined) return null
        agents.push({ alias, status, task, updatedAt })
      }
      return { type: 'liveAgents', cid, agents }
    }
    case 'requestHostAction':
      return typeof raw.action === 'string' && (HOST_ACTIONS as readonly string[]).includes(raw.action)
        ? { type: 'requestHostAction', action: raw.action as HostAction }
        : null
    case 'revealPath': {
      const p = str(raw.path, 4096)
      return p && p.startsWith('/') && p.includes('/.orcha-worktrees/') && !p.split('/').includes('..')
        ? { type: 'revealPath', path: p }
        : null
    }
    default:
      return null
  }
}

/** Validate a host → portal message (main checks what the manager renderer asks it to
 *  forward; the preload checks again before handing it to page callbacks). */
export function parseHostMessage(raw: unknown): HostToPortal | null {
  if (!isObj(raw) || typeof raw.type !== 'string') return null
  switch (raw.type) {
    case 'navigate':
      return isSafePath(raw.path) ? { type: 'navigate', path: raw.path } : null
    case 'openSearch':
      return { type: 'openSearch' }
    case 'hostModal':
      return typeof raw.open === 'boolean' ? { type: 'hostModal', open: raw.open } : null
    default:
      return null
  }
}

// ---- URL helpers --------------------------------------------------------------------

/** Append `embed=desktop` to a portal path (query-aware, hash preserved). Main adds it
 *  ONLY on a view's first load, as a pre-paint hint (arch §7.2). */
export function withEmbedHint(path: string): string {
  const safe = isSafePath(path) ? path : '/'
  const hashAt = safe.indexOf('#')
  const beforeHash = hashAt >= 0 ? safe.slice(0, hashAt) : safe
  const hash = hashAt >= 0 ? safe.slice(hashAt) : ''
  if (/[?&]embed=/.test(beforeHash)) return safe
  const sep = beforeHash.includes('?') ? '&' : '?'
  return `${beforeHash}${sep}embed=desktop${hash}`
}

/** Add/replace `cid=<id>` on a portal path (query-aware, hash preserved). */
export function withCidParam(path: string, cid: string | null): string {
  if (!cid) return path
  const hashAt = path.indexOf('#')
  const beforeHash = hashAt >= 0 ? path.slice(0, hashAt) : path
  const hash = hashAt >= 0 ? path.slice(hashAt) : ''
  const qAt = beforeHash.indexOf('?')
  const pathname = qAt >= 0 ? beforeHash.slice(0, qAt) : beforeHash
  const params = new URLSearchParams(qAt >= 0 ? beforeHash.slice(qAt + 1) : '')
  params.set('cid', cid)
  return `${pathname}?${params.toString()}${hash}`
}

/** Read the `cid` query param from a `?a=b` search string. */
export function cidFromSearch(search: string): string | null {
  try {
    return new URLSearchParams(search).get('cid')
  } catch {
    return null
  }
}

/** May a tray / notification / deep-link "go here" for the project whose V2 view is
 *  already open be an SPA navigate (keeps drafts + scroll) instead of a full load? Only when
 *  the target path stays in the container the portal is showing. Project/container switches
 *  stay full loads (arch §4).
 *  - `reportedSearch`: the portal's last reported route search; null = no route reported
 *    yet → full load.
 *  - `resolvedCid`: the container the portal itself RESOLVED (attention / liveAgents). The
 *    route can drop `?cid=` after an in-portal link (QA 2), so when the target names a cid it
 *    is compared against this first, falling back to the route's cid.
 *  A target without a cid only SPA-navigates when the route has none either (single-container
 *  stack) — on a multi-container stack an unscoped path is a full load. */
export function canSpaNavigate(path: string, reportedSearch: string | null, resolvedCid: string | null = null): boolean {
  if (reportedSearch === null || !isSafePath(path)) return false
  const q = path.indexOf('?')
  const h = path.indexOf('#')
  const search = q < 0 ? '' : path.slice(q, h > q ? h : undefined)
  const targetCid = cidFromSearch(search)
  const routeCid = cidFromSearch(reportedSearch)
  if (targetCid === null) return routeCid === null && resolvedCid === null
  return targetCid === (resolvedCid ?? routeCid)
}

/** Build the additionalArguments main passes to a portal view's preload. */
export function portalPreloadArgs(origin: string, project: string): string[] {
  return [`${EMBED_ORIGIN_ARG}${origin}`, `${EMBED_PROJECT_ARG}${project}`]
}

/** Parse the preload's argv back into {origin, project}; null unless both are well-formed
 *  (`http://localhost:<port>` and an `orcha-*` compose project). */
export function readPortalPreloadArgs(argv: readonly string[]): { origin: string; project: string } | null {
  const origin = argv.find((a) => a.startsWith(EMBED_ORIGIN_ARG))?.slice(EMBED_ORIGIN_ARG.length)
  const project = argv.find((a) => a.startsWith(EMBED_PROJECT_ARG))?.slice(EMBED_PROJECT_ARG.length)
  if (!origin || !/^http:\/\/localhost:\d{1,5}$/.test(origin)) return null
  if (!project || !/^orcha-[A-Za-z0-9_-]+$/.test(project)) return null
  return { origin, project }
}
