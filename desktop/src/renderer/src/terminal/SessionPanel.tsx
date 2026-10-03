import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { Command, MoreHorizontal, Plus, RotateCw, X } from 'lucide-react'
import { cn } from '../ui/cn'
import { AGENT_CLI, type TermKind } from '../../../shared/terminal'
import { notFoundText } from '../../../shared/agents'
import TerminalView from './TerminalView'
import { KindIcon } from './KindIcon'
import { cliMissing, exitLabel, tabTitle, type TermTab } from './termTabs'
import { RESTORED_NOTE_MS, type Terminals } from './useTerminals'
import { PopMenu, launchItems } from '../host/SessionRow'
import { useLaunchers } from '../agents/AgentsContext'
import { SessionGlyph } from '../host/SessionRow'
import { sessionStatus } from './sessions'
import { TabMenu, type TabMenuActions } from './TabMenu'
import { tabColorCss, tabColorName } from './tabColors'
import { useHostModal } from '../host/useHostModal'

/** Width of the tab menu (w-64) — used to keep a right-click menu inside the strip. */
const TAB_MENU_WIDTH = 256
/** Session tab strip height inside the panel (border excluded). */
export const STRIP_HEIGHT = 36
/** What main reserves above the portal view for the strip: the panel's 1px top border, the
 *  strip, and its 1px bottom border (main/viewBounds.ts insetForMode `stripHeight`). */
export const STRIP_OUTER = STRIP_HEIGHT + 2

/** Title a terminal tab shows in the strip: the user's name, else the program's own window
 *  title (Claude Code's task summary), else "zsh · project". */
export function stripTitle(tab: TermTab): string {
  return tab.customTitle ?? tab.meta?.title ?? tabTitle(tab)
}

/** Orca-style full-panel sessions. The content panel shows EITHER the project's portal (the
 *  native view main lays out under the strip) OR one terminal filling the whole panel — never
 *  a dock squeezing the portal. The strip on top lists the portal tab (project icon + name)
 *  and every terminal tab, so switching back is one click. Terminals stay mounted while the
 *  portal shows (scrollback / TUI state survive) and refit when shown. */
export default function SessionPanel({
  terms,
  shown,
  portalTab,
  onShowPortal,
  onShowTab,
  onLaunch,
  onOpenMenu,
  onCloseTabs,
  focusToken,
  children
}: {
  terms: Terminals
  /** A terminal fills the panel (false = the portal / projects view is showing). */
  shown: boolean
  portalTab: { label: string; icon: ReactNode }
  onShowPortal(): void
  onShowTab(key: string): void
  onLaunch(kind: TermKind): void
  onOpenMenu(): void
  /** Confirm-aware close (useTabCloser); defaults to closing straight away. */
  onCloseTabs?(keys: string[]): void
  focusToken: number
  /** The portal area (the Projects manager underneath / the portal still). */
  children: ReactNode
}) {
  const { state, api, client } = terms
  const termRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const launchers = useLaunchers()
  const [renaming, setRenaming] = useState<string | null>(null)
  const [menu, setMenu] = useState(false)
  /** Tab menu (right-click / Shift+F10 / context-menu key): which tab, and its left edge in
   *  strip coordinates. */
  const [tabMenu, setTabMenu] = useState<{ key: string; left: number } | null>(null)
  // + opens the launcher menu (New Terminal / Claude / Codex / other enabled agents), Orca-style
  const [newMenu, setNewMenu] = useState<{ left: number } | null>(null)
  const newBtn = useRef<HTMLButtonElement>(null)
  const menuTrigger = useRef<HTMLButtonElement>(null)
  const hasTabs = state.tabs.length > 0
  const closeTabs = (keys: string[]): void => {
    if (onCloseTabs) onCloseTabs(keys)
    else for (const k of keys) terms.close(k)
  }
  const tabActions: TabMenuActions = {
    tabs: state.tabs,
    onPin: terms.pin,
    onCloseTabs: closeTabs,
    onColor: terms.setColor,
    onRestart: terms.restart
  }
  // A menu dropping over the native portal view would be drawn UNDER it: hide the view while
  // one is open with the portal showing (the terminal area is DOM, nothing to hide).
  useHostModal((menu || tabMenu !== null || newMenu !== null) && !shown)
  const tabEl = (key: string): HTMLElement | null =>
    stripRef.current?.querySelector<HTMLElement>(`[data-tab-key="${CSS.escape(key)}"]`) ?? null
  const openTabMenu = (key: string, clientX?: number): void => {
    const strip = stripRef.current
    if (!strip) return
    const box = strip.getBoundingClientRect()
    const x = clientX ?? tabEl(key)?.getBoundingClientRect().left ?? box.left
    const left = Math.max(6, Math.min(x - box.left, box.width - TAB_MENU_WIDTH - 6))
    setMenu(false)
    setTabMenu({ key, left })
  }
  const menuTab = tabMenu ? (state.tabs.find((t) => t.key === tabMenu.key) ?? null) : null

  // Tell main when keyboard focus enters/leaves the terminal: ⌘W then closes the TAB.
  useEffect(() => {
    const el = termRef.current
    if (!el || !api) return
    const onIn = (): void => api.setFocus(true)
    const onOut = (e: FocusEvent): void => {
      if (!el.contains(e.relatedTarget as Node | null)) api.setFocus(false)
    }
    el.addEventListener('focusin', onIn)
    el.addEventListener('focusout', onOut)
    return () => {
      el.removeEventListener('focusin', onIn)
      el.removeEventListener('focusout', onOut)
      api.setFocus(false)
    }
  }, [api])

  // The selected tab is always in view: an overflowing strip scrolls to it on activation
  // (⌘1-9, sidebar clicks, a restore landing on a far-right tab — DT-20).
  const selectedKey = shown ? state.activeKey : null
  useEffect(() => {
    const el = selectedKey
      ? stripRef.current?.querySelector<HTMLElement>(`[data-tab-key="${CSS.escape(selectedKey)}"]`)
      : stripRef.current?.querySelector<HTMLElement>('[data-testid="portal-tab"]')
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [selectedKey, state.tabs.length])

  // A restored tab's "Restored · …" note stays until it has been ON SCREEN for a few seconds:
  // a relaunch that opens on the portal must not fade it unseen (DT-35). Hiding the terminal
  // (or switching tabs) before then restarts the wait next time it shows.
  const noteKey = shown && terms.active?.restoredNote ? terms.active.key : null
  const { dismissRestored } = terms
  useEffect(() => {
    if (!noteKey) return
    const t = setTimeout(() => dismissRestored([noteKey]), RESTORED_NOTE_MS)
    return () => clearTimeout(t)
  }, [noteKey, dismissRestored])

  // Strip order: [portal, ...terminals]; index 0 = the portal tab.
  const selectedIndex = shown ? 1 + state.tabs.findIndex((t) => t.key === state.activeKey) : 0
  const select = (index: number): void => {
    if (index <= 0) onShowPortal()
    else onShowTab(state.tabs[index - 1].key)
  }
  const onStripKey = (e: ReactKeyboardEvent<HTMLDivElement>, index: number): void => {
    const count = state.tabs.length + 1
    let next = -1
    if (e.key === 'ArrowRight') next = (index + 1) % count
    else if (e.key === 'ArrowLeft') next = (index - 1 + count) % count
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = count - 1
    else if (index > 0 && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault()
      closeTabs([state.tabs[index - 1].key])
      return
    } else if (index > 0 && e.key === 'F2') {
      e.preventDefault()
      setRenaming(state.tabs[index - 1].key)
      return
    } else if (index > 0 && (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) {
      e.preventDefault()
      openTabMenu(state.tabs[index - 1].key)
      return
    }
    if (next < 0) return
    e.preventDefault()
    select(next)
    stripRef.current?.querySelector<HTMLElement>(`[data-strip-index="${next}"]`)?.focus()
  }

  const active = shown ? terms.active : null
  const iconBtn = 'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-3 hover:bg-hover hover:text-text'

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="session-panel" data-terminal-shown={shown ? 'true' : 'false'}>
      {hasTabs && (
        <div
          ref={stripRef}
          data-testid="session-strip"
          className="relative flex shrink-0 items-center gap-1 border-b border-border pl-1.5 pr-1.5"
          style={{ height: STRIP_HEIGHT + 1 }}
        >
          {/* The tab list scrolls on its own; + sits just after it, outside the scroller, so it
              stays reachable however many tabs are open (DT-20). */}
          <div
            role="tablist"
            aria-label="Sessions"
            data-testid="session-tablist"
            className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"
          >
            <div
              role="tab"
              tabIndex={selectedIndex === 0 ? 0 : -1}
              aria-selected={selectedIndex === 0}
              data-strip-index={0}
              data-testid="portal-tab"
              title={`${portalTab.label} (portal)`}
              onClick={onShowPortal}
              onKeyDown={(e) => onStripKey(e, 0)}
              className={cn(
                'flex h-7 max-w-[220px] shrink-0 cursor-default items-center gap-1.5 rounded-md px-2 text-[12.5px] outline-none focus-visible:!shadow-[inset_0_0_0_1.5px_var(--color-accent)]',
                selectedIndex === 0 ? 'bg-hover text-text' : 'text-text-2 hover:bg-hover/60 hover:text-text'
              )}
            >
              <span className="flex shrink-0 items-center">{portalTab.icon}</span>
              <span className="truncate font-medium">{portalTab.label}</span>
            </div>
            <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-border" />
            {state.tabs.map((tab, i) => (
              <Tab
                key={tab.key}
                tab={tab}
                index={i}
                active={selectedIndex === i + 1}
                renaming={renaming === tab.key}
                menuOpen={tabMenu?.key === tab.key}
                onActivate={() => onShowTab(tab.key)}
                onClose={() => closeTabs([tab.key])}
                onStartRename={() => setRenaming(tab.key)}
                onRename={(title) => {
                  if (title !== undefined) terms.rename(tab.key, title)
                  setRenaming(null)
                  tabEl(tab.key)?.focus()
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  openTabMenu(tab.key, e.clientX)
                }}
                onKeyDown={(e) => onStripKey(e, i + 1)}
              />
            ))}
          </div>
          <button
            ref={newBtn}
            type="button"
            aria-label="New tab"
            aria-haspopup="menu"
            aria-expanded={newMenu !== null}
            title="New tab — terminal or agent"
            data-testid="strip-new"
            onClick={() => {
              if (newMenu) return setNewMenu(null)
              const strip = stripRef.current
              const b = newBtn.current?.getBoundingClientRect()
              const box = strip?.getBoundingClientRect()
              const left = b && box ? Math.max(6, Math.min(b.left - box.left, box.width - 224 - 6)) : 6
              setMenu(false)
              setTabMenu(null)
              setNewMenu({ left })
            }}
            className={iconBtn}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <span aria-hidden="true" className="min-w-0 flex-1" />
          <button type="button" aria-label="Command menu" title="Claude, Codex and more (⌘K)" onClick={onOpenMenu} className={iconBtn}>
            <Command className="h-3.5 w-3.5" />
          </button>
          <button
            ref={menuTrigger}
            type="button"
            aria-label="Session actions"
            aria-haspopup="menu"
            aria-expanded={menu}
            data-testid="strip-menu"
            onClick={() => {
              setTabMenu(null)
              setMenu((m) => !m)
            }}
            className={iconBtn}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
          {menu && shown && terms.active ? (
            // The active tab's full menu, after the "Open" launchers and the way back.
            <TabMenu
              tab={terms.active}
              actions={tabActions}
              startRename={() => setRenaming(terms.active!.key)}
              className="left-auto right-1.5 w-64"
              extra={[launchItems(onLaunch, launchers), [{ id: 'portal', label: `Back to ${portalTab.label}`, run: onShowPortal }]]}
              label="Session actions"
              onClose={(restore) => {
                setMenu(false)
                if (restore) menuTrigger.current?.focus()
              }}
            />
          ) : menu ? (
            <PopMenu
              label="Session actions"
              className="left-auto right-1.5 w-56"
              onClose={(restore) => {
                setMenu(false)
                if (restore) menuTrigger.current?.focus()
              }}
              sections={[launchItems(onLaunch, launchers)]}
            />
          ) : null}
          {newMenu && (
            <PopMenu
              label="New tab"
              className="right-auto w-56"
              style={{ left: newMenu.left }}
              onClose={(restore) => {
                setNewMenu(null)
                if (restore) newBtn.current?.focus()
              }}
              sections={[launchItems((kind) => { setNewMenu(null); onLaunch(kind) }, launchers)]}
            />
          )}
          {menuTab && tabMenu && (
            <TabMenu
              tab={menuTab}
              actions={tabActions}
              startRename={() => setRenaming(menuTab.key)}
              className="right-auto w-64"
              style={{ left: tabMenu.left }}
              onClose={(restore) => {
                const key = tabMenu.key
                setTabMenu(null)
                if (restore) tabEl(key)?.focus()
              }}
            />
          )}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {children}
        <div
          ref={termRef}
          role="tabpanel"
          aria-label={active ? stripTitle(active) : 'Terminal'}
          data-testid="terminal-area"
          className={cn('absolute inset-0 z-10 bg-card', !shown && 'hidden')}
        >
          {api &&
            state.tabs.map((tab) =>
              tab.ptyId !== null ? (
                <TerminalView
                  key={`${tab.key}:${tab.ptyId}`}
                  ptyId={tab.ptyId}
                  api={api}
                  client={client}
                  visible={shown && tab.key === state.activeKey}
                  focusToken={focusToken}
                  exited={tab.status === 'exited'}
                />
              ) : null
            )}
          {active && active.status === 'starting' && (
            <div className="absolute inset-0 flex items-center justify-center text-[12px] text-text-3">Starting…</div>
          )}
          {active && (active.status === 'exited' || active.status === 'failed') && (
            <ExitBar tab={active} onRestart={() => terms.restart(active.key)} onClose={() => terms.close(active.key)} />
          )}
          {active?.note && active.status === 'running' ? (
            <NoteBar note={active.note} />
          ) : active?.restoredNote ? (
            <NoteBar note={active.restoredNote} testId="restored-note" />
          ) : null}
        </div>
      </div>
    </div>
  )
}

function Tab({
  tab,
  index,
  active,
  renaming,
  menuOpen,
  onActivate,
  onClose,
  onStartRename,
  onRename,
  onContextMenu,
  onKeyDown
}: {
  tab: TermTab
  index: number
  active: boolean
  renaming: boolean
  menuOpen: boolean
  onActivate(): void
  onClose(): void
  onStartRename(): void
  /** A title to save (empty → back to the program's title), or undefined = cancelled. */
  onRename(title: string | null | undefined): void
  onContextMenu(e: ReactMouseEvent<HTMLDivElement>): void
  onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void
}) {
  const title = stripTitle(tab)
  const status = exitLabel(tab)
  const failed = tab.status === 'failed' || (tab.status === 'exited' && (tab.exit?.exitCode !== 0 || !!tab.exit?.signal))
  const attention = sessionStatus(tab) === 'attention'
  // Enter / Escape unmount the input; its blur must not save a second time.
  const done = useRef(false)
  const finish = (value: string | null | undefined): void => {
    if (done.current) return
    done.current = true
    onRename(value)
  }
  useEffect(() => {
    if (renaming) done.current = false
  }, [renaming])
  // Pinned: compact (kind icon + colour dot), the title lives in the tooltip / accessible name.
  // A set colour is always a small dot before the title; only the active tab gets an underline.
  const compact = tab.pinned && !renaming
  const colorName = tab.color ? tabColorName(tab.color) : null
  return (
    <div
      role="tab"
      tabIndex={active ? 0 : -1}
      aria-selected={active}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      aria-keyshortcuts="Shift+F10 ContextMenu F2"
      aria-label={compact ? `${title}${status ? ` · ${status}` : ''} · pinned${colorName ? ` · ${colorName}` : ''}` : undefined}
      data-tab-key={tab.key}
      data-strip-index={index + 1}
      data-testid="terminal-tab"
      data-pinned={tab.pinned ? 'true' : undefined}
      data-tab-color={tab.color ?? undefined}
      title={`${title}${tab.pinned ? ' (pinned)' : ''}${tab.cwd ? ` — ${tab.cwd}` : ''}${index < 9 ? ` (⌘${index + 1})` : ''}`}
      onClick={onActivate}
      onDoubleClick={onStartRename}
      onContextMenu={onContextMenu}
      onMouseDown={(e) => {
        // Middle-click closes, like a browser tab.
        if (e.button === 1) {
          e.preventDefault()
          onClose()
        }
      }}
      onKeyDown={onKeyDown}
      className={cn(
        'group relative flex h-7 shrink-0 cursor-default items-center gap-1.5 rounded-md text-[12.5px] outline-none focus-visible:!shadow-[inset_0_0_0_1.5px_var(--color-accent)]',
        compact ? 'px-2' : 'max-w-[240px] pl-2 pr-1',
        active || menuOpen ? 'bg-hover text-text' : 'text-text-2 hover:bg-hover/60 hover:text-text'
      )}
    >
      <KindIcon kind={tab.kind} className="h-3.5 w-3.5 shrink-0" />
      {tab.color && (
        <span aria-hidden="true" data-testid="tab-color-dot" className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: tabColorCss(tab.color) }} />
      )}
      {active && (
        // The one underline in the strip: a neutral grey bar that means "current tab" (the
        // tab's own colour is the dot above, never a line).
        <span aria-hidden="true" data-testid="tab-active-underline" className="pointer-events-none absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-text-3" />
      )}
      {renaming ? (
        <input
          autoFocus
          aria-label="Tab name"
          defaultValue={tab.customTitle ?? title}
          onFocus={(e) => e.currentTarget.select()}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') finish(e.currentTarget.value)
            if (e.key === 'Escape') finish(undefined)
          }}
          onBlur={(e) => finish(e.currentTarget.value)}
          className="h-5 w-32 rounded border border-border-strong bg-bg px-1 text-[12px] text-text outline-none"
        />
      ) : compact ? null : (
        <span className="truncate">{title}</span>
      )}
      {status && !compact && (
        <span
          className={cn(
            'shrink-0 rounded-full border px-1.5 text-[10.5px] leading-4 tabular-nums',
            failed ? 'border-danger/40 text-danger' : 'border-border-strong text-text-3'
          )}
        >
          {status}
        </span>
      )}
      {attention && !active && <SessionGlyph status="attention" />}
      {tab.activity && !active && !attention && (
        <span aria-label="New output" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
      )}
      {!compact && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Close ${title}`}
          title="Close (⌘W)"
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          className={cn(
            'flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-3 hover:bg-selected hover:text-text',
            active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'
          )}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}

function ExitBar({ tab, onRestart, onClose }: { tab: TermTab; onRestart(): void; onClose(): void }) {
  const missing = cliMissing(tab)
  const cli = tab.kind !== 'shell' ? AGENT_CLI[tab.kind] : null
  const message = missing && cli && tab.kind !== 'shell'
    ? notFoundText(tab.kind)
    : tab.status === 'failed'
      ? (tab.error ?? 'Couldn’t start the terminal.')
      : `Process ${exitLabel(tab)}.`
  const bad = missing || tab.status === 'failed' || (tab.exit?.exitCode ?? 0) !== 0
  return (
    <div
      role="status"
      data-testid="terminal-exit"
      className="absolute inset-x-3 bottom-3 flex items-center gap-2 rounded-lg border border-border-strong bg-raised px-3 py-1.5 text-[12.5px] shadow-[var(--shadow-toast)]"
    >
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', bad ? 'bg-danger' : 'bg-text-3')} />
      <span className="min-w-0 flex-1 truncate text-text-2">
        {message}
        {missing && cli && <code className="ml-2 font-mono text-[11.5px] text-text-3">{cli.install}</code>}
      </span>
      <button
        type="button"
        onClick={onRestart}
        className="flex h-6 items-center gap-1 rounded-md border border-border-strong px-2 text-[12px] font-medium text-text hover:bg-hover"
      >
        <RotateCw className="h-3 w-3" /> Restart
      </button>
      <button type="button" onClick={onClose} className="h-6 rounded-md px-2 text-[12px] text-text-3 hover:bg-hover hover:text-text">
        Close
      </button>
    </div>
  )
}

function NoteBar({ note, testId }: { note: string; testId?: string }) {
  return (
    <div
      data-testid={testId}
      className="pointer-events-none absolute right-3 top-2 max-w-[60%] truncate rounded-full border border-border bg-raised/90 px-2 text-[11px] leading-5 text-text-3"
    >
      {note}
    </div>
  )
}
