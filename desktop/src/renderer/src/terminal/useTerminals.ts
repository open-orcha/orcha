import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { parseMetaEvent, type TermApi, type TermKind, type TermRestoreResult } from '../../../shared/terminal'
import { TermClient } from './termClient'
import {
  applyTabPrefs,
  EMPTY_TABS,
  layoutOf,
  newTab,
  parseTabPrefs,
  tabFromInfo,
  tabFromRestored,
  tabPrefsOf,
  tabsReducer,
  type TabPrefs,
  type TabsState,
  type TermTab
} from './termTabs'
import type { TabColor } from './tabColors'

/** Per-session title / pin / colour, keyed by pty id (host localStorage). Main owns the
 *  processes and re-lists them after a renderer reload; these prefs ride along. No pty
 *  outlives the app, so a fresh start (main lists nothing) clears them — a new session
 *  with a recycled pty id never inherits a stale name. */
export const TAB_PREFS_KEY = 'orcha:host:tabPrefs'

function readPrefs(): Record<string, TabPrefs> {
  try {
    return parseTabPrefs(JSON.parse(window.localStorage.getItem(TAB_PREFS_KEY) ?? '{}'))
  } catch {
    return {}
  }
}

function writePrefs(prefs: Record<string, TabPrefs>): void {
  try {
    if (Object.keys(prefs).length === 0) window.localStorage.removeItem(TAB_PREFS_KEY)
    else window.localStorage.setItem(TAB_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // storage unavailable — prefs just don't survive a reload
  }
}

/** How long a restored tab's "Restored · …" note stays up. */
export const RESTORED_NOTE_MS = 12_000

/** Initial pty size before the view measures itself (it resizes on first fit). */
const INITIAL_COLS = 100
const INITIAL_ROWS = 24

let seq = 0
function nextKey(): string {
  seq += 1
  return `t${Date.now().toString(36)}${seq}`
}

function errorText(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { code?: string; message?: string; reason?: string }
    if (e.code === 'UNKNOWN_STACK') return 'That project is no longer on this Mac.'
    if (e.code === 'UNKNOWN_BRANCH') return 'That branch’s checkout isn’t on this Mac any more.'
    if (e.message && e.code === 'TERMINAL_FAILED') return `Couldn’t start the terminal: ${e.message}`
    if (e.code) return `Couldn’t start the terminal (${e.reason ?? e.code}).`
  }
  return 'Couldn’t start the terminal.'
}

/** Where a new session belongs: the sidebar row it was launched from and, from a branch
 *  row, that branch (main starts it in the branch's checkout). */
export interface SessionPlace {
  rowKey?: string | null
  branch?: string | null
  /** Settings › Agents "Test launch": run `<bin> --version` (main composes it). */
  probe?: boolean
}

export interface Terminals {
  available: boolean
  state: TabsState
  client: TermClient
  api: TermApi | undefined
  open(kind: TermKind, project: string | null, projectLabel: string | null, place?: SessionPlace): string | null
  close(key: string): void
  activate(key: string): void
  activateIndex(index: number): void
  restart(key: string): void
  rename(key: string, title: string | null): void
  pin(key: string, pinned: boolean): void
  setColor(key: string, color: TabColor | null): void
  active: TermTab | null
  /** Tabs the "Restore terminal sessions on launch" setting skipped this run (⌘K offers
   *  "Restore last session" while > 0). */
  skipped: number
  /** Tabs waiting for their project to be discovered again. */
  deferred: number
  /** Human summary of the last restore ("20 of 24 tabs restored"), null = nothing to say. */
  restoreNote: string | null
  restoreLast(): void
  /** A stack's project is (back) in view: reopen its saved tabs, if any wait for it. */
  restoreProject(project: string): void
  /** Clear these tabs' "Restored · …" notes (SessionPanel fades one once it has been on
   *  screen for RESTORED_NOTE_MS — never while the terminal is hidden, DT-35). */
  dismissRestored(keys: string[]): void
}

/** "Restored 3 tabs · 2 more weren't (limit 20)" — only when something was left out. */
export function restoreSummary(r: TermRestoreResult): string | null {
  const parts: string[] = []
  if (r.capped > 0) parts.push(`${r.capped} more tab${r.capped === 1 ? '' : 's'} not reopened (limit 20)`)
  if (r.dropped > 0) parts.push(`${r.dropped} tab${r.dropped === 1 ? '' : 's'} couldn’t be restored`)
  return parts.length ? parts.join(' · ') : null
}

/** Terminal tabs for the host: tab state (termTabs reducer) + the pty bridge. Output to a
 *  tab that is not on screen (not the active tab, or the portal is showing — `isShowing`)
 *  lights its activity dot. `rowLabel` names a sidebar row by its key (null = not known yet):
 *  a tab that remembers its row (a restored one) is titled after THAT row, not whichever
 *  project happens to be open — and is relabelled once the row is discovered (DT-36). */
export function useTerminals(
  labelFor: (project: string | null) => string | null,
  isShowing: () => boolean,
  rowLabel: (rowKey: string) => string | null = () => null
): Terminals {
  const api = typeof window !== 'undefined' ? window.orchaDesktop?.term : undefined
  const [state, dispatch] = useReducer(tabsReducer, EMPTY_TABS)
  const stateRef = useRef(state)
  stateRef.current = state
  const showingRef = useRef(isShowing)
  showingRef.current = isShowing
  const labelRef = useRef(labelFor)
  labelRef.current = labelFor
  const rowLabelRef = useRef(rowLabel)
  rowLabelRef.current = rowLabel

  const client = useMemo(
    () =>
      new TermClient(api, (e) => {
        const tab = stateRef.current.tabs.find((t) => t.ptyId === e.id)
        if (!tab) return
        if (e.type === 'meta') {
          const meta = parseMetaEvent(e)
          if (meta) dispatch({ ...meta, type: 'meta', ptyId: meta.id })
        } else if (e.type === 'data') {
          const showing = showingRef.current() && stateRef.current.activeKey === tab.key
          if (!tab.activity && !showing) dispatch({ type: 'activity', ptyId: e.id })
        } else {
          dispatch({ type: 'exit', ptyId: e.id, exit: { exitCode: e.exitCode, signal: e.signal } })
        }
      }),
    [api]
  )

  useEffect(() => {
    client.start()
    return () => client.stop()
  }, [client])

  const [skipped, setSkipped] = useState(0)
  const [deferred, setDeferred] = useState(0)
  const [restoreNote, setRestoreNote] = useState<string | null>(null)
  /** Turn a restore result into tabs (appended after a launch restore). */
  const adopt = useCallback(
    (r: TermRestoreResult, mode: 'restore' | 'append') => {
      let activeKey: string | null = null
      const summary = restoreSummary(r)
      const tabs = r.tabs.map((t) => {
        const label = (t.rowKey ? rowLabelRef.current(t.rowKey) : null) ?? labelRef.current(t.info.project)
        const tab = tabFromRestored(nextKey(), t, label)
        if (t.info.id === r.active) {
          activeKey = tab.key
          // Anything left out is said once, on the tab the user lands on.
          if (summary) tab.restoredNote = `${tab.restoredNote} · ${summary}`
        }
        return tab
      })
      if (mode === 'restore') {
        if (tabs.length > 0) {
          stateRef.current = tabsReducer(stateRef.current, { type: 'restore', tabs, activeKey })
          dispatch({ type: 'restore', tabs, activeKey })
        }
      } else {
        stateRef.current = tabsReducer(stateRef.current, { type: 'append', tabs, activeKey })
        dispatch({ type: 'append', tabs, activeKey })
      }
      setDeferred(r.deferred)
      setRestoreNote(summary)
    },
    []
  )

  // Re-attach after a renderer reload: main still owns the ptys and their recent output. A
  // fresh app (main lists nothing) instead asks main to reopen the tabs saved at the last
  // quit. Prefs/layout are only written once this has settled, so the empty first render
  // can't wipe them.
  const [prefsReady, setPrefsReady] = useState(false)
  useEffect(() => {
    if (!api) return
    let alive = true
    void api
      .list()
      .then(async (infos) => {
        if (!alive) return
        if (stateRef.current.tabs.length > 0) return
        if (infos.length === 0) {
          if (!api.restore) return
          // A failed restore never blocks the app: it simply starts with no tabs.
          const r = await api.restore({}).catch(() => null)
          if (!alive || !r) return
          if (stateRef.current.tabs.length > 0) {
            // The user opened a tab meanwhile: keep it, add the restored ones after it.
            adopt(r, 'append')
          } else adopt(r, 'restore')
          setSkipped(r.skipped)
          return
        }
        const tabs = infos.map((info) => {
          client.seed(info.id, info.backlog ?? '')
          return tabFromInfo(nextKey(), info, labelRef.current(info.project))
        })
        dispatch({ type: 'restore', tabs: applyTabPrefs(tabs, readPrefs()) })
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setPrefsReady(true)
      })
    return () => {
      alive = false
    }
  }, [api, client, adopt])

  useEffect(() => {
    if (prefsReady) writePrefs(tabPrefsOf(state.tabs))
  }, [prefsReady, state.tabs])

  // Main persists the tab set (sessionRestore.ts): report the cosmetic layout on change.
  const layoutKey = useMemo(() => JSON.stringify(layoutOf(state)), [state])
  useEffect(() => {
    if (prefsReady) api?.saveLayout?.(JSON.parse(layoutKey))
  }, [api, prefsReady, layoutKey])

  // A restored tab whose sidebar row wasn't known yet (projects are discovered after the
  // restore) takes that row's name as soon as it is — "Codex · orcha-web", not the stack name.
  useEffect(() => {
    const labels: Record<string, string> = {}
    for (const t of state.tabs) {
      if (!t.rowKey) continue
      const name = rowLabel(t.rowKey)
      if (name && name !== t.projectLabel) labels[t.key] = name
    }
    if (Object.keys(labels).length === 0) return
    stateRef.current = tabsReducer(stateRef.current, { type: 'relabel', labels })
    dispatch({ type: 'relabel', labels })
  }, [rowLabel, state.tabs])

  const dismissRestored = useCallback((keys: string[]) => {
    stateRef.current = tabsReducer(stateRef.current, { type: 'dismissRestored', keys })
    dispatch({ type: 'dismissRestored', keys })
  }, [])

  const restoreLast = useCallback(() => {
    if (!api?.restore) return
    setSkipped(0)
    void api
      .restore({ manual: true })
      .then((r) => adopt(r, 'append'))
      .catch(() => {})
  }, [api, adopt])

  const restoreProject = useCallback(
    (project: string) => {
      if (!api?.restore) return
      void api
        .restore({ project })
        .then((r) => {
          if (r.tabs.length > 0 || r.deferred !== deferred) adopt({ ...r, active: null }, 'append')
        })
        .catch(() => {})
    },
    [api, adopt, deferred]
  )

  const spawn = useCallback(
    (key: string, kind: TermKind, project: string | null, branch: string | null, probe = false) => {
      if (!api) return
      void api
        .create({
          kind,
          project,
          ...(branch && project ? { branch } : {}),
          ...(probe && kind !== 'shell' ? { probe: true } : {}),
          cols: INITIAL_COLS,
          rows: INITIAL_ROWS
        })
        .then((info) => {
          // Closed while starting: don't leave the process behind.
          if (!stateRef.current.tabs.some((t) => t.key === key)) {
            void api.kill(info.id).catch(() => {})
            return
          }
          dispatch({ type: 'attached', key, info })
        })
        .catch((err: unknown) => dispatch({ type: 'failed', key, error: errorText(err) }))
    },
    [api]
  )

  const open = useCallback(
    (kind: TermKind, project: string | null, projectLabel: string | null, place: SessionPlace = {}): string | null => {
      if (!api) return null
      const key = nextKey()
      const tab = newTab(key, kind, project, projectLabel, place)
      // Keep the ref current synchronously so a fast create() reply finds the tab.
      stateRef.current = tabsReducer(stateRef.current, { type: 'open', tab })
      dispatch({ type: 'open', tab })
      spawn(key, kind, project, place.branch ?? null, place.probe === true)
      return key
    },
    [api, spawn]
  )

  const close = useCallback(
    (key: string) => {
      const tab = stateRef.current.tabs.find((t) => t.key === key)
      if (!tab) return
      if (tab.ptyId !== null) {
        void api?.kill(tab.ptyId).catch(() => {})
        client.forget(tab.ptyId)
      }
      stateRef.current = tabsReducer(stateRef.current, { type: 'close', key })
      dispatch({ type: 'close', key })
    },
    [api, client]
  )

  const restart = useCallback(
    (key: string) => {
      const tab = stateRef.current.tabs.find((t) => t.key === key)
      if (!tab) return
      if (tab.ptyId !== null) {
        void api?.kill(tab.ptyId).catch(() => {})
        client.forget(tab.ptyId)
      }
      dispatch({ type: 'restarting', key })
      spawn(key, tab.kind, tab.project, tab.launchBranch, tab.probe)
    },
    [api, client, spawn]
  )

  const activate = useCallback((key: string) => {
    stateRef.current = tabsReducer(stateRef.current, { type: 'activate', key })
    dispatch({ type: 'activate', key })
  }, [])
  const activateIndex = useCallback((index: number) => {
    stateRef.current = tabsReducer(stateRef.current, { type: 'activateIndex', index })
    dispatch({ type: 'activateIndex', index })
  }, [])
  const rename = useCallback((key: string, title: string | null) => dispatch({ type: 'rename', key, title }), [])
  const pin = useCallback((key: string, pinned: boolean) => {
    stateRef.current = tabsReducer(stateRef.current, { type: 'pin', key, pinned })
    dispatch({ type: 'pin', key, pinned })
  }, [])
  const setColor = useCallback((key: string, color: TabColor | null) => dispatch({ type: 'color', key, color }), [])

  const active = state.tabs.find((t) => t.key === state.activeKey) ?? null
  return {
    available: !!api,
    state,
    client,
    api,
    open,
    close,
    activate,
    activateIndex,
    restart,
    rename,
    pin,
    setColor,
    active,
    skipped,
    deferred,
    restoreNote,
    restoreLast,
    restoreProject,
    dismissRestored
  }
}
