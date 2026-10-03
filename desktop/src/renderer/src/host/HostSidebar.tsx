import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import {
  AlertCircle,
  ChevronRight,
  CircleDashed,
  CircleHelp,
  GitBranch,
  Inbox,
  Search,
  LayoutGrid,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  Settings2,
  SquareTerminal,
  Trash2,
  X
} from 'lucide-react'
import { cn } from '../ui/cn'
import { AgentAvatar, assignPalette, type AvatarStatus } from '../ui/Avatar'
import { ProjectIcon } from '../ui/ProjectIcon'
import { AgentStateGlyph } from '../ui/AgentStateGlyph'
import { IconPicker } from '../icons/IconPicker'
import { OrchaMark } from '../components/OrchaMark'
import type { HostCheckout, HostLiveAgent } from '../../../shared/types'
import { Tooltip } from '../ui/Tooltip'
import { readableError, type StackActionError } from '../util/errorText'
import type { ProjectRow, SectionKey } from './projectModel'
import { iconEditability, projectIconKey, type ProjectIcon as ProjectIconValue } from './projectIcons'
import { LIVE_SHOWN_MAX, buildProjectTree, shortAgo } from './projectTree'
import { SIDEBAR_MAX, SIDEBAR_MIN, isExpanded } from './sidebarPrefs'
import type { TermKind } from '../../../shared/terminal'
import type { TermTab } from '../terminal/termTabs'
import { liveCount, type SessionGroups } from '../terminal/sessions'
import { PopMenu, SessionRow, launchItems, type SessionActions } from './SessionRow'
import { useLaunchers } from '../agents/AgentsContext'

export const HELP_URL = 'https://github.com/open-orcha/orcha#readme'

export interface HostSidebarProps {
  rows: ProjectRow[]
  total: { count: number | null; partial: boolean; unknown: number }
  /** Key of the project row whose portal is open (null = manager/home showing). */
  activeKey: string | null
  /** Highlighted host entry derived from the open portal's route ('needs' / 'settings'). */
  activeSection: SectionKey | null
  width: number
  collapsed: boolean
  /** Stack-level busy/error state, keyed by compose project. */
  busy: Record<string, boolean>
  /** Failed start/stop per compose project that the SIDEBAR should flag. The host passes
   *  only errors no other surface is showing (the Stop dialog / the manager table carry the
   *  full notice), so the same failure never renders twice (desktop r1 review). The sidebar
   *  shows a small glyph with the one-line message as its tooltip — never the full notice. */
  errors: Record<string, StackActionError | null | undefined>
  managerActive: boolean
  /** The host's first stack list has not arrived yet. */
  loading?: boolean
  /** Docker CLI unreachable (the project list is unknown, not empty). */
  dockerDown?: boolean
  /** Docker's CLI timed out (wedged) rather than refused. */
  dockerUnresponsive?: boolean
  onOpen(row: ProjectRow): void
  onNavigate(row: ProjectRow, path: string): void
  onNeedsYou(): void
  onStart(row: ProjectRow): void
  onStop(row: ProjectRow): void
  onTogglePin(row: ProjectRow): void
  onMove(row: ProjectRow, delta: -1 | 1): void
  onShowManager(): void
  onAddProject(): void
  onHelp(): void
  /** Open desktop Settings (⌘,) — Agents. Optional so older callers/tests still render. */
  onOpenSettings?(): void
  /** Settings is showing (highlights the footer item). */
  settingsActive?: boolean
  /** The usage status indicator (usage/UsageIndicator.tsx), shown first in the footer. */
  usageSlot?: ReactNode
  /** Open the ⌘K command menu (terminals, Claude/Codex, tabs, projects). */
  onOpenCommandMenu?(): void
  onResize(width: number, commit: boolean): void
  onToggleCollapsed(): void
  onDismissError?(project: string): void
  /** Clicked the error glyph: show the full notice (the manager, which has Details). */
  onShowError?(row: ProjectRow): void
  /** D11: the user's explicit expand/collapse choices for nested live agents, by row key
   *  (absent = default: the open project expanded, others collapsed). */
  agentsExpanded?: Record<string, boolean>
  onToggleAgents?(row: ProjectRow, expanded: boolean): void
  /** D14: user-chosen project icons by projectIconKey (absent = the neutral default glyph). */
  icons?: Record<string, ProjectIconValue>
  /** Recently picked emoji, most recent first (the picker's "Recent" row). */
  emojiRecents?: string[]
  /** Set (null = reset to default) a project's icon. `done` = the picker should close. */
  onSetIcon?(row: ProjectRow, icon: ProjectIconValue | null): void
  /** The icon picked on this Mac before the shared store, offered when pushing it was refused. */
  iconOffer?(row: ProjectRow): ProjectIconValue | null
  /** A failed icon write (or why it can't be written), shown under that row. */
  iconError?: { key: string; message: string } | null
  onDismissIconError?(): void
  /** Open terminal sessions grouped under their project / branch (terminal/sessions.ts). */
  sessions?: SessionGroups
  /** The session filling the content panel right now (its branch group gets the card). */
  activeSessionKey?: string | null
  sessionActions?: SessionActions
  /** Launch a full-panel session for a project — in a branch's checkout when `branch` is set. */
  onLaunch?(row: ProjectRow, kind: TermKind, branch: string | null): void
  /** "Remove project…" (the ⋯ menu's last, red item): opens the confirmation dialog. */
  onRemove?(row: ProjectRow): void
}

export { LIVE_SHOWN_MAX }

/** The ONE short muted fragment after an agent's name (D11). */
export function agentFragment(a: HostLiveAgent): string {
  if (a.state === 'needs_review') return 'needs review'
  if (a.state === 'blocked') return 'blocked'
  if (a.state === 'waiting') return 'waiting'
  return a.task ?? 'working'
}

function ago(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const m = Math.max(0, Math.floor((now - t) / 60_000))
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`
}

/** Full sentence for the agent row's tooltip / accessible name. */
export function agentTooltip(a: HostLiveAgent): string {
  const task = a.task ? `“${a.task}”` : null
  const what =
    a.state === 'needs_review'
      ? `needs review${task ? `: ${task}` : ''}`
      : a.state === 'blocked'
        ? `blocked — waiting on a request${task ? ` (${task})` : ''}`
        : a.state === 'waiting'
          ? `waiting on a reply${task ? ` (${task})` : ''}`
          : task
          ? `working on ${task}`
          : 'working'
  const when = ago(a.lastActive)
  return `${a.alias} · ${what}${when ? ` · active ${when}` : ''}`
}

/** "Couldn’t start acme: Port 8101 is already in use — …" — the glyph's tooltip line. */
export function errorLine(error: StackActionError, stackName: string): string {
  return `Couldn’t ${error.action} ${stackName}: ${readableError(error.error).summary}`
}

/** Move focus between `[data-nav-item]` elements with ↑/↓ (Home/End jump) inside `root`. */
function moveFocus(root: HTMLElement | null, e: ReactKeyboardEvent): void {
  if (!root || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
  const target = e.target as HTMLElement
  if (target.closest('[role="menu"], [role="dialog"]')) return // menus / the icon picker handle their own arrows
  const items = Array.from(root.querySelectorAll<HTMLElement>('[data-nav-item]')).filter((el) => !el.hasAttribute('disabled'))
  if (items.length === 0) return
  const i = items.indexOf(target)
  let next = i
  if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = items.length - 1
  else if (e.key === 'ArrowDown') next = i < 0 ? 0 : Math.min(items.length - 1, i + 1)
  else next = i < 0 ? 0 : Math.max(0, i - 1)
  e.preventDefault()
  items[next]?.focus()
}

/** The top "Needs you" label, in words: a capped count reads "at least N", and projects
 *  whose count is unknown are named as such — the visible number never carries an
 *  unexplained "+" for them. */
export function totalAttentionLabel(total: HostSidebarProps['total']): string {
  const unknown =
    total.unknown > 0 ? `${total.unknown} project${total.unknown === 1 ? '' : 's'} couldn’t be checked` : null
  if (total.count === null) return unknown ? `Needs you: not known yet (${unknown})` : 'Needs you: not known yet'
  const n = total.partial ? `At least ${total.count}` : `${total.count}`
  const base = `${n} decision${total.count === 1 && !total.partial ? '' : 's'} waiting across local projects`
  return unknown ? `${base} · ${unknown}` : base
}

function countText(count: number, partial: boolean): string {
  return count > 99 ? '99+' : `${count}${partial ? '+' : ''}`
}

/** Muted, tabular attention count (Linear's sidebar counts): amber only when > 0. */
function Count({ count, partial, label }: { count: number | null; partial: boolean; label: string }) {
  if (count === null || count === 0) return null
  return (
    <span className="ml-auto shrink-0 text-xs font-medium tabular-nums text-warning" title={label} aria-label={label}>
      {countText(count, partial)}
    </span>
  )
}

function attentionLabel(row: ProjectRow): string {
  if (row.attention === null) return `${row.name}: needs-you count ${row.unavailableReason ?? 'unknown'}`
  const n = `${row.attention}${row.partial ? '+' : ''}`
  return row.attentionSource === 'portal'
    ? `${n} decisions waiting on you in ${row.name}${row.partial ? ' (counted from the first 1000 items)' : ''}`
    : `${n} pending decisions in ${row.name} (plans, verifications, requests; host check every 15 s${row.partial ? '; list capped' : ''})`
}

function stateWord(row: ProjectRow): string {
  if (row.state === 'stopped') return 'stack stopped'
  if (row.state === 'starting') return 'stack starting'
  return row.containerStatus ?? 'running'
}

function avatarStatus(row: ProjectRow): AvatarStatus {
  if (row.state === 'stopped') return 'stopped'
  if (row.state === 'starting') return 'starting'
  if (row.containerStatus) return 'paused'
  return null
}

/** Tree geometry (D14): the project icon starts after the 20px caret gutter + 4px; every
 *  level below indents one 16px step from there. */
const INDENT_BASE = 24
const INDENT_STEP = 16
const PICKER_HEIGHT = 340

function checkoutLabel(c: HostCheckout): string {
  return `${c.detached ? 'Detached checkout' : `Branch ${c.branch}`}${c.primary ? ' (primary checkout)' : ''}${c.repo ? ` · ${c.repo}` : ''}`
}

/** A branch/checkout row (D14). The primary checkout: bold branch + "primary" outline badge +
 *  the muted repo line. Other checkouts (agent worktrees): one quieter line, no repeated repo
 *  (D12 — the same fact is never shown twice). */
function CheckoutHeader({ checkout, onLaunch }: { checkout: HostCheckout; onLaunch?: (kind: TermKind) => void }) {
  const launchers = useLaunchers()
  const [menu, setMenu] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  return (
    <div title={checkoutLabel(checkout)} style={{ paddingLeft: INDENT_BASE + INDENT_STEP }} className="group relative pr-1">
      <div className="flex h-8 min-w-0 items-center gap-2">
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-text-3" aria-hidden="true" />
        <span className={cn('min-w-0 truncate text-[13px]', checkout.primary ? 'font-medium text-text' : 'text-text-2')}>
          {checkout.branch}
        </span>
        {checkout.primary && (
          <span className="shrink-0 rounded-[5px] border border-border-strong px-1.5 text-[11px] leading-4 text-text-2">primary</span>
        )}
        {onLaunch && (
          <button
            ref={trigger}
            type="button"
            data-testid="checkout-menu"
            aria-label={`More actions for branch ${checkout.branch}`}
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu((m) => !m)}
            className={cn(
              'ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-2 opacity-0 hover:bg-border hover:text-text focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100',
              menu && 'opacity-100'
            )}
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        )}
      </div>
      {checkout.primary && checkout.repo && (
        <div className="-mt-1.5 truncate pb-1 pl-[22px] text-[12px] leading-5 text-text-3">{checkout.repo}</div>
      )}
      {menu && onLaunch && (
        <PopMenu
          label={`Actions for branch ${checkout.branch}`}
          onClose={(restore) => {
            setMenu(false)
            if (restore) trigger.current?.focus()
          }}
          sections={[launchItems(onLaunch, launchers)]}
        />
      )}
    </div>
  )
}

function RowMenu({
  row,
  canMoveUp,
  canMoveDown,
  busy,
  onClose,
  actions
}: {
  row: ProjectRow
  canMoveUp: boolean
  canMoveDown: boolean
  busy: boolean
  onClose: (restoreFocus: boolean) => void
  actions: Pick<HostSidebarProps, 'onOpen' | 'onNavigate' | 'onStart' | 'onStop' | 'onTogglePin' | 'onMove' | 'onRemove'> & {
    /** Orca's "Open" section: a full-panel session for this project. */
    onLaunchKind?: (kind: TermKind) => void
    onChangeIcon?: () => void
    /** Why "Change icon…" is disabled (the project can't store it right now). */
    changeIconBlocked?: string | null
  }
}) {
  const launchers = useLaunchers()
  const ref = useRef<HTMLDivElement>(null)
  // Latest onClose without re-running the mount effect: a poll re-render must never move
  // focus back to the first item while the user is in the menu.
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus()
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeRef.current(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  const onKeyDown = (e: ReactKeyboardEvent): void => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])
    const i = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose(true)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length
      items[next]?.focus()
    } else if (e.key === 'Tab') {
      onClose(false)
    }
  }

  const running = row.stack.running && row.stack.apiPort !== null
  const item = (
    label: string,
    fn: () => void,
    opts: { disabled?: boolean; danger?: boolean; hint?: string | null } = {}
  ): ReactNode =>
    opts.hint ? (
      // Disabled WITH a reason: the reason is visible (a disabled button can't show a tooltip
      // to keyboard users) and part of the item's accessible description.
      <div
        role="menuitem"
        aria-disabled="true"
        tabIndex={-1}
        className="flex w-full flex-col rounded-md px-2 py-1 text-left outline-none focus-visible:bg-hover"
      >
        <span className="text-[13px] text-text opacity-40">{label}</span>
        <span className="text-[12px] leading-4 text-text-3">{opts.hint}</span>
      </div>
    ) : (
      <button
        type="button"
        role="menuitem"
        disabled={opts.disabled}
        className={cn(
          'flex h-7 w-full items-center rounded-md px-2 text-left text-[13px] hover:bg-hover focus-visible:bg-hover disabled:opacity-40',
          opts.danger ? 'text-danger' : 'text-text'
        )}
        onClick={() => {
          onClose(true)
          fn()
        }}
      >
        {label}
      </button>
    )

  return (
    // Anchored INSIDE the sidebar (left/right insets) so it never extends under the native
    // portal view, which would draw above it (arch §7.4).
    <div
      ref={ref}
      role="menu"
      aria-label={`Actions for ${row.name}`}
      onKeyDown={onKeyDown}
      className="absolute left-2 right-2 top-full z-20 mt-1 rounded-[10px] border border-border-strong bg-raised p-1 shadow-[var(--shadow-pop)]"
    >
      {actions.onLaunchKind && (
        <>
          {launchItems(actions.onLaunchKind, launchers).map((l) => (
            <button
              key={l.id}
              type="button"
              role="menuitem"
              data-menu-item={l.id}
              aria-keyshortcuts={l.shortcut === '⌘T' ? 'Meta+T' : l.shortcut === '⌥⌘T' ? 'Alt+Meta+T' : undefined}
              className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-text hover:bg-hover focus-visible:bg-hover"
              onClick={() => {
                onClose(false)
                l.run()
              }}
            >
              <span className="flex w-4 shrink-0 justify-center">{l.icon}</span>
              <span className="min-w-0 flex-1 truncate">{l.label}</span>
              {l.shortcut && <span className="shrink-0 pl-3 text-[12px] tracking-[0.08em] text-text-3">{l.shortcut}</span>}
            </button>
          ))}
          <div className="my-1 h-px bg-border" role="separator" />
        </>
      )}
      {item('Open project', () => actions.onOpen(row), { disabled: !running })}
      {actions.onChangeIcon && item('Change icon…', actions.onChangeIcon, { hint: actions.changeIconBlocked })}
      {row.container && item(row.pinned ? 'Unpin' : 'Pin to top', () => actions.onTogglePin(row))}
      {item('Move up', () => actions.onMove(row, -1), { disabled: !canMoveUp })}
      {item('Move down', () => actions.onMove(row, 1), { disabled: !canMoveDown })}
      {row.container &&
        item('Pair phone', () => actions.onNavigate(row, '/settings#tab=pairing'), { disabled: !running })}
      {row.container && item('Project settings', () => actions.onNavigate(row, '/settings'), { disabled: !running })}
      <div className="my-1 h-px bg-border" role="separator" />
      {row.stack.running
        ? item(busy ? 'Stopping…' : 'Stop stack…', () => actions.onStop(row), { disabled: busy })
        : item(busy ? 'Starting…' : 'Start stack', () => actions.onStart(row), { disabled: busy })}
      {actions.onRemove && (
        <>
          <div className="my-1 h-px bg-border" role="separator" />
          <button
            type="button"
            role="menuitem"
            data-menu-item="remove-project"
            disabled={busy}
            className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-danger hover:bg-hover focus-visible:bg-hover disabled:opacity-40"
            onClick={() => {
              onClose(true)
              actions.onRemove?.(row)
            }}
          >
            <Trash2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">Remove project…</span>
          </button>
        </>
      )}
    </div>
  )
}

function ResizeHandle({ width, onResize }: { width: number; onResize: HostSidebarProps['onResize'] }) {
  const frame = useRef<number | null>(null)
  const latest = useRef(width)

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const el = e.currentTarget
    el.setPointerCapture?.(e.pointerId)
    const move = (ev: PointerEvent): void => {
      latest.current = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startW + ev.clientX - startX))
      if (frame.current !== null) return
      // Throttle to one bounds update per animation frame (arch §7.4).
      frame.current = requestAnimationFrame(() => {
        frame.current = null
        onResize(latest.current, false)
      })
    }
    const up = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
      onResize(latest.current, true)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  return (
    // A 6px hit area whose only visible state is a 1px hairline on hover/focus — never a
    // thick accent block (audit host-03b).
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault()
          onResize(width + (e.key === 'ArrowRight' ? 16 : -16), true)
        }
      }}
      className="group absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize outline-none focus-visible:shadow-none"
    >
      <span className="absolute inset-y-0 right-0 w-px bg-transparent transition-colors group-hover:bg-border-strong group-focus-visible:bg-accent" />
    </div>
  )
}

const navItem =
  'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-text-2 hover:bg-hover hover:text-text'

/** The desktop host's persistent left sidebar (arch §7.1), Linear-style: it sits directly on
 *  the canvas (no border), with Needs you / All projects, then every local project as ONE
 *  row (circular avatar, name, attention count, ⋯ menu — design directive D1: the project's
 *  sections live in the portal's own tab bar, never duplicated here), and Help. Selection is
 *  a subtle fill only (D3: no colored left stripes). */
export default function HostSidebar(props: HostSidebarProps) {
  const { rows, total, activeKey, activeSection, width, collapsed } = props
  const navRef = useRef<HTMLElement>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const menuTriggers = useRef(new Map<string, HTMLButtonElement | null>())
  // A native portal view covers the content area whenever a project is open.
  const overView = activeKey !== null

  const totalLabel = totalAttentionLabel(total)

  const icons = props.icons ?? {}
  const iconOf = (row: ProjectRow): ProjectIconValue | null => icons[projectIconKey(row)] ?? null

  // D13 parity: an agent's colour is the portal's canonical slot (one assignment over its
  // project's full roster, carried by the host poller as `palette`). Only an older host
  // poll without it falls back to one collision-free assignment over the sidebar's agents.
  // Projects no longer use colours (D14: user icons).
  const agentPalette = useMemo(
    () => assignPalette(rows.flatMap((r) => (r.live ?? []).slice(0, LIVE_SHOWN_MAX).map((a) => a.alias))),
    [rows]
  )

  // D14 icon picker: which row it is for, and where (inside the sidebar, clear of the native
  // portal view that draws over everything to the sidebar's right).
  const [picker, setPicker] = useState<{ key: string; top: number } | null>(null)
  const rowEls = useRef(new Map<string, HTMLElement | null>())
  const openPicker = (row: ProjectRow): void => {
    const nav = navRef.current
    const el = rowEls.current.get(row.key)
    const navBox = nav?.getBoundingClientRect()
    const rowBox = el?.getBoundingClientRect()
    const below = navBox && rowBox ? rowBox.bottom - navBox.top + 4 : 96
    const height = navBox?.height || 600
    setPicker({ key: row.key, top: Math.max(8, Math.min(below, height - PICKER_HEIGHT - 8)) })
  }
  const closePicker = (restoreFocus: boolean): void => {
    const key = picker?.key
    setPicker(null)
    if (restoreFocus && key) menuTriggers.current.get(key)?.focus()
  }
  const pickerRow = picker ? rows.find((r) => r.key === picker.key) ?? null : null
  const iconBlocked = (row: ProjectRow): string | null => {
    const edit = iconEditability(row)
    return edit.ok ? null : edit.reason
  }

  // One error glyph per STACK, on that stack's first row only (never repeated per project).
  const errorRowKey = new Map<string, string>()
  for (const r of rows) if (!errorRowKey.has(r.stack.project)) errorRowKey.set(r.stack.project, r.key)

  const emptyText = props.dockerDown
    ? props.dockerUnresponsive
      ? 'Docker isn’t responding — quit and reopen Docker Desktop.'
      : 'Docker isn’t running — projects will appear when it starts.'
    : props.loading
      ? 'Loading projects…'
      : 'No projects on this Mac yet.'

  if (collapsed) {
    const railButton =
      'relative flex h-8 w-8 items-center justify-center rounded-md text-text-2 hover:bg-hover hover:text-text'
    return (
      <nav
        ref={navRef}
        aria-label="Orcha projects"
        data-testid="host-sidebar"
        data-collapsed="true"
        style={{ width }}
        className="flex h-full shrink-0 flex-col items-center gap-1 bg-bg py-2"
        onKeyDown={(e) => moveFocus(navRef.current, e)}
      >
        <Tooltip text="Expand sidebar" overView={overView}>
          {(t) => (
            <button type="button" data-nav-item aria-label="Expand sidebar" onClick={props.onToggleCollapsed} className={railButton} {...t}>
              <PanelLeftOpen className="h-4 w-4" />
            </button>
          )}
        </Tooltip>
        {props.onOpenCommandMenu && (
          <Tooltip text="Search and commands (⌘K)" overView={overView}>
            {(t) => (
              <button type="button" data-nav-item aria-label="Command menu" aria-keyshortcuts="Meta+K" onClick={props.onOpenCommandMenu} className={railButton} {...t}>
                <Search className="h-4 w-4" />
              </button>
            )}
          </Tooltip>
        )}
        <Tooltip text={`Needs you — ${totalLabel}`} overView={overView}>
          {(t) => (
            <button
              type="button"
              data-nav-item
              aria-label={`Needs you. ${totalLabel}`}
              aria-current={activeSection === 'needs' ? 'page' : undefined}
              onClick={props.onNeedsYou}
              className={cn(railButton, activeSection === 'needs' && 'bg-selected text-text')}
              {...t}
            >
              <Inbox className="h-4 w-4" />
              {total.count !== null && total.count > 0 && (
                <span className="absolute -right-0.5 -top-0.5 min-w-3.5 rounded-full bg-warning px-1 text-center text-[9px] font-semibold leading-3.5 text-bg tabular-nums">
                  {countText(total.count, false)}
                </span>
              )}
            </button>
          )}
        </Tooltip>
        <Tooltip text="All projects" overView={overView}>
          {(t) => (
            <button
              type="button"
              data-nav-item
              aria-label="All projects"
              aria-current={props.managerActive ? 'page' : undefined}
              onClick={props.onShowManager}
              className={cn(railButton, props.managerActive && 'bg-selected text-text')}
              {...t}
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
          )}
        </Tooltip>
        <div className="my-1 h-px w-6 bg-border" />
        {/* pt/px: room for the count badges, which sit just outside each 32px button — a scroll
            container clips on both axes, so without it the FIRST row's badge lost its top */}
        <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto overflow-x-hidden px-1.5 pt-1.5">
          {rows.map((row) => {
            const railError = errorRowKey.get(row.stack.project) === row.key ? props.errors[row.stack.project] : null
            const tip = `${row.name} · ${stateWord(row)}${row.attention ? ` · ${row.attention}${row.partial ? '+' : ''} waiting` : ''}${
              row.liveTotal > 0 ? ` · ${row.liveTotal} live agent${row.liveTotal === 1 ? '' : 's'}` : ''
            }${
              railError ? ` · ${errorLine(railError, row.stack.projectShort)}` : ''
            }`
            return (
              <Tooltip key={row.key} text={tip} overView={overView}>
                {(t) => (
                  <button
                    type="button"
                    data-nav-item
                    aria-label={`${row.name}, ${stateWord(row)}${row.key === activeKey ? ' (open)' : ''}. ${attentionLabel(row)}${
                      railError ? `. ${errorLine(railError, row.stack.projectShort)}` : ''
                    }`}
                    aria-current={row.key === activeKey ? 'page' : undefined}
                    disabled={!row.stack.running || row.stack.apiPort === null}
                    onClick={() => props.onOpen(row)}
                    className={cn(
                      'relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-hover disabled:cursor-default',
                      row.key === activeKey && 'bg-selected'
                    )}
                    {...t}
                  >
                    <ProjectIcon
                      icon={iconOf(row)}
                      size={24}
                      status={railError ? 'error' : avatarStatus(row)}
                      dim={row.state === 'stopped'}
                      ring={row.key === activeKey ? 'var(--color-selected)' : 'var(--color-bg)'}
                    />
                    {row.attention !== null && row.attention > 0 && (
                      <span
                        aria-hidden="true"
                        className="absolute -right-0.5 -top-0.5 min-w-3.5 rounded-full bg-warning px-1 text-center text-[9px] font-semibold leading-3.5 text-bg tabular-nums"
                      >
                        {countText(row.attention, false)}
                      </span>
                    )}
                  </button>
                )}
              </Tooltip>
            )
          })}
          <Tooltip text="Add project" overView={overView}>
            {(t) => (
              <button type="button" data-nav-item aria-label="Add project" onClick={props.onAddProject} className={railButton} {...t}>
                <Plus className="h-4 w-4" />
              </button>
            )}
          </Tooltip>
        </div>
        {props.usageSlot}
        {props.onOpenSettings && (
          <Tooltip text="Settings (⌘,)" overView={overView}>
            {(t) => (
              <button
                type="button"
                data-nav-item
                aria-label="Settings"
                aria-current={props.settingsActive ? 'page' : undefined}
                onClick={props.onOpenSettings}
                className={cn(railButton, props.settingsActive && 'bg-selected text-text')}
                {...t}
              >
                <Settings2 className="h-4 w-4" />
              </button>
            )}
          </Tooltip>
        )}
        <Tooltip text="Help & docs" overView={overView}>
          {(t) => (
            <button type="button" data-nav-item aria-label="Help" onClick={props.onHelp} className={railButton} {...t}>
              <CircleHelp className="h-4 w-4" />
            </button>
          )}
        </Tooltip>
      </nav>
    )
  }

  return (
    <nav
      ref={navRef}
      aria-label="Orcha projects"
      data-testid="host-sidebar"
      style={{ width }}
      className="relative flex h-full shrink-0 flex-col bg-bg text-text"
      onKeyDown={(e) => moveFocus(navRef.current, e)}
    >
      <div className="flex h-12 shrink-0 items-center gap-2 pl-4 pr-2">
        <OrchaMark size={18} className="shrink-0" />
        <span className="text-[14px] font-semibold tracking-tight">Embodent</span>
        <button
          type="button"
          data-nav-item
          aria-label="Collapse sidebar"
          title="Collapse sidebar"
          onClick={props.onToggleCollapsed}
          className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-text-3 hover:bg-hover hover:text-text"
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>

      {props.onOpenCommandMenu && (
        <div className="px-2 pb-2">
          <button
            type="button"
            data-nav-item
            data-testid="open-command-menu"
            aria-label="Search and commands"
            aria-keyshortcuts="Meta+K"
            onClick={props.onOpenCommandMenu}
            className="flex h-8 w-full items-center gap-2 rounded-md border border-border bg-card/60 px-2.5 text-[13px] text-text-3 hover:border-border-strong hover:bg-hover hover:text-text-2"
          >
            <Search className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1 truncate text-left">Search or run…</span>
            <kbd className="shrink-0 rounded border border-border-strong px-1 font-sans text-[10.5px] leading-4 text-text-3">⌘K</kbd>
          </button>
        </div>
      )}

      <div className="flex flex-col gap-px px-2">
        <button
          type="button"
          data-nav-item
          onClick={props.onNeedsYou}
          aria-current={activeSection === 'needs' ? 'page' : undefined}
          title={totalLabel}
          className={cn(navItem, activeSection === 'needs' && 'bg-selected text-text')}
        >
          <Inbox className="h-4 w-4 shrink-0" />
          <span>Needs you</span>
          <Count count={total.count} partial={total.partial} label={totalLabel} />
        </button>
        <button
          type="button"
          data-nav-item
          aria-current={props.managerActive ? 'page' : undefined}
          onClick={props.onShowManager}
          className={cn(navItem, props.managerActive && 'bg-selected text-text')}
        >
          <LayoutGrid className="h-4 w-4 shrink-0" />
          <span>All projects</span>
        </button>
      </div>

      <div className="mt-4 flex h-7 items-center pl-4 pr-2">
        <span className="text-xs font-medium text-text-3">Projects</span>
        <button
          type="button"
          data-nav-item
          aria-label="Add project"
          title="Add project"
          onClick={props.onAddProject}
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-text-3 hover:bg-hover hover:text-text"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <ul className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 pb-3 pt-0.5" aria-label="Projects">
        {rows.length === 0 && <li className="px-2 py-1.5 text-xs leading-relaxed text-text-3">{emptyText}</li>}
        {rows.map((row, index) => {
          const isActive = row.key === activeKey
          const busy = props.busy[row.stack.project] === true
          const error = errorRowKey.get(row.stack.project) === row.key ? props.errors[row.stack.project] : null
          const menuOpen = menuFor === row.key
          const rowSessions = props.sessions?.byRow.get(row.key)
          const tree = buildProjectTree(row, rowSessions)
          const holdsActiveSession = !!props.activeSessionKey && !!rowSessions?.all.some((t) => t.key === props.activeSessionKey)
          const open = tree.hasChildren && isExpanded(props.agentsExpanded ?? {}, row.key, isActive || holdsActiveSession)
          const runningSessions = liveCount(rowSessions?.all)
          const sessionRow = (tab: TermTab, level: 1 | 2) =>
            props.sessionActions ? (
              <SessionRow
                key={tab.key}
                tab={tab}
                indent={INDENT_BASE + level * INDENT_STEP}
                active={tab.key === props.activeSessionKey}
                actions={props.sessionActions}
              />
            ) : null
          const childrenId = `project-tree-${row.key}`
          const toggle = (next: boolean): void => {
            if (tree.hasChildren && next !== open) props.onToggleAgents?.(row, next)
          }
          const agentRow = (a: HostLiveAgent, level: 1 | 2) => (
            <li key={a.alias}>
              <button
                type="button"
                data-nav-item
                data-testid="live-agent"
                title={agentTooltip(a)}
                aria-label={agentTooltip(a)}
                onClick={() => props.onNavigate(row, `/agents?agent=${encodeURIComponent(a.alias)}`)}
                style={{ paddingLeft: INDENT_BASE + level * INDENT_STEP }}
                className="flex h-8 w-full min-w-0 items-center gap-1.5 rounded-md pr-2 text-left text-[13px] hover:bg-hover"
              >
                <AgentStateGlyph state={a.state} />
                <AgentAvatar alias={a.alias} palette={a.palette ?? agentPalette.get(a.alias)} className="ml-0.5" />
                <span className="min-w-0 shrink-0 truncate text-text-2" style={{ maxWidth: '40%' }}>
                  {a.alias}
                </span>
                <span className="min-w-0 flex-1 truncate text-text-3">
                  <span aria-hidden="true"> - </span>
                  {agentFragment(a)}
                </span>
                {shortAgo(a.lastActive) && (
                  <span className="shrink-0 pl-1 text-[12px] tabular-nums text-text-3">{shortAgo(a.lastActive)}</span>
                )}
              </button>
            </li>
          )
          return (
            <li
              key={row.key}
              className="relative"
              ref={(el) => {
                rowEls.current.set(row.key, el)
              }}
            >
              <div
                className={cn(
                  'group relative flex h-8 items-center rounded-md pr-1 hover:bg-hover focus-within:bg-hover',
                  isActive && 'bg-selected hover:bg-selected focus-within:bg-selected'
                )}
              >
                {/* The caret gutter: always 20px wide so every project's icon lines up; the
                    caret itself shows whenever the project has children (D14). */}
                <span className="flex w-5 shrink-0 justify-center pl-0.5">
                  {tree.hasChildren && (
                    <button
                      type="button"
                      data-testid="project-caret"
                      aria-expanded={open}
                      aria-controls={open ? childrenId : undefined}
                      aria-label={`${open ? 'Collapse' : 'Expand'} ${row.name}`}
                      onClick={() => toggle(!open)}
                      className="flex h-6 w-4 items-center justify-center rounded text-text-3 hover:text-text"
                    >
                      <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} aria-hidden="true" />
                    </button>
                  )}
                </span>
                <button
                  type="button"
                  data-nav-item
                  aria-current={isActive ? 'true' : undefined}
                  aria-expanded={tree.hasChildren ? open : undefined}
                  disabled={!row.stack.running || row.stack.apiPort === null}
                  onClick={() => props.onOpen(row)}
                  onKeyDown={(e) => {
                    // Tree keys: → expands, ← collapses (↑/↓ move between rows).
                    if (e.key === 'ArrowRight' && tree.hasChildren && !open) {
                      e.preventDefault()
                      toggle(true)
                    } else if (e.key === 'ArrowLeft' && open) {
                      e.preventDefault()
                      toggle(false)
                    }
                  }}
                  aria-label={`${row.name}, ${stateWord(row)}${row.pinned ? ', pinned' : ''}. ${attentionLabel(row)}`}
                  title={`${row.name}${row.container ? ` · stack ${row.stack.projectShort}` : ''}`}
                  className="flex h-full min-w-0 flex-1 items-center gap-2 pl-1 text-left disabled:cursor-default"
                >
                  <ProjectIcon
                    icon={iconOf(row)}
                    size={20}
                    status={avatarStatus(row)}
                    dim={row.state === 'stopped'}
                    ring={isActive ? 'var(--color-selected)' : 'var(--color-bg)'}
                  />
                  <span
                    className={cn(
                      'truncate text-[14px] font-semibold tracking-[-0.005em]',
                      row.state === 'stopped' || row.containerStatus ? 'text-text-3' : 'text-text'
                    )}
                  >
                    {row.name}
                  </span>
                  {!open && runningSessions > 0 && (
                    <span
                      data-testid="session-count"
                      title={`${runningSessions} terminal session${runningSessions === 1 ? '' : 's'} running`}
                      aria-label={`${runningSessions} terminal session${runningSessions === 1 ? '' : 's'} running`}
                      className="flex shrink-0 items-center gap-0.5 rounded-full border border-border-strong px-1.5 text-[11px] leading-4 tabular-nums text-text-2"
                    >
                      <SquareTerminal className="h-3 w-3" aria-hidden="true" />
                      {runningSessions}
                    </span>
                  )}
                  {busy ? (
                    <span className="shrink-0 text-xs text-text-3">{row.stack.running ? 'stopping…' : 'starting…'}</span>
                  ) : row.state !== 'running' || row.containerStatus ? (
                    <span className="shrink-0 text-xs text-text-3">
                      {row.state === 'stopped' ? 'stopped' : row.state === 'starting' ? 'starting…' : row.containerStatus}
                    </span>
                  ) : null}
                  {row.attention === null && row.state === 'running' && !row.containerStatus && row.unavailableReason?.startsWith('unavailable') ? (
                    <span className="ml-auto flex shrink-0 text-text-3" title={attentionLabel(row)} data-testid="attention-unknown">
                      <CircleDashed className="h-3 w-3" aria-hidden="true" />
                    </span>
                  ) : (
                    <Count count={row.attention} partial={row.partial} label={attentionLabel(row)} />
                  )}
                </button>
                {error != null && (
                  <button
                    type="button"
                    data-testid="sidebar-error"
                    aria-label={`${errorLine(error, row.stack.projectShort)}. Show details`}
                    title={errorLine(error, row.stack.projectShort)}
                    onClick={() => props.onShowError?.(row)}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-danger hover:bg-border"
                  >
                    <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                )}
                <button
                  type="button"
                  data-testid="project-menu"
                  ref={(el) => {
                    menuTriggers.current.set(row.key, el)
                  }}
                  aria-label={`More actions for ${row.name}`}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuFor((k) => (k === row.key ? null : row.key))}
                  className={cn(
                    'ml-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-2 opacity-0 hover:bg-border hover:text-text focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100',
                    (menuOpen || picker?.key === row.key) && 'opacity-100'
                  )}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
                {menuOpen && (
                  <RowMenu
                    row={row}
                    canMoveUp={index > 0}
                    canMoveDown={index < rows.length - 1}
                    busy={busy}
                    onClose={(restore) => {
                      setMenuFor(null)
                      if (restore) menuTriggers.current.get(row.key)?.focus()
                    }}
                    actions={{
                      ...props,
                      onLaunchKind: props.onLaunch ? (kind) => props.onLaunch?.(row, kind, null) : undefined,
                      onChangeIcon: props.onSetIcon ? () => openPicker(row) : undefined,
                      changeIconBlocked: iconBlocked(row)
                    }}
                  />
                )}
              </div>
              {props.iconError?.key === row.key && (
                <div
                  role="alert"
                  data-testid="icon-error"
                  className="mx-1 mb-1 mt-0.5 flex items-start gap-1.5 rounded-md bg-raised px-2 py-1.5 text-[12px] leading-4 text-text-2"
                >
                  <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0 text-danger" aria-hidden="true" />
                  <span className="min-w-0 flex-1">{props.iconError.message}</span>
                  {props.onDismissIconError && (
                    <button
                      type="button"
                      aria-label="Dismiss"
                      onClick={props.onDismissIconError}
                      className="-my-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-3 hover:bg-hover hover:text-text"
                    >
                      <X className="h-3 w-3" aria-hidden="true" />
                    </button>
                  )}
                </div>
              )}
              {open && (
                <ul id={childrenId} aria-label={`${row.name} branches, agents and terminals`} className="mt-0.5 flex flex-col gap-0.5">
                  {tree.checkouts.map(({ checkout, agents, sessions }) => {
                    const current = !!props.activeSessionKey && sessions.some((t) => t.key === props.activeSessionKey)
                    return (
                      <li
                        key={checkout.branch}
                        data-testid="checkout"
                        data-current={current ? 'true' : undefined}
                        aria-label={checkoutLabel(checkout)}
                        className={cn(
                          'rounded-[10px] border border-transparent',
                          // Orca: the branch group of the session on screen sits in a subtle card.
                          current && 'border-border-strong bg-raised'
                        )}
                      >
                        <CheckoutHeader
                          checkout={checkout}
                          onLaunch={props.onLaunch ? (kind) => props.onLaunch?.(row, kind, checkout.primary ? null : checkout.branch) : undefined}
                        />
                        {(agents.length > 0 || sessions.length > 0) && (
                          <ul aria-label={`On ${checkout.branch}`} className="flex flex-col">
                            {agents.map((a) => agentRow(a, 2))}
                            {sessions.map((t) => sessionRow(t, 2))}
                          </ul>
                        )}
                      </li>
                    )
                  })}
                  {(tree.loose.length > 0 || tree.looseSessions.length > 0) && (
                    <li>
                      <ul aria-label={`Live agents and terminals in ${row.name}`} className="flex flex-col">
                        {tree.loose.map((a) => agentRow(a, 1))}
                        {tree.looseSessions.map((t) => sessionRow(t, 1))}
                      </ul>
                    </li>
                  )}
                  {tree.more > 0 && (
                    <li>
                      <button
                        type="button"
                        data-nav-item
                        data-testid="live-agents-more"
                        onClick={() => props.onNavigate(row, '/agents')}
                        style={{ paddingLeft: INDENT_BASE + INDENT_STEP }}
                        className="flex h-7 w-full items-center rounded-md pr-2 text-left text-[12px] text-text-3 hover:bg-hover hover:text-text"
                      >
                        +{tree.more} more
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </li>
          )
        })}
        {props.sessionActions && (props.sessions?.unplaced.length ?? 0) > 0 && (
          <li data-testid="local-sessions">
            <div className="flex h-8 items-center gap-2 pl-6 pr-2 text-[13px] font-semibold text-text-2">
              <SquareTerminal className="h-4 w-4 shrink-0 text-text-3" aria-hidden="true" />
              <span>This Mac</span>
            </div>
            <ul aria-label="Terminals in your home folder" className="flex flex-col">
              {props.sessions?.unplaced.map((tab) => (
                <SessionRow
                  key={tab.key}
                  tab={tab}
                  indent={INDENT_BASE + INDENT_STEP}
                  active={tab.key === props.activeSessionKey}
                  actions={props.sessionActions as SessionActions}
                />
              ))}
            </ul>
          </li>
        )}
      </ul>

      {picker && pickerRow && props.onSetIcon && (
        <IconPicker
          label={`Change icon for ${pickerRow.name}`}
          value={iconOf(pickerRow)}
          suggestion={props.iconOffer?.(pickerRow) ?? null}
          recents={props.emojiRecents ?? []}
          onPick={(icon, done) => {
            props.onSetIcon?.(pickerRow, icon)
            if (done) closePicker(true)
          }}
          onReset={() => {
            props.onSetIcon?.(pickerRow, null)
            closePicker(true)
          }}
          onClose={() => closePicker(true)}
          className="absolute left-2 right-2 z-30"
          style={{ top: picker.top, maxHeight: PICKER_HEIGHT }}
        />
      )}

      <div className="flex shrink-0 flex-col gap-px p-2">
        {props.usageSlot}
        {activeKey !== null && (
          <button
            type="button"
            data-nav-item
            aria-current={activeSection === 'settings' ? 'page' : undefined}
            onClick={() => {
              const row = rows.find((r) => r.key === activeKey)
              if (row) props.onNavigate(row, '/settings')
            }}
            className={cn(navItem, activeSection === 'settings' && 'bg-selected text-text')}
          >
            <Settings className="h-4 w-4 shrink-0" /> Project settings
          </button>
        )}
        {props.onOpenSettings && (
          <button
            type="button"
            data-nav-item
            data-testid="sidebar-settings"
            aria-current={props.settingsActive ? 'page' : undefined}
            onClick={props.onOpenSettings}
            className={cn(navItem, props.settingsActive && 'bg-selected text-text')}
          >
            <Settings2 className="h-4 w-4 shrink-0" /> Settings
            <kbd aria-hidden="true" className="ml-auto font-sans text-[11px] text-text-3">⌘,</kbd>
          </button>
        )}
        <button type="button" data-nav-item onClick={props.onHelp} className={navItem}>
          <CircleHelp className="h-4 w-4 shrink-0" /> Help &amp; docs
        </button>
      </div>

      <ResizeHandle width={width} onResize={props.onResize} />
    </nav>
  )
}
