import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { WizardVariant } from '../../shared/types'
import { cidFromSearch, withCidParam } from '../../shared/embed'
import ProjectsHome, { projectsInStack } from './home/ProjectsHome'
import OnboardingWizard from './onboarding/OnboardingWizard'
import TopBar from './components/TopBar'
import { OrchaMark } from './components/OrchaMark'
import { loadFavorites, toggleFavorite } from './home/favorites'
import HostSidebar, { HELP_URL } from './host/HostSidebar'
import type { StackActionError } from './util/errorText'
import ConfirmStopDialog from './host/ConfirmStopDialog'
import { useHostState } from './host/useHostState'
import {
  buildProjectRows,
  firstDecision,
  rowKey,
  sectionForPath,
  totalAttention,
  type ProjectRow
} from './host/projectModel'
import {
  loadCollapsed,
  loadOrder,
  loadExpanded,
  saveExpanded,
  loadWidth,
  moveKey,
  saveCollapsed,
  saveOrder,
  saveWidth,
  SIDEBAR_RAIL,
  clampWidth
} from './host/sidebarPrefs'
import {
  iconEditability,
  loadRecents,
  ProjectIconStore,
  pushRecent,
  type ProjectIcon
} from './host/projectIcons'

import { History, Search as SearchIcon, Settings as SettingsIcon, LayoutGrid, PanelTop, Plus as PlusIcon, Trash2 } from 'lucide-react'
import { useProjectRemoval } from './host/useProjectRemoval'
import SessionPanel, { STRIP_OUTER } from './terminal/SessionPanel'
import CommandMenu, { type CommandAction } from './terminal/CommandMenu'
import PortalSnapshot, { decodeSnapshot } from './terminal/PortalSnapshot'
import { KindIcon } from './terminal/KindIcon'
import { useTerminals, type SessionPlace } from './terminal/useTerminals'
import { useTabCloser } from './terminal/CloseTabsDialog'
import { groupSessions } from './terminal/sessions'
import { matchHostShortcut } from './terminal/commandModel'
import { exitLabel } from './terminal/termTabs'
import { stripTitle } from './terminal/SessionPanel'
import { ProjectIcon as ProjectIconGlyph } from './ui/ProjectIcon'
import { projectIconKey } from './host/projectIcons'
import type { TermKind } from '../../shared/terminal'
import { agentDef, agentShortLabel, type AgentId } from '../../shared/agents'
import { AgentsProvider, useAgents, useAgentsController, useLaunchers } from './agents/AgentsContext'
import SettingsView, { NOTIFICATION_SETTINGS_PATH } from './settings/SettingsView'
import DesktopDictation from './dictation/DesktopDictation'

/** Portal Settings › Voice (dictation engine, language, speech keys). */
const VOICE_SETTINGS_PATH = '/settings#tab=voice'
import { BarChart3 } from 'lucide-react'
import { useUsage } from './usage/useUsage'
import UsagePopover from './usage/UsagePopover'
import UsageIndicator, { usageRowVisible } from './usage/UsageIndicator'
import StatsView, { type StatsProject } from './usage/StatsView'
import type { UsageProviderId } from '../../shared/usage'

/** Portal section the command menu's "Agent settings…" opens (execution: autonomy, agent
 *  workspace — SettingsPage `settab="execution"`). */
export const AGENT_SETTINGS_PATH = '/settings#tab=execution'

/** How long the host waits for a portal still before opening the command menu anyway. */
const SNAPSHOT_TIMEOUT_MS = 400

/** How long a failed icon write's message stays up (it can also be dismissed). */
const ICON_ERROR_MS = 8000

type AppMode = 'loading' | 'manager' | 'onboarding'

type StackErrors = Record<string, StackActionError | null | undefined>

/** Split stack errors by the one surface that shows each (see App). Exported for tests. */
export function errorSurfaces(
  errors: StackErrors,
  ctx: { dialogProject: string | null; managerVisible: boolean }
): { table: StackErrors; sidebar: StackErrors; dialogFree: StackErrors } {
  const dialogFree: StackErrors = {}
  for (const [project, err] of Object.entries(errors)) {
    if (err && project !== ctx.dialogProject) dialogFree[project] = err
  }
  return ctx.managerVisible
    ? { table: dialogFree, sidebar: {}, dialogFree }
    : { table: {}, sidebar: dialogFree, dialogFree }
}

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

const noStore = { getItem: () => null, setItem: () => {} }

/** Fire-and-forget a bridge call: failures surface elsewhere (stack errors, main logs). */
function fire(p: Promise<unknown> | undefined): void {
  void Promise.resolve(p).catch(() => {})
}

/** If `docker ps` never settles (main also times it out at 8 s), stop waiting and show the
 *  manager — its Docker-down notice explains — instead of a blank window (audit BLOCKER). */
const FIRST_LOAD_FALLBACK_MS = 12_000

/** Single-window desktop host (Orcha V2, docs/orcha-v2-architecture.md §7).
 *
 *  - First-run onboarding (zero stacks) and the add-project wizard fill the window.
 *  - Otherwise the host renders a persistent LEFT sidebar (projects across every local
 *    stack, "Needs you", the open project's sections + live agents, stack start/stop) and
 *    main lays the open project's portal WebContentsView out to its right. The V2 portal
 *    detects the host (window.orchaHost) and renders header + content only.
 *  - An OLDER portal (no `ready` within 3 s) falls back to the pre-V2 layout: the slim TopBar
 *    above a full-width view, and no host sidebar, so navigation is never doubled.
 *  - With no project open, the Projects manager (ProjectsHome) fills the content area. */
export default function App() {
  const agents = useAgentsController(window.orchaDesktop.agents)
  return (
    <AgentsProvider value={agents}>
      <AppShell />
    </AgentsProvider>
  )
}

function AppShell() {
  const agents = useAgents()
  const launchers = useLaunchers()
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** Settings › API keys opened over the onboarding wizard ("Use an API key instead"). */
  const [onbKeysOpen, setOnbKeysOpen] = useState(false)
  // Stats & Usage fills the panel like Settings; `null` = closed, else the view to open on.
  const [statsView, setStatsView] = useState<'overview' | UsageProviderId | null>(null)
  const statsOpen = statsView !== null
  const usage = useUsage(window.orchaDesktop.usage)
  /** Close whichever full-panel overlay (Settings, Stats & Usage) is showing. */
  const closeOverlays = useCallback(() => {
    setSettingsOpen(false)
    setStatsView(null)
  }, [])
  const [mode, setMode] = useState<AppMode>('loading')
  const [wizardVariant, setWizardVariant] = useState<WizardVariant>('first-run')
  const host = useHostState()
  const store = storage() ?? noStore
  const [width, setWidth] = useState(() => loadWidth(store))
  const [collapsed, setCollapsed] = useState(() => loadCollapsed(store))
  const [pinned, setPinned] = useState<Set<string>>(() => loadFavorites(store))
  const [order, setOrder] = useState<string[]>(() => loadOrder(store))
  const [agentsExpanded, setAgentsExpanded] = useState<Record<string, boolean>>(() => loadExpanded(store))
  // D14: project icons live in the portal's shared per-project store (containers.icon); this
  // store reads them off the host's container poll, writes through the validated portalPut
  // bridge, and keeps localStorage only as a read cache (see host/projectIcons.ts).
  const [iconStore] = useState(
    () => new ProjectIconStore(store, (apiPort, path, body) => window.orchaDesktop.portalPut(apiPort, path, body))
  )
  const icons = useSyncExternalStore(iconStore.subscribe, iconStore.icons)
  const [emojiRecents, setEmojiRecents] = useState<string[]>(() => loadRecents(store))
  const [iconError, setIconError] = useState<{ key: string; message: string } | null>(null)
  const setProjectIcon = (row: ProjectRow, icon: ProjectIcon | null): void => {
    const edit = iconEditability(row)
    if (!edit.ok) {
      setIconError({ key: row.key, message: edit.reason })
      return
    }
    if (icon?.kind === 'emoji') setEmojiRecents((prev) => pushRecent(store, prev, icon.value))
    setIconError((e) => (e?.key === row.key ? null : e))
    void iconStore.set(edit.target, icon).then((res) => {
      if (!res.ok) setIconError({ key: row.key, message: res.message })
    })
  }
  useEffect(() => {
    if (!iconError) return
    const t = setTimeout(() => setIconError(null), ICON_ERROR_MS)
    return () => clearTimeout(t)
  }, [iconError])
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [errors, setErrors] = useState<Record<string, StackActionError | null>>({})
  const [stopTarget, setStopTarget] = useState<{ project: string; name: string } | null>(null)
  const [stopError, setStopError] = useState<unknown>(null)

  // Decide the initial mode before showing anything: zero stacks → onboarding.
  useEffect(() => {
    let cancelled = false
    const fallback = setTimeout(() => {
      if (!cancelled) setMode((m) => (m === 'loading' ? 'manager' : m))
    }, FIRST_LOAD_FALLBACK_MS)
    void window.orchaDesktop
      .listStacks()
      .then((s) => {
        if (cancelled) return
        setWizardVariant('first-run')
        setMode((m) => (m === 'loading' ? (s.length === 0 ? 'onboarding' : 'manager') : m))
      })
      .catch(() => {
        if (!cancelled) setMode((m) => (m === 'loading' ? 'manager' : m)) // Docker down → notice row
      })
      .finally(() => clearTimeout(fallback))
    return () => {
      cancelled = true
      clearTimeout(fallback)
    }
  }, [])

  // File→Add Project (main) asks us to switch. Main already hides any embedded portal view.
  useEffect(
    () =>
      window.orchaDesktop.onNavigate(({ target, variant }) => {
        if (target === 'onboarding') setWizardVariant(variant ?? 'add-project')
        setMode(target)
      }),
    []
  )

  const { activeProject, embed, portal, stacks, cards, attention } = host
  // Server wins: fold each poll's `icon` fields into the icon store (and run the one-time
  // migration of icons picked on this Mac before the shared store existed).
  useEffect(() => {
    iconStore.applyServer(
      cards
        .filter((c) => c.stack.running && c.stack.apiPort !== null)
        .map((c) => ({ cid: c.container.id, apiPort: c.stack.apiPort as number, icon: c.container.icon }))
    )
  }, [cards, iconStore])
  const live = activeProject !== null ? portal[activeProject] : undefined
  const route = live?.route ?? null
  // The open container: the cid the portal itself RESOLVED (attention / liveAgents carry
  // it) wins over the URL — a portal SPA link can drop ?cid= from the route, and falling
  // back to the stack's first card would highlight (and SPA-navigate into) the wrong
  // container (QA). The route's ?cid= is the fallback before the portal reports.
  const activeCid = live?.attention?.cid ?? live?.liveAgents?.cid ?? (route ? cidFromSearch(route.search) : null)

  const rows = useMemo(
    () =>
      buildProjectRows({
        stacks,
        cards,
        attention,
        pinned,
        order,
        active: { project: activeProject, cid: activeCid, portalAttention: embed === 'v2' ? (live?.attention ?? null) : null }
      }),
    [stacks, cards, attention, pinned, order, activeProject, activeCid, embed, live?.attention]
  )

  const activeKey = useMemo(() => {
    if (activeProject === null) return null
    if (activeCid) return rowKey(activeProject, activeCid)
    const first = cards.find((c) => c.stack.project === activeProject)
    return first ? rowKey(activeProject, first.container.id) : rowKey(activeProject, null)
  }, [activeProject, activeCid, cards])

  const activeRow = rows.find((r) => r.key === activeKey) ?? null

  // ---- Terminal sessions (full panel, Orca-style) + command menu -------------------------
  // `termShown`: a terminal fills the content panel and main hides the portal view; the strip
  // on top switches back. It only counts while a terminal tab exists.
  const [termShownRaw, setTermShown] = useState(false)
  const [termFocus, setTermFocus] = useState(0)
  const termShownRef = useRef(false)
  const labelFor = useCallback(
    (project: string | null): string | null => {
      if (project === null) return null
      if (activeRow && activeRow.stack.project === project) return activeRow.name
      return stacks.find((s) => s.project === project)?.projectShort ?? project.replace(/^orcha-/, '')
    },
    [activeRow, stacks]
  )
  // A restored tab is titled after the sidebar row it was opened for (DT-36), not whichever
  // project happens to be open — and picks the name up once that row is discovered.
  const rowLabel = useCallback((key: string): string | null => rows.find((r) => r.key === key)?.name ?? null, [rows])
  const terms = useTerminals(labelFor, () => termShownRef.current, rowLabel)
  // Every close goes through here: bulk closes of live sessions and pinned tabs ask first.
  const closer = useTabCloser(terms)
  const hasTabs = mode === 'manager' && terms.available && terms.state.tabs.length > 0
  const termShown = hasTabs && termShownRaw && terms.state.activeKey !== null
  termShownRef.current = termShown
  const legacyLayout = activeProject !== null && embed === 'legacy'
  const stripHeight = hasTabs ? (legacyLayout ? STRIP_OUTER - 1 : STRIP_OUTER) : 0

  // Keep main's view bounds in step with the sidebar, the session strip and whether a terminal
  // fills the panel (arch §7.4). The sidebar is hidden in onboarding and in legacy mode, but
  // main only applies the width in V2/pending layout.
  const effectiveWidth = collapsed ? SIDEBAR_RAIL : width
  useEffect(() => {
    const send = (): void =>
      // Settings, like a terminal, fills the panel: main hides the portal view under it.
      fire(
        window.orchaDesktop.setHostLayout?.({
          sidebarWidth: effectiveWidth,
          collapsed,
          stripHeight,
          terminalShown: termShown || ((settingsOpen || statsOpen) && mode === 'manager')
        })
      )
    send()
    // Zooming the host chrome (View → Zoom) changes the CSS→DIP ratio and fires `resize`
    // here; re-report so main re-lays out the view with the new zoom factor (QA).
    window.addEventListener('resize', send)
    return () => window.removeEventListener('resize', send)
  }, [effectiveWidth, collapsed, stripHeight, termShown, settingsOpen, statsOpen, mode])

  const focusTerminal = useCallback(() => setTermFocus((n) => n + 1), [])
  const showPortal = useCallback(() => {
    closeOverlays()
    setTermShown(false)
  }, [])
  const showTab = useCallback(
    (key: string) => {
      closeOverlays()
      terms.activate(key)
      setTermShown(true)
      focusTerminal()
    },
    [terms, focusTerminal]
  )
  /** Launch a full-panel session: in the open project by default, or for a given sidebar row
   *  (and branch checkout) from its ⋯ menu. */
  const openTerminal = useCallback(
    (kind: TermKind, target?: { row: ProjectRow; branch: string | null }, opts?: { probe?: boolean }) => {
      const project = target ? target.row.stack.project : activeProject
      const place: SessionPlace = target
        ? { rowKey: target.row.key, branch: target.branch }
        : { rowKey: activeKey }
      if (opts?.probe) place.probe = true
      const label = target ? target.row.name : labelFor(project)
      if (terms.open(kind, project, label, place) === null) return
      closeOverlays()
      setTermShown(true)
      focusTerminal()
    },
    [activeProject, activeKey, terms, labelFor, focusTerminal]
  )
  // ⌃` : flip between the portal and the current terminal (a first one if none).
  const toggleTerminal = useCallback(() => {
    if (terms.state.tabs.length === 0) {
      openTerminal('shell')
      return
    }
    // Settings covers the panel: toggling from there means "show me the terminal" (DT-53),
    // the same as ⌘T, a session row or showTab — close Settings rather than flip underneath.
    if (settingsOpen || statsOpen) {
      closeOverlays()
      setTermShown(true)
      focusTerminal()
      return
    }
    setTermShown((v) => !v)
    focusTerminal()
  }, [terms.state.tabs.length, openTerminal, focusTerminal, settingsOpen, statsOpen, closeOverlays])
  const sessionGroups = useMemo(() => groupSessions(rows, terms.state.tabs), [rows, terms.state.tabs])
  // The session strip is scoped to ONE project — the project of the terminal on screen, else
  // the open project; All projects lists only home-folder sessions. Other projects' terminals
  // keep running (and stay in the sidebar under their project); they just aren't in this strip.
  const tabRowKey = useMemo(() => {
    const m = new Map<string, string>()
    for (const [rk, g] of sessionGroups.byRow) for (const t of g.all) m.set(t.key, rk)
    return m
  }, [sessionGroups])
  const scopeKey = termShown && terms.state.activeKey ? (tabRowKey.get(terms.state.activeKey) ?? null) : activeKey
  const scopeRow = scopeKey ? (rows.find((r) => r.key === scopeKey) ?? null) : null
  const stripTabs = useMemo(
    () => (scopeKey ? (sessionGroups.byRow.get(scopeKey)?.all ?? []) : sessionGroups.unplaced),
    [scopeKey, sessionGroups]
  )
  const stripTabsRef = useRef(stripTabs)
  stripTabsRef.current = stripTabs
  // Closing the on-screen tab must not hop to another project's session (the reducer picks a
  // neighbour across ALL tabs): stay in the same project's strip, or back to its portal.
  const lastShown = useRef<{ tab: string | null; scope: string | null }>({ tab: null, scope: null })
  useEffect(() => {
    const prev = lastShown.current
    const active = terms.state.activeKey
    const prevGone = prev.tab !== null && !terms.state.tabs.some((t) => t.key === prev.tab)
    if (termShown && prevGone && active && (tabRowKey.get(active) ?? null) !== prev.scope) {
      const same = prev.scope ? (sessionGroups.byRow.get(prev.scope)?.all ?? []) : sessionGroups.unplaced
      const next = same[same.length - 1]
      if (next) terms.activate(next.key)
      else setTermShown(false)
      lastShown.current = { tab: next?.key ?? null, scope: prev.scope }
      return
    }
    lastShown.current = termShown ? { tab: active, scope: scopeKey } : { tab: null, scope: null }
  }, [termShown, terms, terms.state.activeKey, terms.state.tabs, tabRowKey, scopeKey, sessionGroups])
  // Saved tabs whose project wasn't discovered at launch come back once it is.
  const { deferred: deferredTabs, restoreProject } = terms
  const stackKey = stacks.map((st) => st.project).join('\n')
  useEffect(() => {
    if (deferredTabs === 0 || !stackKey) return
    for (const project of stackKey.split('\n')) restoreProject(project)
  }, [deferredTabs, stackKey, restoreProject])

  const [menu, setMenu] = useState<{ open: boolean; snapshot: ImageBitmap | null }>({ open: false, snapshot: null })
  const menuBusy = useRef(false)
  /** A still of the portal view (null when none is showing) for a host overlay to sit on. */
  const captureView = useCallback(async (): Promise<ImageBitmap | null> => {
    const api = window.orchaDesktop
    if (activeProject === null || embed === 'legacy' || !api.portalSnapshot) return null
    const bytes = await Promise.race([
      api.portalSnapshot().catch(() => null),
      new Promise<null>((r) => setTimeout(() => r(null), SNAPSHOT_TIMEOUT_MS))
    ])
    return decodeSnapshot(bytes)
  }, [activeProject, embed])
  const openMenu = useCallback(async () => {
    if (menuBusy.current || menu.open) return
    menuBusy.current = true
    try {
      const api = window.orchaDesktop
      const snapshot = await captureView()
      setMenu({ open: true, snapshot })
      // The native view would draw over the DOM menu: hide it (the still stands in).
      fire(api.setHostModal?.(true))
    } finally {
      menuBusy.current = false
    }
  }, [menu.open, captureView])
  const closeMenu = useCallback((focus: 'host' | 'view' = 'view') => {
    setMenu((m) => ({ open: false, snapshot: m.snapshot }))
    const api = window.orchaDesktop
    // Keep the still until main has re-shown the view, so the panel never flashes.
    void Promise.resolve(api.setHostModal?.(false, { focus }))
      .catch(() => {})
      .then(() => requestAnimationFrame(() => setMenu((m) => (m.open ? m : { open: false, snapshot: null }))))
  }, [])

  // ---- Usage popover (sidebar status indicator) — DOM over the panel, so like the command
  // menu it hides the native view and stands a still of it in.
  const [usagePop, setUsagePop] = useState<{ open: boolean; snapshot: ImageBitmap | null }>({ open: false, snapshot: null })
  const usagePopBusy = useRef(false)
  const openUsagePop = useCallback(async () => {
    if (usagePopBusy.current || usagePop.open || menu.open) return
    usagePopBusy.current = true
    try {
      const snapshot = await captureView()
      setUsagePop({ open: true, snapshot })
      fire(window.orchaDesktop.setHostModal?.(true))
      void usage.refresh()
    } finally {
      usagePopBusy.current = false
    }
  }, [usagePop.open, menu.open, captureView, usage])
  const closeUsagePop = useCallback((focus: 'host' | 'view' = 'view') => {
    setUsagePop((m) => ({ open: false, snapshot: m.snapshot }))
    void Promise.resolve(window.orchaDesktop.setHostModal?.(false, { focus }))
      .catch(() => {})
      .then(() => requestAnimationFrame(() => setUsagePop((m) => (m.open ? m : { open: false, snapshot: null }))))
  }, [])
  const openStats = useCallback(
    (view: 'overview' | UsageProviderId = 'overview') => {
      setSettingsOpen(false)
      setStatsView(view)
    },
    []
  )
  // The tray popover's "Usage details & history" / "Manage Accounts…" land here via main.
  useEffect(() => {
    const api = window.orchaDesktop.usage
    if (!api?.onOpenStats) return
    return api.onOpenStats((target) => {
      if (target === 'accounts') {
        setStatsView(null)
        setSettingsOpen(true)
      } else {
        setSettingsOpen(false)
        setStatsView('overview')
      }
    })
  }, [])

  // Menu-bar commands (⌘T, ⌥⌘T, ⌘W in the dock, ⌃`) arrive from main whichever view has focus.
  const defaultAgent: AgentId = agents.snapshot?.defaultAgent ?? 'claude'
  const termCmdRef = useRef({ openTerminal, toggleTerminal, openMenu, terms, showPortal, closer, defaultAgent })
  termCmdRef.current = { openTerminal, toggleTerminal, openMenu, terms, showPortal, closer, defaultAgent }
  useEffect(() => {
    const api = window.orchaDesktop.term
    if (!api) return
    return api.onCommand((command) => {
      const c = termCmdRef.current
      if (command === 'new-shell') c.openTerminal('shell')
      else if (command === 'new-default-agent') c.openTerminal(c.defaultAgent)
      else if (command === 'open-settings') {
        setStatsView(null)
        setSettingsOpen(true)
      }
      else if (command === 'toggle-panel') c.toggleTerminal()
      else if (command === 'show-portal') c.showPortal()
      else if (command === 'command-menu') void c.openMenu()
      else if (command === 'close-tab' && c.terms.state.activeKey) c.closer.request([c.terms.state.activeKey])
    })
  }, [])

  const showHome = useCallback(() => {
    closeOverlays()
    setTermShown(false)
    fire(window.orchaDesktop.portalHide())
    setMode('manager')
  }, [])

  const startAddProject = useCallback(() => {
    // Wizard = no view visible — hide any embedded portal before mounting the wizard.
    fire(window.orchaDesktop.portalHide())
    setWizardVariant('add-project')
    setMode('onboarding')
  }, [])

  const openRow = useCallback((row: ProjectRow) => {
    if (!row.stack.running || row.stack.apiPort === null) return
    closeOverlays()
    setTermShown(false)
    // Project switch = a full load with ?cid= (arch §4): nothing from the previous project's
    // in-memory state can survive into this one.
    const path = row.container ? `/?cid=${encodeURIComponent(row.container.id)}` : '/'
    fire(window.orchaDesktop.portalShow(row.stack.project, path))
  }, [])

  const navigate = useCallback(
    (row: ProjectRow, path: string) => {
      closeOverlays()
      setTermShown(false)
      const target = withCidParam(path, row.container?.id ?? null)
      // SPA only when the target container is provably the one the portal shows: its
      // resolved/route cid matches, or (cid not yet known) the project has a single
      // container. Otherwise a full load with ?cid= (arch §4) — never an SPA navigate whose
      // cid the portal would ignore (QA 2).
      const projectCards = cards.filter((c) => c.stack.project === row.stack.project).length
      const sameContainer = row.container
        ? activeCid !== null
          ? activeCid === row.container.id
          : projectCards <= 1
        : activeCid === null
      if (row.stack.project === activeProject && row.key === activeKey && sameContainer && embed === 'v2') {
        // Same project, V2 portal: SPA navigation, no reload (keeps drafts/scroll).
        fire(window.orchaDesktop.embedSend({ type: 'navigate', path: target }))
      } else {
        fire(window.orchaDesktop.portalShow(row.stack.project, target))
      }
    },
    [activeKey, activeProject, activeCid, cards, embed]
  )

  const onNeedsYou = useCallback(() => {
    if (activeRow && embed === 'v2') {
      navigate(activeRow, '/needs')
      return
    }
    // No V2 portal open: jump to the first waiting decision — a plain /tasks or /requests
    // deep link (with cid) that every portal version understands.
    const item = firstDecision(attention?.items ?? [])
    if (item) fire(window.orchaDesktop.portalShow(item.project, item.path))
  }, [activeRow, embed, navigate, attention])

  const runStackAction = useCallback(
    async (project: string, action: 'start' | 'stop'): Promise<boolean> => {
      setBusy((b) => ({ ...b, [project]: true }))
      setErrors((e) => ({ ...e, [project]: null }))
      try {
        if (action === 'start') await window.orchaDesktop.startStack(project)
        else await window.orchaDesktop.stopStack(project)
        if (action === 'stop' && project === activeProject) showHome()
        await host.refresh()
        return true
      } catch (err) {
        setErrors((e) => ({ ...e, [project]: { action, error: err } }))
        if (action === 'stop') setStopError(err)
        // A failed start/stop can still have changed state (half-started stack): re-read.
        void host.refresh()
        return false
      } finally {
        setBusy((b) => ({ ...b, [project]: false }))
      }
    },
    [activeProject, host, showHome]
  )

  const requestStop = useCallback((project: string) => {
    const stack = host.stacks.find((s) => s.project === project)
    setStopError(null)
    setStopTarget({ project, name: stack?.projectShort ?? project })
  }, [host.stacks])

  // "Remove project…" (sidebar ⋯, All projects ⋯, ⌘K): dialog, progress, cleanup, toast.
  // Offered only when this preload has the bridge (an older one hides it everywhere).
  const canRemove = !!window.orchaDesktop.removeProject
  const removal = useProjectRemoval({
    rows,
    tabs: terms.state.tabs,
    activeProject,
    closeTab: terms.close,
    storage: store,
    forgetIcons: (cids) => iconStore.forget(cids),
    applyPrefs: (p) => {
      setPinned(p.favorites)
      setOrder(p.order)
      setAgentsExpanded(p.expanded)
    },
    openRow,
    showHome,
    refresh: host.refresh,
    // Inside the sidebar column when it is expanded: a native portal view can't cover it.
    toastStyle:
      collapsed || (activeProject !== null && embed === 'legacy')
        ? { left: (activeProject !== null && embed === 'legacy' ? 0 : SIDEBAR_RAIL) + 8, bottom: 12, maxWidth: 360 }
        : { left: 8, bottom: 12, width: Math.max(200, width - 16) }
  })

  // Portal → host action requests (validated + sender-tagged by main; the project is the
  // SENDER's own stack, never one named in the message). Stop always goes through the
  // host confirm dialog.
  const actionRef = useRef({ runStackAction, requestStop, showHome, startAddProject })
  actionRef.current = { runStackAction, requestStop, showHome, startAddProject }
  useEffect(() => {
    const api = window.orchaDesktop
    if (!api.onEmbedEvent) return
    return api.onEmbedEvent(({ project, msg }) => {
      if (msg.type !== 'requestHostAction') return
      const a = actionRef.current
      if (msg.action === 'startStack') void a.runStackAction(project, 'start')
      else if (msg.action === 'stopStack') a.requestStop(project)
      else if (msg.action === 'openManager') a.showHome()
      else if (msg.action === 'addProject') a.startAddProject()
    })
  }, [])

  // Host-renderer shortcuts (host chrome or a terminal focused): ⌘K → command menu (its
  // "Search <project>…" is the portal search the old ⌘K opened), ⌘1…9 → terminal tabs.
  // Inside the portal view ⌘K stays the portal's own search — the host never sees those keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const hit = matchHostShortcut(e, navigator.platform.toLowerCase().includes('mac'))
      if (!hit || mode !== 'manager' || stopTarget || removal.open || menu.open) return
      if (hit.type === 'command-menu') {
        e.preventDefault()
        void openMenu()
      } else {
        const tab = stripTabsRef.current[hit.index]
        if (!tab) return
        e.preventDefault()
        terms.activate(tab.key)
        setTermShown(true)
        focusTerminal()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, stopTarget, removal.open, menu.open, openMenu, terms, focusTerminal])

  if (mode === 'loading') {
    // The app frame with a quiet skeleton — never a blank window while Docker answers.
    return (
      <div className="flex h-full bg-bg" aria-busy="true" data-testid="app-loading">
        <div style={{ width: effectiveWidth }} className="flex shrink-0 flex-col gap-2 px-4 pt-4">
          <span className="flex items-center gap-2">
            <OrchaMark size={18} className="shrink-0" />
            <span className="text-[14px] font-semibold tracking-tight text-text">Embodent</span>
          </span>
          <span className="mt-3 h-3 w-24 animate-pulse rounded bg-hover" />
          <span className="h-3 w-32 animate-pulse rounded bg-hover" />
        </div>
        <div className="host-panel flex flex-1 flex-col">
          <div className="flex h-11 items-center border-b border-border px-4 text-[13px] text-text-3">Loading projects…</div>
        </div>
      </div>
    )
  }

  if (mode === 'onboarding') {
    return (
      <div className="relative h-full">
        <OnboardingWizard
          variant={wizardVariant}
          onDone={() => {
            setMode('manager')
            void host.refresh()
          }}
          onCancel={wizardVariant === 'add-project' ? () => setMode('manager') : undefined}
          onOpenApiKeys={window.orchaDesktop.providerKeys ? () => setOnbKeysOpen(true) : undefined}
        />
        {/* Setup's "Use an API key instead": Settings opens over the wizard on API keys. */}
        {onbKeysOpen && <SettingsView initialSection="apiKeys" onClose={() => setOnbKeysOpen(false)} />}
      </div>
    )
  }

  const activeStack = activeProject !== null ? stacks.find((s) => s.project === activeProject) : undefined
  const legacy = activeProject !== null && embed === 'legacy'

  const stopDialog = stopTarget && (
    <ConfirmStopDialog
      stackName={stopTarget.name}
      projects={projectsInStack(rows, stopTarget.project)}
      busy={busy[stopTarget.project] === true}
      error={stopError}
      onCancel={() => setStopTarget(null)}
      onConfirm={() => {
        setStopError(null)
        void runStackAction(stopTarget.project, 'stop').then((ok) => {
          if (ok) setStopTarget(null)
        })
      }}
    />
  )

  const dismissError = (project: string): void => setErrors((e) => ({ ...e, [project]: null }))
  // Each failed start/stop is shown on exactly ONE surface (desktop r1 review): the Stop
  // dialog while it is open for that stack, else the manager table when it is visible, else
  // a small glyph (message as tooltip) on the sidebar row.
  const surfaces = errorSurfaces(errors, {
    dialogProject: stopTarget?.project ?? null,
    managerVisible: activeProject === null
  })
  const home = (
    <ProjectsHome
      rows={rows}
      icons={icons}
      emojiRecents={emojiRecents}
      onSetIcon={setProjectIcon}
      iconOffer={(row) => (row.container ? iconStore.offer(row.container.id) : null)}
      iconError={legacy || activeProject === null ? iconError : null}
      onDismissIconError={() => setIconError(null)}
      loaded={host.loaded}
      dockerDown={host.dockerDown}
      dockerUnresponsive={host.dockerUnresponsive}
      dockerHidden={host.dockerHidden}
      busy={busy}
      errors={legacy ? surfaces.dialogFree : surfaces.table}
      onCreate={startAddProject}
      onOpen={openRow}
      onNavigate={navigate}
      onStart={(row) => void runStackAction(row.stack.project, 'start')}
      onStop={(row) => requestStop(row.stack.project)}
      onTogglePin={(row) => {
        if (row.container) setPinned(toggleFavorite(store, row.container.id))
      }}
      onDismissError={dismissError}
      onRemove={canRemove ? removal.request : undefined}
      onRefresh={host.refresh}
    />
  )

  // ---- Command menu items (Actions · Open tabs · Projects) ----
  const settingsRow = activeRow && activeRow.stack.running ? activeRow : (rows.find((r) => r.stack.running && r.stack.apiPort !== null) ?? null)
  const hereLabel = activeProject !== null ? (labelFor(activeProject) ?? 'this project') : 'your home folder'
  // DT-54: the terminal is only on screen when Settings isn't covering it
  const panelVisible = termShown && !settingsOpen && !statsOpen
  const commandItems: CommandAction[] = !menu.open
    ? []
    : [
        {
          id: 'new-shell',
          section: 'actions',
          disabled: !terms.available,
          label: 'New Terminal',
          hint: `in ${hereLabel}`,
          keywords: 'shell zsh bash tab console',
          shortcut: ['⌘', 'T'],
          glyph: <KindIcon kind="shell" className="h-4 w-4" />,
          run: () => {
            closeMenu('host')
            openTerminal('shell')
          }
        },
        ...launchers.map((id, i) => ({
          id: `new-agent-${id}`,
          section: 'actions' as const,
          disabled: !terms.available,
          label: agentShortLabel(id),
          hint: `${agentDef(id).label}${id === defaultAgent ? ' · default' : ''} in ${hereLabel}`,
          keywords: `agent launch cli ${id} ${agentDef(id).bin} ${agentDef(id).label}`,
          shortcut: i === 0 && id === defaultAgent ? ['⌥', '⌘', 'T'] : undefined,
          glyph: <KindIcon kind={id} className="h-4 w-4" />,
          run: () => {
            closeMenu('host')
            openTerminal(id)
          }
        })),
        {
          id: 'desktop-settings',
          section: 'actions',
          label: 'Settings…',
          hint: 'Agents & permissions',
          keywords: 'preferences agents yolo manual permissions cli installed default',
          shortcut: ['⌘', ','],
          glyph: <SettingsIcon className="h-4 w-4 text-text-3" />,
          run: () => {
            closeMenu('host')
            setStatsView(null)
            setSettingsOpen(true)
          }
        },
        {
          id: 'stats-usage',
          section: 'actions',
          label: 'Stats & Usage',
          hint: 'Tokens, est. cost and plan limits across agents',
          keywords: 'usage spend cost tokens limits quota rate claude codex billing stats analytics',
          glyph: <BarChart3 className="h-4 w-4 text-text-3" />,
          run: () => {
            closeMenu('host')
            setSettingsOpen(false)
            setStatsView('overview')
          }
        },
        {
          id: 'agent-settings',
          section: 'actions',
          label: 'Agent settings…',
          hint: settingsRow ? settingsRow.name : 'no running project',
          keywords: 'preferences configuration autonomy workspace execution',
          disabled: !settingsRow,
          glyph: <SettingsIcon className="h-4 w-4 text-text-3" />,
          run: () => {
            closeMenu('view')
            if (settingsRow) navigate(settingsRow, AGENT_SETTINGS_PATH)
          }
        },
        {
          id: 'notification-settings',
          section: 'actions',
          label: 'Notification settings…',
          hint: settingsRow ? settingsRow.name : 'no running project',
          keywords: 'notifications alerts mute pause snooze quiet hours bell',
          disabled: !settingsRow,
          glyph: <SettingsIcon className="h-4 w-4 text-text-3" />,
          run: () => {
            closeMenu('view')
            if (settingsRow) navigate(settingsRow, NOTIFICATION_SETTINGS_PATH)
          }
        },
        ...(activeRow && embed === 'v2'
          ? [
              {
                id: 'search-project',
                section: 'actions' as const,
                label: `Search ${activeRow.name}…`,
                keywords: 'find tasks agents requests portal',
                glyph: <SearchIcon className="h-4 w-4 text-text-3" />,
                run: () => {
                  closeMenu('view')
                  fire(window.orchaDesktop.embedSend({ type: 'openSearch' }))
                }
              }
            ]
          : []),
        ...(terms.state.tabs.length > 0
          ? [
              {
                id: 'toggle-panel',
                section: 'actions' as const,
                // DT-54: with Settings covering the terminal, ⌃` shows the terminal (DT-53) —
                // label, glyph and focus follow what is VISIBLE, not termShown alone.
                label: panelVisible ? `Back to ${activeRow?.name ?? 'projects'}` : 'Show terminal',
                keywords: 'terminal portal switch toggle session',
                shortcut: ['⌃', '`'],
                glyph: panelVisible ? <LayoutGrid className="h-4 w-4 text-text-3" /> : <PanelTop className="h-4 w-4 text-text-3" />,
                run: () => {
                  closeMenu(panelVisible ? 'view' : 'host')
                  toggleTerminal()
                }
              }
            ]
          : []),
        {
          id: 'add-project',
          section: 'actions',
          label: 'Add project…',
          keywords: 'new create provision github',
          shortcut: ['⌘', 'N'],
          glyph: <PlusIcon className="h-4 w-4 text-text-3" />,
          run: () => {
            closeMenu('host')
            startAddProject()
          }
        },
        ...(terms.skipped > 0
          ? [
              {
                id: 'restore-last-session',
                section: 'actions' as const,
                label: 'Restore last session',
                hint: `${terms.skipped} tab${terms.skipped === 1 ? '' : 's'}`,
                keywords: 'reopen terminal tabs resume claude codex previous quit',
                glyph: <History className="h-4 w-4 text-text-3" />,
                run: () => {
                  closeMenu('host')
                  terms.restoreLast()
                }
              }
            ]
          : []),
        ...(activeRow && canRemove
          ? [
              {
                id: 'remove-project',
                section: 'actions' as const,
                label: 'Remove project…',
                hint: activeRow.name,
                danger: true,
                keywords: 'delete uninstall remove project stack docker containers clean',
                glyph: <Trash2 className="h-4 w-4 text-danger" />,
                run: () => {
                  closeMenu('host')
                  removal.request(activeRow)
                }
              }
            ]
          : []),
        ...terms.state.tabs.map((tab) => ({
          id: `tab-${tab.key}`,
          section: 'tabs' as const,
          label: stripTitle(tab),
          hint: exitLabel(tab) ?? (tab.key === terms.state.activeKey ? 'current' : undefined),
          keywords: `${tab.kind} terminal tab ${tab.cwd ?? ''}`,
          shortcut: (() => {
            const i = stripTabs.findIndex((t) => t.key === tab.key)
            return i >= 0 && i < 9 ? ['⌘', String(i + 1)] : undefined
          })(),
          glyph: <KindIcon kind={tab.kind} className="h-4 w-4" />,
          run: () => {
            closeMenu('host')
            showTab(tab.key)
          }
        })),
        ...rows.map((row) => {
          const openable = row.stack.running && row.stack.apiPort !== null
          return {
            id: `project-${row.key}`,
            section: 'projects' as const,
            label: row.name,
            hint: row.key === activeKey ? 'open' : openable ? undefined : 'stopped',
            keywords: `project switch ${row.stack.projectShort}`,
            disabled: !openable,
            glyph: <ProjectIconGlyph icon={icons[projectIconKey(row)] ?? null} size={16} ring="var(--color-raised)" />,
            run: () => {
              closeMenu('view')
              openRow(row)
            }
          }
        })
      ]

  const panelLeft = legacy ? 0 : effectiveWidth
  const commandMenu = menu.open && (
    <CommandMenu
      items={commandItems}
      left={panelLeft}
      width={Math.max(320, window.innerWidth - panelLeft)}
      onClose={() => closeMenu('view')}
    />
  )
  const still = menu.snapshot ?? usagePop.snapshot
  const snapshot = still && <PortalSnapshot image={still} />
  const statsProjects: StatsProject[] = rows
    .filter((r) => r.stack.running && r.stack.apiPort !== null && r.container)
    .map((r) => ({ key: r.key, name: r.name, apiPort: r.stack.apiPort as number, cid: (r.container as { id: string }).id }))
  const statsView_ = statsOpen && (
    <StatsView
      usage={usage}
      initialView={statsView ?? 'overview'}
      projects={statsProjects}
      portalGet={window.orchaDesktop.portalGet}
      onClose={() => setStatsView(null)}
    />
  )
  const usagePopover = usagePop.open && (
    <>
      <div className="fixed inset-0 z-40" aria-hidden="true" onMouseDown={() => closeUsagePop('view')} />
      <div
        className="fixed z-50 animate-fade-in"
        // Expanded sidebar: above its footer (the indicator's row); rail: beside the rail.
        style={collapsed || legacy ? { left: (legacy ? 0 : SIDEBAR_RAIL) + 8, bottom: 12 } : { left: 8, bottom: 124 }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            closeUsagePop('host')
          }
        }}
      >
        <UsagePopover
          usage={usage}
          onOpenDetails={(id) => {
            closeUsagePop('host')
            openStats(id ?? 'overview')
          }}
          onManageAccounts={() => {
            closeUsagePop('host')
            setStatsView(null)
            setSettingsOpen(true)
          }}
        />
      </div>
    </>
  )
  const settingsView = settingsOpen && (
    <SettingsView
      onClose={() => closeOverlays()}
      onTestLaunch={(id) => openTerminal(id, undefined, { probe: true })}
      notificationsProject={settingsRow?.name ?? null}
      usage={usage}
      onOpenStats={() => openStats('overview')}
      onOpenNotificationSettings={
        settingsRow
          ? () => {
              closeOverlays()
              navigate(settingsRow, NOTIFICATION_SETTINGS_PATH)
            }
          : undefined
      }
      onOpenVoiceSettings={
        settingsRow
          ? () => {
              closeOverlays()
              navigate(settingsRow, VOICE_SETTINGS_PATH)
            }
          : undefined
      }
    />
  )

  const portalTab = scopeRow
    ? { label: scopeRow.name, icon: <ProjectIconGlyph icon={icons[projectIconKey(scopeRow)] ?? null} size={16} ring="var(--color-card)" /> }
    : { label: 'All projects', icon: <LayoutGrid className="h-3.5 w-3.5 text-text-3" /> }
  const sessions = (content: ReactNode) =>
    hasTabs ? (
      <SessionPanel
        terms={terms}
        tabs={stripTabs}
        shown={termShown}
        portalTab={portalTab}
        onShowPortal={() =>
          // The strip's project tab opens THAT project's portal (a terminal from another
          // project may be on screen while a different portal is loaded underneath).
          scopeRow && scopeRow.key !== activeKey && scopeRow.stack.running && scopeRow.stack.apiPort !== null
            ? openRow(scopeRow)
            : showPortal()
        }
        onShowTab={showTab}
        onLaunch={(kind) => openTerminal(kind)}
        onOpenMenu={() => void openMenu()}
        onCloseTabs={closer.request}
        focusToken={termFocus}
      >
        {content}
      </SessionPanel>
    ) : (
      content
    )

  // Dictation in the desktop's own fields goes through the running project's portal.
  const withDictation = (node: ReactNode) => (
    <DesktopDictation
      apiPort={settingsRow?.stack.apiPort ?? null}
      cid={settingsRow?.container?.id ?? null}
      onOpenSettings={
        settingsRow
          ? () => {
              closeOverlays()
              navigate(settingsRow, VOICE_SETTINGS_PATH)
            }
          : undefined
      }
    >
      {node}
    </DesktopDictation>
  )

  if (legacy) {
    // Older portal in the view: keep the pre-V2 chrome so its own sidebar isn't doubled.
    return withDictation(
      <div className="flex h-full flex-col">
        {activeStack && <TopBar stack={activeStack} onBack={showHome} />}
        <div className="relative min-h-0 min-w-0 flex-1">
          {sessions(
            <>
              {home}
              {snapshot}
            </>
          )}
          {settingsView}
          {statsView_}
        </div>
        {stopDialog}
        {removal.ui}
        {closer.dialog}
        {commandMenu}
        {usagePopover}
      </div>
    )
  }

  return withDictation(
    <div className="flex h-full">
      <HostSidebar
        rows={rows}
        total={totalAttention(rows)}
        activeKey={activeKey}
        activeSection={activeProject !== null ? sectionForPath(route?.path) : null}
        width={effectiveWidth}
        collapsed={collapsed}
        busy={busy}
        errors={surfaces.sidebar}
        onShowError={showHome}
        loading={!host.loaded}
        dockerDown={host.dockerDown}
        dockerUnresponsive={host.dockerUnresponsive}
        onDismissError={dismissError}
        agentsExpanded={agentsExpanded}
        icons={icons}
        emojiRecents={emojiRecents}
        onSetIcon={setProjectIcon}
        iconOffer={(row) => (row.container ? iconStore.offer(row.container.id) : null)}
        // one surface per error (desktop r1 review): the manager table while it is showing
        iconError={activeProject === null ? null : iconError}
        onDismissIconError={() => setIconError(null)}
        onToggleAgents={(row, next) => {
          setAgentsExpanded((prev) => {
            const updated = { ...prev, [row.key]: next }
            saveExpanded(store, updated)
            return updated
          })
        }}
        managerActive={activeProject === null}
        onOpen={(row) => {
          if (row.key === activeKey && embed === 'v2') navigate(row, '/')
          else openRow(row)
        }}
        onNavigate={navigate}
        onNeedsYou={onNeedsYou}
        onStart={(row) => void runStackAction(row.stack.project, 'start')}
        onStop={(row) => requestStop(row.stack.project)}
        onTogglePin={(row) => {
          if (row.container) setPinned(toggleFavorite(store, row.container.id))
        }}
        onMove={(row, delta) => {
          const next = moveKey(
            rows.map((r) => r.key),
            row.key,
            delta
          )
          setOrder(next)
          saveOrder(store, next)
        }}
        onShowManager={showHome}
        onAddProject={startAddProject}
        onHelp={() => fire(window.orchaDesktop.openExternal(HELP_URL))}
        onOpenSettings={() => {
          setStatsView(null)
          setSettingsOpen((v) => !v)
        }}
        usageSlot={
          usage.available && usageRowVisible(usage.display) ? (
            <UsageIndicator
              snapshot={usage.snapshot}
              display={usage.display}
              open={usagePop.open}
              collapsed={collapsed}
              onToggle={() => (usagePop.open ? closeUsagePop() : void openUsagePop())}
            />
          ) : undefined
        }
        settingsActive={settingsOpen}
        onOpenCommandMenu={() => void openMenu()}
        onResize={(w, commit) => {
          const next = clampWidth(w)
          setWidth(next)
          if (commit) saveWidth(store, next)
        }}
        sessions={hasTabs ? sessionGroups : undefined}
        activeSessionKey={termShown ? terms.state.activeKey : null}
        sessionActions={{
          onOpen: showTab,
          onRename: (key, title) => terms.rename(key, title),
          onRestart: (key) => {
            terms.restart(key)
            showTab(key)
          },
          onClose: (key) => closer.request([key]),
          tabMenu: { tabs: terms.state.tabs, onPin: terms.pin, onCloseTabs: closer.request, onColor: terms.setColor }
        }}
        onLaunch={terms.available ? (row, kind, branch) => openTerminal(kind, { row, branch }) : undefined}
        onRemove={canRemove ? removal.request : undefined}
        onToggleCollapsed={() => {
          setCollapsed((c) => {
            saveCollapsed(store, !c)
            return !c
          })
        }}
      />
      {/* The inset raised panel (D5). The open project's portal view is drawn by main over
          exactly this rect (main/viewBounds.ts PANEL_GAP/PANEL_RADIUS). The Projects manager
          stays mounted underneath so "All projects" is instant. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="host-panel relative min-h-0 flex-1" data-testid="host-panel">
          {sessions(
            <>
              {home}
              {snapshot}
            </>
          )}
          {settingsView}
          {statsView_}
        </div>
      </div>
      {stopDialog}
      {removal.ui}
      {closer.dialog}
      {commandMenu}
      {usagePopover}
    </div>
  )
}
