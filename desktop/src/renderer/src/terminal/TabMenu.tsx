/** Orca-style terminal tab menu — one menu for the strip tab (right-click, Shift+F10 /
 *  context-menu key), the strip's ⋯ and the sidebar session row's ⋯:
 *    [Restart (exited)] · Pin/Unpin Tab · Close ⌘W / Close Others / To The Right / To The Left
 *    · Change Title F2 · Tab Color (none + nine swatches, a radio group).
 *  Orca's "Move Tab to Split" / "Split terminal" are left out: Orcha has no split view.
 *  ⌘R is deliberately not bound (Electron reload); F2 matches the sidebar rename. */
import type { CSSProperties } from 'react'
import { ArrowLeftToLine, ArrowRightToLine, Ban, ListX, Pencil, Pin, PinOff, RotateCw, X } from 'lucide-react'
import { cn } from '../ui/cn'
import { PopMenu, type MenuItem } from '../host/SessionRow'
import { closeTargets, isLiveTab, type TermTab } from './termTabs'
import { TAB_COLORS, tabColorCss, tabColorName, type TabColor } from './tabColors'

export interface TabMenuActions {
  /** Every tab, in strip order (bulk-close targets are computed from it). */
  tabs: readonly TermTab[]
  onPin(key: string, pinned: boolean): void
  /** Close these tabs — the host asks first when that would end processes / a pinned tab. */
  onCloseTabs(keys: string[]): void
  onColor(key: string, color: TabColor | null): void
  /** Offered for an exited / failed session. */
  onRestart?(key: string): void
}

const ICON = 'h-3.5 w-3.5'

export function tabMenuSections(tab: TermTab, a: TabMenuActions, startRename: () => void): MenuItem[][] {
  const exited = tab.status === 'exited' || tab.status === 'failed'
  const others = closeTargets(a.tabs, tab.key, 'others')
  const right = closeTargets(a.tabs, tab.key, 'right')
  const left = closeTargets(a.tabs, tab.key, 'left')
  return [
    exited && a.onRestart
      ? [{ id: 'restart', label: 'Restart', icon: <RotateCw className={ICON} />, run: () => a.onRestart?.(tab.key) }]
      : [],
    [
      tab.pinned
        ? { id: 'unpin', label: 'Unpin Tab', icon: <PinOff className={ICON} />, run: () => a.onPin(tab.key, false) }
        : { id: 'pin', label: 'Pin Tab', icon: <Pin className={ICON} />, run: () => a.onPin(tab.key, true) }
    ],
    [
      { id: 'close', label: 'Close', shortcut: '⌘W', icon: <X className={ICON} />, run: () => a.onCloseTabs([tab.key]) },
      { id: 'close-others', label: 'Close Others', icon: <ListX className={ICON} />, disabled: others.length === 0, run: () => a.onCloseTabs(others) },
      {
        id: 'close-right',
        label: 'Close Tabs To The Right',
        icon: <ArrowRightToLine className={ICON} />,
        disabled: right.length === 0,
        run: () => a.onCloseTabs(right)
      },
      {
        id: 'close-left',
        label: 'Close Tabs To The Left',
        icon: <ArrowLeftToLine className={ICON} />,
        disabled: left.length === 0,
        run: () => a.onCloseTabs(left)
      }
    ],
    [{ id: 'rename', label: 'Change Title', shortcut: 'F2', icon: <Pencil className={ICON} />, run: startRename }]
  ]
}

/** "Tab Color": none + nine swatches as menuitemradio buttons (one ↑/↓ stop, ←/→ inside). */
export function TabColorRow({ tab, onColor, onPicked }: { tab: TermTab; onColor(color: TabColor | null): void; onPicked(): void }) {
  const pick = (c: TabColor | null): void => {
    onPicked()
    onColor(c)
  }
  const swatch = 'flex aspect-square min-w-0 max-w-[18px] flex-1 items-center justify-center rounded-full outline-none'
  const ring = (on: boolean): string =>
    on ? 'ring-2 ring-text/80 ring-offset-2 ring-offset-raised' : 'hover:ring-2 hover:ring-border-strong focus-visible:ring-2 focus-visible:ring-text/60'
  return (
    <div className="px-2 pb-1.5 pt-1">
      <div id={`tab-color-${tab.key}`} className="pb-1.5 text-[12px] text-text-3">
        Tab Color
      </div>
      <div role="group" aria-labelledby={`tab-color-${tab.key}`} data-menu-row="tab-color" className="flex items-center gap-[5px]">
        <button
          type="button"
          role="menuitemradio"
          aria-checked={tab.color === null}
          aria-label="No color"
          title="No color"
          data-swatch="none"
          onClick={() => pick(null)}
          className={cn(swatch, 'border border-border-strong text-text-3', ring(tab.color === null))}
        >
          <Ban className="h-[82%] w-[82%]" strokeWidth={1.6} />
        </button>
        {TAB_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            role="menuitemradio"
            aria-checked={tab.color === c}
            aria-label={tabColorName(c)}
            title={tabColorName(c)}
            data-swatch={c}
            onClick={() => pick(c)}
            className={cn(swatch, ring(tab.color === c))}
            style={{ background: tabColorCss(c) }}
          />
        ))}
      </div>
    </div>
  )
}

/** The whole menu (PopMenu + colour row) for one tab. */
export function TabMenu({
  tab,
  actions,
  startRename,
  onClose,
  className,
  style,
  extra,
  label = 'Tab actions'
}: {
  label?: string
  tab: TermTab
  actions: TabMenuActions
  startRename(): void
  onClose(restoreFocus: boolean): void
  className?: string
  style?: CSSProperties
  /** Sections shown before the tab's own (the strip ⋯ keeps its "Open" launchers). */
  extra?: MenuItem[][]
}) {
  return (
    <PopMenu
      label={label}
      className={className}
      style={style}
      onClose={onClose}
      sections={[...(extra ?? []), ...tabMenuSections(tab, actions, startRename)]}
      footer={<TabColorRow tab={tab} onColor={(c) => actions.onColor(tab.key, c)} onPicked={() => onClose(true)} />}
    />
  )
}

/** What closing `keys` needs confirmed, or null to close straight away:
 *  - several tabs with at least one live process → "Close 3 tabs? Running processes will end."
 *  - any pinned tab → always asked (a pin says "keep this").
 *  A single unpinned tab closes without asking (⌘W, ×), as before. */
export function closePrompt(tabs: readonly TermTab[], keys: readonly string[]): { title: string; body: string; confirm: string } | null {
  const targets = tabs.filter((t) => keys.includes(t.key))
  if (targets.length === 0) return null
  const live = targets.filter(isLiveTab).length
  const pinned = targets.filter((t) => t.pinned).length
  if (targets.length === 1) {
    if (!pinned) return null
    return {
      title: 'Close pinned tab?',
      body: live ? 'This tab is pinned. Its running process will end.' : 'This tab is pinned.',
      confirm: 'Close'
    }
  }
  if (!live && !pinned) return null
  const parts = [live ? 'Running processes will end.' : null, pinned ? `Includes ${pinned === 1 ? 'a pinned tab' : `${pinned} pinned tabs`}.` : null]
  return { title: `Close ${targets.length} tabs?`, body: parts.filter(Boolean).join(' '), confirm: `Close ${targets.length} tabs` }
}
