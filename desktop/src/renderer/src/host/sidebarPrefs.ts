/** Host sidebar preferences (local to this Mac — host localStorage, arch §7.4 / §8):
 *  width, collapsed-to-rail, and a local project order. Pinning reuses the home screen's
 *  favorites (`orcha:desktop:favorites`, keyed by container id) so a star on a card and a pin
 *  in the sidebar are the same thing. No backend collaboration semantics. */

export const SIDEBAR_DEFAULT = 272
export const SIDEBAR_MIN = 200
export const SIDEBAR_MAX = 360
export const SIDEBAR_RAIL = 56

const WIDTH_KEY = 'orcha:host:sidebarWidth'
const COLLAPSED_KEY = 'orcha:host:sidebarCollapsed'
const ORDER_KEY = 'orcha:host:projectOrder'

export interface PrefsStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function read(storage: PrefsStorage, key: string): string | null {
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

function write(storage: PrefsStorage, key: string, value: string): void {
  try {
    storage.setItem(key, value)
  } catch {
    // quota / private mode — the preference just doesn't persist
  }
}

export function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)))
}

export function loadWidth(storage: PrefsStorage): number {
  const raw = read(storage, WIDTH_KEY)
  return raw === null ? SIDEBAR_DEFAULT : clampWidth(Number(raw))
}

export function saveWidth(storage: PrefsStorage, width: number): void {
  write(storage, WIDTH_KEY, String(clampWidth(width)))
}

export function loadCollapsed(storage: PrefsStorage): boolean {
  return read(storage, COLLAPSED_KEY) === '1'
}

export function saveCollapsed(storage: PrefsStorage, collapsed: boolean): void {
  write(storage, COLLAPSED_KEY, collapsed ? '1' : '0')
}

export function loadOrder(storage: PrefsStorage): string[] {
  try {
    const parsed: unknown = JSON.parse(read(storage, ORDER_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

export function saveOrder(storage: PrefsStorage, order: string[]): void {
  write(storage, ORDER_KEY, JSON.stringify(order))
}

/** Move `key` one step up (-1) or down (+1) within the CURRENT visible order `keys`,
 *  returning the new full order to persist. No-op at the ends. */
export function moveKey(keys: string[], key: string, delta: -1 | 1): string[] {
  const next = [...keys]
  const i = next.indexOf(key)
  const j = i + delta
  if (i < 0 || j < 0 || j >= next.length) return next
  ;[next[i], next[j]] = [next[j], next[i]]
  return next
}

const EXPANDED_KEY = 'orcha:host:agentsExpanded'

/** D11: per project row (row key), whether its nested live agents are expanded — only the
 *  user's EXPLICIT choices are stored; a row without one uses the default (open project
 *  expanded, others collapsed). */
export function loadExpanded(storage: PrefsStorage): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(read(storage, EXPANDED_KEY) ?? '{}')
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'boolean') out[k] = v
    return out
  } catch {
    return {}
  }
}

export function saveExpanded(storage: PrefsStorage, expanded: Record<string, boolean>): void {
  write(storage, EXPANDED_KEY, JSON.stringify(expanded))
}

/** Whether a row's agents are expanded: the stored choice, else expanded iff it is open. */
export function isExpanded(expanded: Record<string, boolean>, key: string, isActive: boolean): boolean {
  return expanded[key] ?? isActive
}
