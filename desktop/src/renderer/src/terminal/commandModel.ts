/** Command menu model — pure (commandMenu.test.ts): item filtering/ranking, section order,
 *  keyboard navigation and the host-level shortcut map. */

export type CommandSection = 'actions' | 'tabs' | 'projects'

export const SECTION_LABEL: Record<CommandSection, string> = {
  actions: 'Actions',
  tabs: 'Open tabs',
  projects: 'Projects'
}

const SECTION_ORDER: CommandSection[] = ['actions', 'tabs', 'projects']

export interface CommandItem {
  id: string
  section: CommandSection
  label: string
  /** Muted secondary text (tab status, project state). */
  hint?: string
  /** Extra words that match the query but aren't shown. */
  keywords?: string
  /** Display-only key caps, e.g. ['⌘', 'T']. */
  shortcut?: string[]
  icon?: string
  disabled?: boolean
  /** Destructive action (e.g. "Remove project…"): rendered in the danger colour. */
  danger?: boolean
}

function norm(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
}

/** Rank one item against a query: 0 = no match; higher = better. Every query word must match
 *  somewhere (label, hint or keywords); a label prefix beats a word start beats a substring. */
export function scoreItem(item: CommandItem, query: string): number {
  const words = norm(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return 1
  const label = norm(item.label)
  const hay = `${label} ${norm(item.hint ?? '')} ${norm(item.keywords ?? '')}`
  let score = 0
  for (const w of words) {
    if (label.startsWith(w)) score += 30
    else if (new RegExp(`(^|[\\s·/_.\\-])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(label)) score += 20
    else if (label.includes(w)) score += 10
    else if (hay.includes(w)) score += 4
    else return 0
  }
  return score
}

export interface CommandGroup {
  section: CommandSection
  items: CommandItem[]
}

/** Filter + group: sections keep a fixed order (Actions, Open tabs, Projects); within a
 *  section a query ranks by score (stable for ties), an empty query keeps the given order. */
export function filterCommands(items: CommandItem[], query: string): CommandGroup[] {
  const q = query.trim()
  const groups: CommandGroup[] = []
  for (const section of SECTION_ORDER) {
    const scored = items
      .map((item, i) => ({ item, i, s: item.section === section ? scoreItem(item, q) : 0 }))
      .filter((x) => x.s > 0)
    if (q) scored.sort((a, b) => b.s - a.s || a.i - b.i)
    if (scored.length) groups.push({ section, items: scored.map((x) => x.item) })
  }
  return groups
}

/** The selectable items in display order (disabled ones are skipped by the keyboard). */
export function flatSelectable(groups: CommandGroup[]): CommandItem[] {
  return groups.flatMap((g) => g.items).filter((i) => !i.disabled)
}

/** Arrow/Home/End navigation over the selectable list, wrapping at the ends. */
export function moveSelection(
  ids: string[],
  current: string | null,
  key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'
): string | null {
  if (ids.length === 0) return null
  if (key === 'Home') return ids[0]
  if (key === 'End') return ids[ids.length - 1]
  const i = current === null ? -1 : ids.indexOf(current)
  if (key === 'ArrowDown') return ids[(i + 1) % ids.length]
  return ids[i <= 0 ? ids.length - 1 : i - 1]
}

export type HostShortcut = { type: 'command-menu' } | { type: 'tab-index'; index: number }

export interface KeyLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/** Host-renderer shortcuts (the menu bar owns ⌘T / ⌥⌘T / ⌘W / ⌃`, so they work over the
 *  portal view too): ⌘K opens the command menu, ⌘1…⌘9 switch terminal tabs. Nothing else is
 *  claimed — every other key reaches the terminal or the focused input untouched. */
export function matchHostShortcut(e: KeyLike, isMac = true): HostShortcut | null {
  const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!mod || e.altKey || e.shiftKey) return null
  if (e.key.toLowerCase() === 'k') return { type: 'command-menu' }
  if (/^[1-9]$/.test(e.key)) return { type: 'tab-index', index: Number(e.key) - 1 }
  return null
}

/** Should xterm ignore this key (so it bubbles to the host / menu bar instead of being sent
 *  to the shell)? Exactly the host shortcuts plus the menu-bar terminal accelerators. */
export function terminalShouldSkip(e: KeyLike, isMac = true): boolean {
  if (matchHostShortcut(e, isMac)) return true
  const mod = isMac ? e.metaKey : e.ctrlKey && e.shiftKey
  if (!mod) return false
  const k = e.key.toLowerCase()
  return k === 't' || k === 'w' || k === 'n'
}
