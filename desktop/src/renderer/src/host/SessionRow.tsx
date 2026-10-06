import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { Bell, CircleCheck, MoreHorizontal, Pin } from 'lucide-react'
import { cn } from '../ui/cn'
import { KindIcon } from '../terminal/KindIcon'
import type { TermKind } from '../../../shared/terminal'
import { agentShortLabel, LEGACY_AGENTS, type AgentId } from '../../../shared/agents'
import type { TermTab } from '../terminal/termTabs'
import { TabMenu, type TabMenuActions } from '../terminal/TabMenu'
import { tabColorCss, tabColorName } from '../terminal/tabColors'
import { sessionAgo, sessionLabel, sessionSnippet, sessionStatus, sessionTitle, type SessionStatus } from '../terminal/sessions'

/** Session status glyph (14px, decorative — the row's accessible name says it in words):
 *  running = a slow rotating arc (static under reduced motion), waiting for input = amber
 *  bell, an agent's finished turn = green circle-check, exited 0 = green check ring, exited
 *  non-zero / failed / turn error = red x ring. */
export function SessionGlyph({ status }: { status: SessionStatus }) {
  const common = { width: 14, height: 14, viewBox: '0 0 14 14', 'aria-hidden': true as const, 'data-session-glyph': status }
  if (status === 'attention') return <Bell aria-hidden="true" data-session-glyph="attention" className="h-3.5 w-3.5 shrink-0 fill-warning text-warning" />
  if (status === 'done') {
    return <CircleCheck aria-hidden="true" data-session-glyph="done" strokeWidth={2.25} className="h-3.5 w-3.5 shrink-0 text-ok" />
  }
  if (status === 'ok') {
    return (
      <svg {...common} className="shrink-0">
        <circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--color-ok)" strokeWidth="1.3" />
        <path d="M4.6 7.1 6.3 8.7 9.4 5.5" fill="none" stroke="var(--color-ok)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (status === 'error') {
    return (
      <svg {...common} className="shrink-0">
        <circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--color-danger)" strokeWidth="1.3" />
        <path d="M5 5 9 9M9 5 5 9" stroke="var(--color-danger)" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    )
  }
  return (
    <svg {...common} className={cn('shrink-0', status === 'running' && 'orcha-spin')}>
      <circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--color-border-strong)" strokeWidth="1.3" />
      {status === 'running' && (
        <path d="M7 1.5 A5.5 5.5 0 0 1 12.5 7" fill="none" stroke="var(--color-text-2)" strokeWidth="1.4" strokeLinecap="round" />
      )}
    </svg>
  )
}

export interface MenuItem {
  id: string
  label: string
  icon?: ReactNode
  /** Right-aligned shortcut hint, Orca-style ("⌘T"). */
  shortcut?: string
  disabled?: boolean
  danger?: boolean
  run(): void
}

/** A small popover menu anchored inside the sidebar (never under the native portal view).
 *  Sections are separated by a hairline; ↑/↓ move (a `data-menu-row` group such as the tab
 *  colour swatches is one stop, ←/→ move inside it), Home/End jump, Escape closes (focus back
 *  to the trigger). `footer` renders after the sections (e.g. the Tab Color row). */
export function PopMenu({
  label,
  sections,
  onClose,
  className,
  style,
  footer
}: {
  label: string
  sections: MenuItem[][]
  onClose(restoreFocus: boolean): void
  className?: string
  style?: CSSProperties
  footer?: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(ITEM_SELECTOR)?.focus()
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeRef.current(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])
  const onKeyDown = (e: ReactKeyboardEvent): void => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? [])
    if (items.length === 0) return
    const current = document.activeElement as HTMLElement
    const i = items.indexOf(current)
    const rowOf = (el: HTMLElement | undefined): Element | null => el?.closest('[data-menu-row]') ?? null
    const focusStop = (el: HTMLElement): void => {
      // Entering a row lands on its checked radio, like a radio group.
      const row = rowOf(el)
      const checked = row?.querySelector<HTMLElement>('[aria-checked="true"]')
      ;(checked ?? el).focus()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose(true)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      const step = e.key === 'ArrowDown' ? 1 : -1
      const row = rowOf(current)
      let j = i < 0 ? (step > 0 ? -1 : items.length) : i
      for (let n = 0; n < items.length; n++) {
        j = (j + step + items.length) % items.length
        if (!row || rowOf(items[j]) !== row) break
      }
      // Moving up into a row: land on the row, not its last swatch.
      const target = items[j]
      const targetRow = rowOf(target)
      focusStop(targetRow ? (targetRow.querySelector<HTMLElement>(ITEM_SELECTOR) ?? target) : target)
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && rowOf(current)) {
      e.preventDefault()
      e.stopPropagation()
      const inRow = Array.from(rowOf(current)!.querySelectorAll<HTMLElement>(ITEM_SELECTOR))
      const k = inRow.indexOf(current)
      inRow[(k + (e.key === 'ArrowRight' ? 1 : -1) + inRow.length) % inRow.length]?.focus()
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      e.stopPropagation()
      focusStop(e.key === 'Home' ? items[0] : items[items.length - 1])
    } else if (e.key === 'Tab') {
      onClose(false)
    }
  }
  const visible = sections.filter((s) => s.length > 0)
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      style={style}
      className={cn(
        'absolute left-2 right-2 top-full z-20 mt-1 rounded-[10px] border border-border-strong bg-raised p-1 shadow-[var(--shadow-pop)]',
        className
      )}
    >
      {visible.map((section, si) => (
        <div key={si} role="group">
          {si > 0 && <div className="my-1 h-px bg-border" role="separator" />}
          {section.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              data-menu-item={item.id}
              disabled={item.disabled}
              aria-keyshortcuts={item.shortcut && item.shortcut !== 'F2' ? shortcutAria(item.shortcut) : item.shortcut}
              onClick={() => {
                onClose(false)
                item.run()
              }}
              className={cn(
                'flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none hover:bg-hover focus-visible:bg-hover disabled:pointer-events-none disabled:opacity-40',
                item.danger ? 'text-danger' : 'text-text'
              )}
            >
              {item.icon && <span className="flex w-4 shrink-0 justify-center">{item.icon}</span>}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.shortcut && <span className="shrink-0 pl-3 text-[12px] tracking-[0.08em] text-text-3">{item.shortcut}</span>}
            </button>
          ))}
        </div>
      ))}
      {footer && (
        <>
          {visible.length > 0 && <div className="my-1 h-px bg-border" role="separator" />}
          {footer}
        </>
      )}
    </div>
  )
}

const ITEM_SELECTOR = '[role="menuitem"]:not([disabled]), [role="menuitemradio"]:not([disabled])'

function shortcutAria(hint: string): string {
  const map: Record<string, string> = { '⌘': 'Meta', '⌥': 'Alt', '⇧': 'Shift', '⌃': 'Control' }
  const parts: string[] = []
  for (const ch of hint) parts.push(map[ch] ?? ch)
  return parts.join('+')
}

/** The Orca "Open" section: launch a full-panel session for a project / branch — a shell,
 *  then the enabled installed agents from Settings › Agents (Default first, on ⌥⌘T). */
export function launchItems(launch: (kind: TermKind) => void, agents: readonly AgentId[] = LEGACY_AGENTS): MenuItem[] {
  return [
    { id: 'open-shell', label: 'New Terminal', shortcut: '⌘T', icon: <KindIcon kind="shell" className="h-3.5 w-3.5" />, run: () => launch('shell') },
    ...agents.map((id, i) => ({
      id: `open-${id}`,
      label: agentShortLabel(id),
      shortcut: i === 0 ? '⌥⌘T' : undefined,
      icon: <KindIcon kind={id} className="h-3.5 w-3.5" />,
      run: () => launch(id)
    }))
  ]
}

export interface SessionActions {
  onOpen(key: string): void
  onRename(key: string, title: string | null): void
  onRestart(key: string): void
  onClose(key: string): void
  /** The Orca tab menu (pin, bulk close, colour) — same menu as the strip tab. Without it the
   *  row keeps its short Rename / Restart / Close menu. */
  tabMenu?: TabMenuActions
}

/** One terminal session in the sidebar tree (Orca): status glyph, kind mark, title " - "
 *  muted snippet, relative time; ⋯ (hover/focus) → Rename, Restart (exited), Close. */
export function SessionRow({
  tab,
  indent,
  active,
  actions,
  now
}: {
  tab: TermTab
  indent: number
  active: boolean
  actions: SessionActions
  now?: number
}) {
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const rowBtn = useRef<HTMLButtonElement>(null)
  const status = sessionStatus(tab)
  const title = sessionTitle(tab)
  const snippet = sessionSnippet(tab)
  const ago = sessionAgo(tab, now)
  const colorName = tab.color ? tabColorName(tab.color) : null
  const label = `${sessionLabel(tab, now)}${tab.pinned ? ' · pinned' : ''}${colorName ? ` · ${colorName}` : ''}`
  const exited = tab.status === 'exited' || tab.status === 'failed'
  const finishRename = (value: string | null): void => {
    setRenaming(false)
    if (value !== null) actions.onRename(tab.key, value)
    requestAnimationFrame(() => rowBtn.current?.focus())
  }
  return (
    <li className="relative">
      <div
        className={cn(
          'group relative flex h-8 items-center rounded-md pr-1 hover:bg-hover focus-within:bg-hover',
          active && 'bg-selected hover:bg-selected focus-within:bg-selected'
        )}
      >
        {renaming ? (
          <div className="flex h-full min-w-0 flex-1 items-center gap-1.5" style={{ paddingLeft: indent }}>
            <SessionGlyph status={status} />
            <KindIcon kind={tab.kind} className="ml-0.5 h-3.5 w-3.5" />
            <input
              autoFocus
              aria-label="Session name"
              defaultValue={tab.customTitle ?? title}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') finishRename(e.currentTarget.value)
                if (e.key === 'Escape') finishRename(null)
              }}
              onBlur={(e) => finishRename(e.currentTarget.value)}
              className="h-6 min-w-0 flex-1 rounded border border-border-strong bg-bg px-1.5 text-[13px] text-text outline-none"
            />
          </div>
        ) : (
          <button
            ref={rowBtn}
            type="button"
            data-nav-item
            data-testid="session-row"
            data-session-key={tab.key}
            aria-current={active ? 'true' : undefined}
            aria-label={label}
            title={label}
            onClick={() => actions.onOpen(tab.key)}
            onKeyDown={(e) => {
              if (e.key === 'F2') {
                e.preventDefault()
                setRenaming(true)
              } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
                e.preventDefault()
                setMenu(true)
              }
            }}
            style={{ paddingLeft: indent }}
            className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left text-[13px]"
          >
            <SessionGlyph status={status} />
            <KindIcon kind={tab.kind} className="ml-0.5 h-3.5 w-3.5" />
            {tab.color && (
              <span
                aria-hidden="true"
                data-testid="session-color"
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: tabColorCss(tab.color) }}
              />
            )}
            <span className={cn('min-w-0 shrink-0 truncate', active ? 'text-text' : 'text-text-2')} style={{ maxWidth: snippet ? '55%' : undefined }}>
              {title}
            </span>
            {snippet && (
              <span className="min-w-0 flex-1 truncate text-text-3" data-testid="session-snippet">
                <span aria-hidden="true"> - </span>
                {snippet}
              </span>
            )}
            {!snippet && <span className="flex-1" />}
            {tab.pinned && (
              <Pin
                aria-hidden="true"
                data-testid="session-pinned"
                className="h-3 w-3 shrink-0 rotate-45 text-text-3 group-focus-within:invisible group-hover:invisible"
              />
            )}
            {ago && (
              <span className="shrink-0 pl-1 pr-1 text-[12px] tabular-nums text-text-3 group-focus-within:invisible group-hover:invisible">
                {ago}
              </span>
            )}
          </button>
        )}
        {!renaming && (
          <button
            ref={trigger}
            type="button"
            data-testid="session-menu"
            aria-label={`More actions for ${title}`}
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu((m) => !m)}
            className={cn(
              'absolute right-1 flex h-6 w-6 items-center justify-center rounded-md text-text-2 opacity-0 hover:bg-border hover:text-text focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100',
              menu && 'opacity-100'
            )}
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        )}
      </div>
      {menu && actions.tabMenu && (
        <TabMenu
          tab={tab}
          actions={{ ...actions.tabMenu, onRestart: actions.onRestart }}
          startRename={() => setRenaming(true)}
          onClose={(restore) => {
            setMenu(false)
            if (restore) trigger.current?.focus()
          }}
        />
      )}
      {menu && !actions.tabMenu && (
        <PopMenu
          label={`Actions for ${title}`}
          onClose={(restore) => {
            setMenu(false)
            if (restore) trigger.current?.focus()
          }}
          sections={[
            [
              { id: 'rename', label: 'Rename…', run: () => setRenaming(true) },
              ...(exited ? [{ id: 'restart', label: 'Restart', run: () => actions.onRestart(tab.key) }] : []),
              { id: 'close', label: exited ? 'Close' : 'Close (ends the process)', danger: !exited, run: () => actions.onClose(tab.key) }
            ]
          ]}
        />
      )}
    </li>
  )
}
