/** Terminal tabs (desktop host only): the typed contract between the manager renderer and the
 *  PTY host in main. Pure — no Electron / Node imports — so both sides and the tests share it.
 *
 *  Security model (see main/ptyHost.ts + main/index.ts):
 *  - The renderer never names an executable, argv or a path. It asks for one of THREE launch
 *    kinds and, optionally, a compose project name; main resolves the folder from its own
 *    discovery snapshot (a known project folder, else $HOME) and builds the argv itself.
 *  - Every payload is re-validated here in main (`parse*` below) — unknown keys, kinds,
 *    oversize writes and out-of-range sizes are rejected, not coerced.
 *  - Only the manager window's main frame may call these channels; the embedded portal's
 *    preload (preload/portal.ts) never exposes them and main rejects any other sender. */

import { AGENT_IDS, AGENT_REGISTRY, agentShortLabel, isAgentId, type AgentId } from './agents'

/** 'shell' or a registry agent id (shared/agents.ts) — the ONLY things a renderer may ask for. */
export type TermKind = 'shell' | AgentId
export const TERM_KINDS: readonly TermKind[] = ['shell', ...AGENT_IDS]

/** IPC channel names (renderer → main invoke/send; main → renderer events). */
export const TERM_CHANNELS = {
  create: 'orcha:term:create',
  write: 'orcha:term:write',
  resize: 'orcha:term:resize',
  kill: 'orcha:term:kill',
  list: 'orcha:term:list',
  focus: 'orcha:term:focus',
  data: 'orcha:term:data',
  exit: 'orcha:term:exit',
  /** Main → renderer: derived session facts (title / snippet / attention), ≤ 2 per second. */
  meta: 'orcha:term:meta',
  command: 'orcha:term:command',
  /** Renderer → main: the tab strip's cosmetic layout (order, titles, pins, colours,
   *  selection) by pty id — main pairs it with its own facts to persist the session set. */
  layout: 'orcha:term:layout',
  /** Renderer → main: reopen the tabs saved at the last quit (main/sessionRestore.ts). */
  restore: 'orcha:term:restore'
} as const

/** Human labels + the install hint shown when an agent CLI is missing (from the registry). */
export const AGENT_CLI = Object.fromEntries(
  AGENT_REGISTRY.map((a) => [a.id, { label: agentShortLabel(a.id), bin: a.bin, install: a.install }])
) as Record<AgentId, { label: string; bin: string; install: string }>

/** Exit code the agent launch script uses for "CLI not on PATH" (POSIX "command not found"). */
export const CLI_NOT_FOUND_EXIT = 127

export const TERM_COLS_MIN = 2
export const TERM_COLS_MAX = 1000
export const TERM_ROWS_MIN = 1
export const TERM_ROWS_MAX = 500
/** One write IPC carries at most this many UTF-16 units (a big paste arrives in chunks). */
export const TERM_WRITE_MAX = 64 * 1024

export interface TermCreateRequest {
  kind: TermKind
  /** Compose project whose folder becomes the cwd; null = the user's home folder. */
  project: string | null
  /** Optional branch whose git checkout (a worktree of the project's repo) becomes the cwd.
   *  A NAME only — main resolves the folder from `git worktree list` of the project folder
   *  and refuses a branch it cannot find (never a renderer-supplied path). */
  branch?: string | null
  /** "Test launch" from Agents settings: run `<bin> --version` instead of the agent. Agent
   *  kinds only; main composes the argv itself (the renderer never sends flags). */
  probe?: boolean
  cols: number
  rows: number
}

/** What a session is doing, for the sidebar glyph (main/termMeta.ts + main/agentStatus.ts):
 *  working = spinner, done = ✓ (an agent finished its turn — hook-reported only, so plain
 *  shells never show it), attention = waiting for the user, error = the turn failed,
 *  idle = alive and quiet. */
export type TermStatus = 'working' | 'done' | 'attention' | 'error' | 'idle'
export const TERM_STATUSES: readonly TermStatus[] = ['working', 'done', 'attention', 'error', 'idle']

/** Facts the PTY host derives from a session's output stream (main/termMeta.ts). */
export interface TermMeta {
  /** Last OSC 0/2 window title the program set (e.g. Claude Code's task summary), cleaned. */
  title: string | null
  /** Last meaningful output line (ANSI stripped; prompts, spinners, box art skipped). */
  snippet: string | null
  /** The program rang the bell / posted an OSC 9 / 777 notification and the user hasn't
   *  typed since — it is waiting for them. */
  attention: boolean
  /** Actually working right now (title spinner, or output streaming) — not merely alive. */
  busy: boolean
  /** Epoch ms of the last meaningful change (new line / title / working). */
  lastActivity: number
  /** Session state: agent-hook-reported when the agent reports its lifecycle, else derived
   *  from `busy` / `attention`. Consistent with them (busy ⇔ working, attention ⇔ attention). */
  status: TermStatus
  /** Epoch ms the hook-reported `status` began (the ✓'s "2m ago"); null = heuristic status. */
  statusAt: number | null
}

/** Longest title / snippet main sends (the sidebar truncates further with a tooltip). */
export const TERM_META_TEXT_MAX = 200

export interface TermInfo {
  id: number
  kind: TermKind
  project: string | null
  /** Resolved working directory (for display; never sent back to main). */
  cwd: string
  /** Shell basename, e.g. "zsh". */
  shell: string
  /** Set when the cwd fell back to $HOME (no project selected, or its folder is missing). */
  note: string | null
  /** Git branch of the checkout the session started in (null = unknown / not a repo). */
  branch?: string | null
  /** A "Test launch" (`<bin> --version`) session. */
  probe?: boolean
  /** Recent output (bounded) so a reloaded renderer can re-attach; only from `list`. */
  backlog?: string
  exit?: TermExit | null
  /** Latest derived facts; only from `list`. */
  meta?: TermMeta | null
}

export interface TermExit {
  exitCode: number
  signal: number | null
}

export type TermEvent =
  | { type: 'data'; id: number; data: string }
  | ({ type: 'exit'; id: number } & TermExit)
  | ({ type: 'meta'; id: number } & TermMeta)

/** Main → renderer menu commands (app menu accelerators work whichever view has focus). */
/** `show-portal`: main just (re)showed a portal view (tray / notification / deep link) — the
 *  host leaves any full-screen terminal and shows the portal again. */
/** `new-default-agent`: ⌥⌘T — the Default agent from Agents settings. `open-settings`: ⌘,. */
export type TermCommand =
  | 'new-shell'
  | 'new-default-agent'
  | 'close-tab'
  | 'toggle-panel'
  | 'command-menu'
  | 'show-portal'
  | 'open-settings'
export const TERM_COMMANDS: readonly TermCommand[] = [
  'new-shell',
  'new-default-agent',
  'open-settings',
  'close-tab',
  'toggle-panel',
  'command-menu',
  'show-portal'
]

/** Compose project names are `orcha-<slug>` (discovery only lists those). */
export const PROJECT_RE = /^orcha-[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/

/** Tab colours (renderer/terminal/tabColors.ts renders them). Shared so main can validate a
 *  persisted colour without importing renderer code. */
export const TAB_COLORS = ['blue', 'purple', 'pink', 'red', 'orange', 'yellow', 'green', 'teal', 'grey'] as const
export type TabColor = (typeof TAB_COLORS)[number]
export function isTabColor(v: unknown): v is TabColor {
  return typeof v === 'string' && (TAB_COLORS as readonly string[]).includes(v)
}

/** A sidebar row key: `<project>` or `<project>:<container>` (renderer host/projectModel). */
const ROW_KEY_RE = /^orcha-[A-Za-z0-9][A-Za-z0-9_.-]{0,120}(?::[A-Za-z0-9][A-Za-z0-9_.-]{0,127})?$/
export function isRowKey(v: unknown): v is string {
  return typeof v === 'string' && ROW_KEY_RE.test(v)
}
export const TAB_TITLE_MAX = 60
/** Most tabs a layout report may describe (a strip far beyond anything usable). */
export const LAYOUT_TABS_MAX = 64

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function hasOnlyKeys(v: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(v).every((k) => keys.includes(k))
}

function intIn(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
}

export function isTermKind(v: unknown): v is TermKind {
  return v === 'shell' || isAgentId(v)
}

/** A pty id minted by main (positive safe integer). */
export function parseTermId(v: unknown): number | null {
  return intIn(v, 1, Number.MAX_SAFE_INTEGER) ? v : null
}

/** A git branch NAME (git check-ref-format subset): no path tricks, no option-looking names. */
export function isBranchName(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= 200 &&
    /^[A-Za-z0-9._\/-]+$/.test(v) &&
    !v.startsWith('-') &&
    !v.startsWith('/') &&
    !v.endsWith('/') &&
    !v.endsWith('.lock') &&
    !v.includes('..') &&
    !v.includes('//') &&
    !v.split('/').some((part) => part.startsWith('.'))
  )
}

export function parseCreateRequest(raw: unknown): TermCreateRequest | null {
  if (!isRecord(raw) || !hasOnlyKeys(raw, ['kind', 'project', 'branch', 'probe', 'cols', 'rows'])) return null
  if (!isTermKind(raw.kind)) return null
  const probe = raw.probe ?? false
  if (typeof probe !== 'boolean' || (probe && raw.kind === 'shell')) return null
  const project = raw.project ?? null
  if (project !== null && (typeof project !== 'string' || !PROJECT_RE.test(project))) return null
  const branch = raw.branch ?? null
  // A branch only makes sense inside a project's repo.
  if (branch !== null && (project === null || !isBranchName(branch))) return null
  if (!intIn(raw.cols, TERM_COLS_MIN, TERM_COLS_MAX) || !intIn(raw.rows, TERM_ROWS_MIN, TERM_ROWS_MAX)) return null
  return {
    kind: raw.kind,
    project,
    ...(branch !== null ? { branch } : {}),
    ...(probe ? { probe: true } : {}),
    cols: raw.cols,
    rows: raw.rows
  }
}

/** Renderer-side check of a meta event from main (defence in depth: drop malformed ones). */
export function parseMetaEvent(raw: unknown): ({ type: 'meta'; id: number } & TermMeta) | null {
  if (!isRecord(raw) || raw.type !== 'meta' || parseTermId(raw.id) === null) return null
  const text = (v: unknown): v is string | null => v === null || (typeof v === 'string' && v.length <= TERM_META_TEXT_MAX)
  if (!text(raw.title) || !text(raw.snippet) || typeof raw.attention !== 'boolean') return null
  if (typeof raw.lastActivity !== 'number' || !Number.isFinite(raw.lastActivity)) return null
  const busy = raw.busy === true
  const status: TermStatus = (TERM_STATUSES as readonly unknown[]).includes(raw.status)
    ? (raw.status as TermStatus)
    : raw.attention
      ? 'attention'
      : busy
        ? 'working'
        : 'idle'
  const statusAt = typeof raw.statusAt === 'number' && Number.isFinite(raw.statusAt) ? raw.statusAt : null
  return {
    type: 'meta',
    id: raw.id as number,
    title: raw.title,
    snippet: raw.snippet,
    attention: raw.attention,
    busy,
    lastActivity: raw.lastActivity,
    status,
    statusAt
  }
}

export function parseWrite(raw: unknown): { id: number; data: string } | null {
  if (!isRecord(raw) || !hasOnlyKeys(raw, ['id', 'data'])) return null
  const id = parseTermId(raw.id)
  if (id === null || typeof raw.data !== 'string' || raw.data.length === 0 || raw.data.length > TERM_WRITE_MAX) return null
  return { id, data: raw.data }
}

export function parseResize(raw: unknown): { id: number; cols: number; rows: number } | null {
  if (!isRecord(raw) || !hasOnlyKeys(raw, ['id', 'cols', 'rows'])) return null
  const id = parseTermId(raw.id)
  if (id === null) return null
  if (!intIn(raw.cols, TERM_COLS_MIN, TERM_COLS_MAX) || !intIn(raw.rows, TERM_ROWS_MIN, TERM_ROWS_MAX)) return null
  return { id, cols: raw.cols, rows: raw.rows }
}

/** Split a large string into write-sized chunks (the renderer's paste path). */
export function chunkWrite(data: string, max = TERM_WRITE_MAX): string[] {
  if (data.length <= max) return data ? [data] : []
  const out: string[] = []
  for (let i = 0; i < data.length; i += max) out.push(data.slice(i, i + max))
  return out
}

/** The bridge the manager preload exposes as `window.orchaDesktop.term`. */
export interface TermApi {
  create(req: TermCreateRequest): Promise<TermInfo>
  write(id: number, data: string): void
  resize(id: number, cols: number, rows: number): void
  kill(id: number): Promise<void>
  list(): Promise<TermInfo[]>
  /** Tell main whether keyboard focus is inside the terminal dock (routes ⌘W). */
  setFocus(focused: boolean): void
  onEvent(cb: (e: TermEvent) => void): () => void
  onCommand(cb: (c: TermCommand) => void): () => void
  /** Report the strip's layout (debounced by main; optional on older preloads). */
  saveLayout?(layout: TermLayout): void
  /** Reopen the saved tab set (see TermRestoreRequest). */
  restore?(req?: TermRestoreRequest): Promise<TermRestoreResult>
}

// ---------------------------------------------------------------------------------------
// Session restore (main/sessionRestore.ts). The renderer reports only COSMETIC facts keyed by
// the pty ids main minted; kinds, folders, branches and agent conversation ids never come
// from the renderer — main pairs the layout with its own session facts.

export interface TermLayoutTab {
  id: number
  title: string | null
  pinned: boolean
  color: TabColor | null
  /** Sidebar row the session sits under (null = the stack's first row). */
  rowKey: string | null
  /** Branch the user launched on (Restart reuses it); null = the project folder. */
  launchBranch: string | null
}

export interface TermLayout {
  /** Strip order (pinned first). */
  tabs: TermLayoutTab[]
  /** Selected tab's pty id. */
  active: number | null
}

function parseTitle(v: unknown): string | null | undefined {
  if (v === null) return null
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t ? t.slice(0, TAB_TITLE_MAX) : null
}

/** Strict parse of a renderer layout report (anything malformed → null, never coerced). */
export function parseLayout(raw: unknown): TermLayout | null {
  if (!isRecord(raw) || !hasOnlyKeys(raw, ['tabs', 'active'])) return null
  if (!Array.isArray(raw.tabs) || raw.tabs.length > LAYOUT_TABS_MAX) return null
  const active = raw.active ?? null
  if (active !== null && parseTermId(active) === null) return null
  const tabs: TermLayoutTab[] = []
  const seen = new Set<number>()
  for (const t of raw.tabs) {
    if (!isRecord(t) || !hasOnlyKeys(t, ['id', 'title', 'pinned', 'color', 'rowKey', 'launchBranch'])) return null
    const id = parseTermId(t.id)
    if (id === null || seen.has(id)) return null
    seen.add(id)
    const title = parseTitle(t.title ?? null)
    if (title === undefined || typeof (t.pinned ?? false) !== 'boolean') return null
    const color = t.color ?? null
    if (color !== null && !isTabColor(color)) return null
    const rowKey = t.rowKey ?? null
    if (rowKey !== null && !isRowKey(rowKey)) return null
    const launchBranch = t.launchBranch ?? null
    if (launchBranch !== null && !isBranchName(launchBranch)) return null
    tabs.push({ id, title, pinned: t.pinned === true, color: color as TabColor | null, rowKey, launchBranch })
  }
  return { tabs, active: active as number | null }
}

export interface TermRestoreRequest {
  /** ⌘K "Restore last session": restore even though the setting skipped it at launch. */
  manual?: boolean
  /** A stack's project came (back) into view: restore the tabs that waited for it. */
  project?: string
}

export function parseRestoreRequest(raw: unknown): TermRestoreRequest | null {
  const r = raw ?? {}
  if (!isRecord(r) || !hasOnlyKeys(r, ['manual', 'project'])) return null
  const manual = r.manual ?? false
  if (typeof manual !== 'boolean') return null
  const project = r.project ?? null
  if (project !== null && (typeof project !== 'string' || !PROJECT_RE.test(project))) return null
  if (manual && project !== null) return null
  return { ...(manual ? { manual: true } : {}), ...(project !== null ? { project } : {}) }
}

/** How a restored tab came back (the subtle note on the tab). */
export type RestoredHow = 'shell' | 'resumed' | 'continued' | 'fresh'

export interface RestoredTab {
  info: TermInfo
  title: string | null
  pinned: boolean
  color: TabColor | null
  rowKey: string | null
  launchBranch: string | null
  how: RestoredHow
  /** "Restored · new shell", "Restored · conversation resumed", … */
  note: string
}

export interface TermRestoreResult {
  tabs: RestoredTab[]
  /** Pty id of the tab that was selected at quit (null = none restored). */
  active: number | null
  /** Tabs NOT restored because "Restore terminal sessions on launch" is off — offered by the
   *  ⌘K "Restore last session" action for the rest of this run. */
  skipped: number
  /** Tabs beyond RESTORE_MAX_TABS that were left out. */
  capped: number
  /** Tabs waiting for their project to be discovered again. */
  deferred: number
  /** Tabs dropped as invalid (bad folder, unknown kind) or whose spawn failed. */
  dropped: number
}
