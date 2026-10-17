/** Pure renderer side of "Remove project…" (removeProject.test.ts): which terminal tabs go,
 *  where the view lands afterwards, the local prefs to forget, and the plain-words labels. */
import type { RemovePhase, RemoveResult } from '../../../shared/types'
import type { ProjectRow } from './projectModel'
import { isLiveTab, type TermTab } from '../terminal/termTabs'

export interface PrefsStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const FAVORITES_KEY = 'orcha:desktop:favorites'
export const ORDER_KEY = 'orcha:host:projectOrder'
export const EXPANDED_KEY = 'orcha:host:agentsExpanded'

/** Every row key and container id that belongs to a compose project. */
export function projectKeys(rows: readonly ProjectRow[], project: string): { keys: string[]; cids: string[] } {
  const mine = rows.filter((r) => r.stack.project === project)
  return {
    keys: mine.map((r) => r.key),
    cids: mine.map((r) => r.container?.id).filter((c): c is string => !!c)
  }
}

/** True for a row key (`<project>` / `<project>:<cid>`) of exactly this project — never a
 *  project whose name merely starts with it (`orcha-acme` vs `orcha-acme-web`). */
export function isProjectKey(key: string, project: string): boolean {
  return key === project || key.startsWith(`${project}:`)
}

/** Terminal tabs opened for the project, and how many still have a live process. */
export function projectTerminals(tabs: readonly TermTab[], project: string): { keys: string[]; live: number } {
  const mine = tabs.filter((t) => t.project === project)
  return { keys: mine.map((t) => t.key), live: mine.filter(isLiveTab).length }
}

/** Where to land when the OPEN project was removed: another project that can open (the
 *  first running one in sidebar order), else null = the home screen. */
export function fallbackAfterRemoval(rows: readonly ProjectRow[], removedProject: string): ProjectRow | null {
  return rows.find((r) => r.stack.project !== removedProject && r.stack.running && r.stack.apiPort !== null) ?? null
}

function readJson(storage: PrefsStore, key: string): unknown {
  try {
    return JSON.parse(storage.getItem(key) ?? 'null')
  } catch {
    return null
  }
}

/** Forget the project's sidebar prefs on this Mac: favourites (container ids), manual order
 *  and expand state (row keys). Returns the updated favourites / order / expanded. */
export function forgetLocalPrefs(
  storage: PrefsStore,
  project: string,
  cids: readonly string[]
): { favorites: Set<string>; order: string[]; expanded: Record<string, boolean> } {
  const favRaw = readJson(storage, FAVORITES_KEY)
  const favorites = (Array.isArray(favRaw) ? favRaw : []).filter((v): v is string => typeof v === 'string' && !cids.includes(v))
  const orderRaw = readJson(storage, ORDER_KEY)
  const order = (Array.isArray(orderRaw) ? orderRaw : []).filter((v): v is string => typeof v === 'string' && !isProjectKey(v, project))
  const expRaw = readJson(storage, EXPANDED_KEY)
  const expanded: Record<string, boolean> = {}
  if (expRaw && typeof expRaw === 'object' && !Array.isArray(expRaw)) {
    for (const [k, v] of Object.entries(expRaw as Record<string, unknown>)) {
      if (typeof v === 'boolean' && !isProjectKey(k, project)) expanded[k] = v
    }
  }
  try {
    storage.setItem(FAVORITES_KEY, JSON.stringify(favorites))
    storage.setItem(ORDER_KEY, JSON.stringify(order))
    storage.setItem(EXPANDED_KEY, JSON.stringify(expanded))
  } catch {
    // private mode — the in-memory state below is still correct for this session
  }
  return { favorites: new Set(favorites), order, expanded }
}

export const PHASE_LABEL: Record<RemovePhase, string> = {
  stopping: 'Stopping…',
  removing: 'Removing…',
  'deleting-data': 'Deleting data…',
  'removing-files': 'Removing files…',
  cleaning: 'Cleaning up…'
}

/** "347 MB" (decimal, like Docker). */
export function formatBytes(n: number | null | undefined): string | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null
  if (n < 1000) return `${n} B`
  const units = ['kB', 'MB', 'GB', 'TB']
  let v = n / 1000
  let i = 0
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000
    i++
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')} ${units[i]}`
}

/** The success toast: one short line of what was done. */
export function removedToast(name: string, r: Pick<RemoveResult, 'dataDeleted' | 'filesRemoved'>): string {
  const what = r.dataDeleted
    ? `Removed ${name} and deleted its data.`
    : `Removed ${name}. Its data is kept — add the folder again to bring it back.`
  const files = r.filesRemoved ? ' Embodent’s files were removed from the folder.' : ''
  return `${what}${files}`
}
