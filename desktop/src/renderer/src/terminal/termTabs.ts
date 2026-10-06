/** Terminal tab state — a pure reducer (termTabs.test.ts). The renderer owns tab order,
 *  titles, activity and exit display; main owns the processes (ids only cross the bridge). */
import {
  AGENT_CLI,
  CLI_NOT_FOUND_EXIT,
  type RestoredTab,
  type TermExit,
  type TermInfo,
  type TermKind,
  type TermLayout,
  type TermMeta
} from '../../../shared/terminal'
import { isTabColor, type TabColor } from './tabColors'

export type TabStatus = 'starting' | 'running' | 'exited' | 'failed'

export interface TermTab {
  /** Stable renderer key (survives Restart, which swaps the pty). */
  key: string
  kind: TermKind
  /** Compose project the tab was opened for (null = home folder). */
  project: string | null
  /** Display name of that project (e.g. "todo-app"). */
  projectLabel: string | null
  ptyId: number | null
  status: TabStatus
  exit: TermExit | null
  /** Output arrived while this tab was not on screen. */
  activity: boolean
  /** User-chosen title (rename); null = automatic. */
  customTitle: string | null
  /** Pinned tabs sit at the front of the strip (in pin order), render compact and are
   *  skipped by Close Others / To The Right / To The Left. */
  pinned: boolean
  /** Tab colour (a dot in the strip and on the sidebar row); null = none. */
  color: TabColor | null
  /** Shell basename reported by main ("zsh"). */
  shell: string | null
  cwd: string | null
  /** cwd fell back to $HOME (main's explanation). */
  note: string | null
  /** Spawn failure / bridge error text. */
  error: string | null
  /** Branch asked for at launch (a branch row's "New Terminal"), then the branch main
   *  resolved the session's checkout to. null = unknown / not a repo. */
  branch: string | null
  /** The branch the user launched on (null = the project folder); Restart reuses it. */
  launchBranch: string | null
  /** Sidebar project row the session was opened from (`<project>:<cid>`), null = unknown
   *  (restored after a reload) — then the stack's first row. */
  rowKey: string | null
  /** Title / snippet / attention / last activity derived by main from the output. */
  meta: TermMeta | null
  /** A Settings › Agents "Test launch" (`<bin> --version`); Restart repeats it. */
  probe: boolean
  /** Reopened from the last quit ("Restored · new shell", "Restored · conversation
   *  resumed", …) — a subtle note that fades after a few seconds or on Restart. */
  restoredNote: string | null
}

export interface TabsState {
  tabs: TermTab[]
  activeKey: string | null
}

export const EMPTY_TABS: TabsState = { tabs: [], activeKey: null }

export type TabsAction =
  | { type: 'open'; tab: TermTab }
  | { type: 'attached'; key: string; info: TermInfo }
  | { type: 'failed'; key: string; error: string }
  | { type: 'close'; key: string }
  | { type: 'activate'; key: string }
  | { type: 'activateIndex'; index: number }
  | { type: 'activity'; ptyId: number }
  | { type: 'exit'; ptyId: number; exit: TermExit }
  | { type: 'restarting'; key: string }
  | { type: 'rename'; key: string; title: string | null }
  | { type: 'pin'; key: string; pinned: boolean }
  | { type: 'color'; key: string; color: TabColor | null }
  | { type: 'restore'; tabs: TermTab[]; activeKey?: string | null }
  | { type: 'append'; tabs: TermTab[]; activeKey?: string | null }
  | { type: 'dismissRestored'; keys: string[] }
  /** New default project labels by tab key (a restored tab's sidebar row got its name). */
  | { type: 'relabel'; labels: Record<string, string> }
  | ({ type: 'meta'; ptyId: number } & TermMeta)

export function newTab(
  key: string,
  kind: TermKind,
  project: string | null,
  projectLabel: string | null,
  place: { branch?: string | null; rowKey?: string | null; probe?: boolean } = {}
): TermTab {
  const probe = place.probe === true && kind !== 'shell'
  return {
    key,
    kind,
    project,
    projectLabel,
    ptyId: null,
    status: 'starting',
    exit: null,
    activity: false,
    customTitle: null,
    pinned: false,
    color: null,
    shell: null,
    cwd: null,
    note: null,
    error: null,
    branch: place.branch ?? null,
    launchBranch: place.branch ?? null,
    rowKey: place.rowKey ?? null,
    meta: null,
    probe,
    restoredNote: null
  }
}

/** A tab rebuilt from main's `list` after the renderer reloaded. */
export function tabFromInfo(key: string, info: TermInfo, projectLabel: string | null): TermTab {
  const exit = info.exit ?? null
  return {
    ...newTab(key, info.kind, info.project, projectLabel, { probe: info.probe === true }),
    ptyId: info.id,
    status: exit ? 'exited' : 'running',
    exit,
    shell: info.shell,
    cwd: info.cwd,
    note: info.note,
    branch: info.branch ?? null,
    meta: info.meta ?? null
  }
}

/** A tab main reopened from the saved session set (main/sessionRestore.ts). Status starts
 *  idle (a fresh process) — the prior state never carries over. */
export function tabFromRestored(key: string, r: RestoredTab, projectLabel: string | null): TermTab {
  return {
    ...tabFromInfo(key, r.info, projectLabel),
    customTitle: r.title,
    pinned: r.pinned,
    color: r.color,
    rowKey: r.rowKey,
    launchBranch: r.launchBranch,
    restoredNote: r.note
  }
}

/** The strip's cosmetic layout for main (pty ids only; tabs without a pty are left out). */
export function layoutOf(state: TabsState): TermLayout {
  const tabs = state.tabs
    .filter((t) => t.ptyId !== null && !t.probe)
    .map((t) => ({
      id: t.ptyId as number,
      title: t.customTitle,
      pinned: t.pinned,
      color: t.color,
      rowKey: t.rowKey,
      launchBranch: t.project ? t.launchBranch : null
    }))
  const active = state.tabs.find((t) => t.key === state.activeKey)?.ptyId ?? null
  return { tabs, active: active !== null && tabs.some((t) => t.id === active) ? active : null }
}

export function kindLabel(kind: TermKind, shell: string | null): string {
  if (kind === 'shell') return shell ?? 'Terminal'
  return AGENT_CLI[kind].label
}

export function tabTitle(tab: TermTab): string {
  if (tab.customTitle) return tab.customTitle
  const base = tab.probe ? `${kindLabel(tab.kind, tab.shell)} --version` : kindLabel(tab.kind, tab.shell)
  return tab.projectLabel ? `${base} · ${tab.projectLabel}` : base
}

/** "exited 0" / "exited 1" / "killed (signal 9)"; null while running. */
export function exitLabel(tab: TermTab): string | null {
  if (tab.status === 'failed') return 'failed to start'
  if (tab.status !== 'exited' || !tab.exit) return null
  if (tab.exit.signal) return `killed (signal ${tab.exit.signal})`
  return `exited ${tab.exit.exitCode}`
}

/** Agent tab whose launch script reported the CLI missing. */
export function cliMissing(tab: TermTab): boolean {
  return tab.kind !== 'shell' && tab.status === 'exited' && tab.exit?.exitCode === CLI_NOT_FOUND_EXIT && !tab.exit.signal
}

function patch(state: TabsState, pred: (t: TermTab) => boolean, fn: (t: TermTab) => TermTab): TabsState {
  let changed = false
  const tabs = state.tabs.map((t) => {
    if (!pred(t)) return t
    const next = fn(t)
    if (next !== t) changed = true
    return next
  })
  return changed ? { ...state, tabs } : state
}

export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case 'open':
      return { tabs: [...state.tabs, action.tab], activeKey: action.tab.key }
    case 'attached':
      return patch(
        state,
        (t) => t.key === action.key,
        (t) => ({
          ...t,
          ptyId: action.info.id,
          status: 'running',
          exit: null,
          error: null,
          shell: action.info.shell,
          cwd: action.info.cwd,
          note: action.info.note,
          branch: action.info.branch ?? t.branch
        })
      )
    case 'failed':
      return patch(
        state,
        (t) => t.key === action.key,
        (t) => ({ ...t, status: 'failed', error: action.error, ptyId: null })
      )
    case 'close': {
      const i = state.tabs.findIndex((t) => t.key === action.key)
      if (i < 0) return state
      const tabs = state.tabs.filter((t) => t.key !== action.key)
      let activeKey = state.activeKey
      if (activeKey === action.key) {
        // Like a browser: the tab to the right takes over, else the one to the left.
        activeKey = tabs.length === 0 ? null : tabs[Math.min(i, tabs.length - 1)].key
      }
      return {
        tabs: activeKey ? tabs.map((t) => (t.key === activeKey && t.activity ? { ...t, activity: false } : t)) : tabs,
        activeKey
      }
    }
    case 'activate': {
      if (!state.tabs.some((t) => t.key === action.key)) return state
      const next = patch(
        state,
        (t) => t.key === action.key && t.activity,
        (t) => ({ ...t, activity: false })
      )
      return next.activeKey === action.key ? next : { ...next, activeKey: action.key }
    }
    case 'activateIndex': {
      // ⌘9 = last tab (browser convention); ⌘1..8 = that position if it exists.
      const tab = action.index >= 8 ? state.tabs[state.tabs.length - 1] : state.tabs[action.index]
      return tab ? tabsReducer(state, { type: 'activate', key: tab.key }) : state
    }
    case 'activity':
      return patch(
        state,
        (t) => t.ptyId === action.ptyId && !t.activity,
        (t) => ({ ...t, activity: true })
      )
    case 'exit':
      return patch(
        state,
        (t) => t.ptyId === action.ptyId,
        (t) => ({ ...t, status: 'exited', exit: action.exit })
      )
    case 'restarting':
      return patch(
        state,
        (t) => t.key === action.key,
        (t) => ({ ...t, status: 'starting', exit: null, error: null, ptyId: null, activity: false, meta: null, restoredNote: null })
      )
    case 'rename': {
      const title = action.title?.trim() ? action.title.trim().slice(0, 60) : null
      return patch(
        state,
        (t) => t.key === action.key && t.customTitle !== title,
        (t) => ({ ...t, customTitle: title })
      )
    }
    case 'pin': {
      const i = state.tabs.findIndex((t) => t.key === action.key)
      if (i < 0 || state.tabs[i].pinned === action.pinned) return state
      const tab = { ...state.tabs[i], pinned: action.pinned }
      const rest = state.tabs.filter((_, j) => j !== i)
      // Pin → the end of the pinned group (pin order); unpin → the first unpinned slot.
      const at = rest.filter((t) => t.pinned).length
      return { ...state, tabs: [...rest.slice(0, at), tab, ...rest.slice(at)] }
    }
    case 'color': {
      const color = isTabColor(action.color) ? action.color : null
      return patch(
        state,
        (t) => t.key === action.key && t.color !== color,
        (t) => ({ ...t, color })
      )
    }
    case 'meta': {
      const { title, snippet, attention, busy, lastActivity, status, statusAt } = action
      return patch(
        state,
        (t) => t.ptyId === action.ptyId,
        (t) => ({ ...t, meta: { title, snippet, attention, busy, lastActivity, status, statusAt } })
      )
    }
    case 'restore': {
      const tabs = pinnedFirst(action.tabs)
      const wanted = action.activeKey && tabs.some((t) => t.key === action.activeKey) ? action.activeKey : null
      return { tabs, activeKey: wanted ?? (tabs.length ? tabs[tabs.length - 1].key : null) }
    }
    case 'append': {
      if (action.tabs.length === 0) return state
      const tabs = pinnedFirst([...state.tabs, ...action.tabs])
      const wanted = action.activeKey && tabs.some((t) => t.key === action.activeKey) ? action.activeKey : null
      return { tabs, activeKey: wanted ?? state.activeKey ?? tabs[tabs.length - 1].key }
    }
    case 'relabel':
      return patch(
        state,
        (t) => action.labels[t.key] !== undefined && t.projectLabel !== action.labels[t.key],
        (t) => ({ ...t, projectLabel: action.labels[t.key] })
      )
    case 'dismissRestored':
      return patch(
        state,
        (t) => t.restoredNote !== null && action.keys.includes(t.key),
        (t) => ({ ...t, restoredNote: null })
      )
    default:
      return state
  }
}

/** Stable partition: pinned tabs first (their relative order kept), then the rest. */
export function pinnedFirst(tabs: readonly TermTab[]): TermTab[] {
  return [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)]
}

export type CloseScope = 'others' | 'right' | 'left'

/** Keys a bulk close from `key`'s menu would close, in strip order. Pinned tabs are never
 *  targets (only an explicit Close closes a pinned tab). Unknown key → []. */
export function closeTargets(tabs: readonly TermTab[], key: string, scope: CloseScope): string[] {
  const i = tabs.findIndex((t) => t.key === key)
  if (i < 0) return []
  const pick = (t: TermTab, j: number): boolean =>
    !t.pinned && t.key !== key && (scope === 'others' || (scope === 'right' ? j > i : j < i))
  return tabs.filter(pick).map((t) => t.key)
}

/** A tab whose process is (or is about to be) alive — closing it ends that process. */
export function isLiveTab(tab: TermTab): boolean {
  return tab.status === 'running' || tab.status === 'starting'
}

/** What survives a renderer reload per session (keyed by pty id in the host's storage). */
export interface TabPrefs {
  title?: string
  /** Position within the pinned group (0 = first). */
  pin?: number
  color?: TabColor
}

/** Per-pty prefs worth keeping (tabs with nothing custom are left out). */
export function tabPrefsOf(tabs: readonly TermTab[]): Record<string, TabPrefs> {
  const out: Record<string, TabPrefs> = {}
  let pin = 0
  for (const t of tabs) {
    if (t.ptyId === null) continue
    const p: TabPrefs = {}
    if (t.customTitle) p.title = t.customTitle
    if (t.pinned) p.pin = pin++
    if (t.color) p.color = t.color
    if (Object.keys(p).length) out[String(t.ptyId)] = p
  }
  return out
}

/** Validate prefs read back from storage (anything malformed is dropped, not coerced). */
export function parseTabPrefs(raw: unknown): Record<string, TabPrefs> {
  const out: Record<string, TabPrefs> = {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[1-9][0-9]{0,15}$/.test(id) || typeof v !== 'object' || v === null) continue
    const r = v as Record<string, unknown>
    const p: TabPrefs = {}
    if (typeof r.title === 'string' && r.title.trim()) p.title = r.title.trim().slice(0, 60)
    if (typeof r.pin === 'number' && Number.isInteger(r.pin) && r.pin >= 0) p.pin = r.pin
    if (isTabColor(r.color)) p.color = r.color
    if (Object.keys(p).length) out[id] = p
  }
  return out
}

/** Re-apply stored prefs to tabs rebuilt from main's `list`: title, colour, and pinned tabs
 *  back at the front in their pin order. */
export function applyTabPrefs(tabs: readonly TermTab[], prefs: Record<string, TabPrefs>): TermTab[] {
  const withPrefs = tabs.map((t) => {
    const p = t.ptyId !== null ? prefs[String(t.ptyId)] : undefined
    if (!p) return t
    return { ...t, customTitle: p.title ?? t.customTitle, pinned: p.pin !== undefined, color: p.color ?? t.color }
  })
  const pinOf = (t: TermTab): number => prefs[String(t.ptyId)]?.pin ?? 0
  const pinned = withPrefs.filter((t) => t.pinned).sort((a, b) => pinOf(a) - pinOf(b))
  return [...pinned, ...withPrefs.filter((t) => !t.pinned)]
}
