/** D14: user-chosen project icons (emoji or an app glyph + optional colour), replacing the
 *  initials avatars for PROJECTS (agents keep their round avatars, D7).
 *
 *  Store — the portal's per-PROJECT `containers.icon` (mig 050), shared with the portal and
 *  everyone on the project:
 *  - READ from the `icon` field of GET /api/containers, which the host already polls
 *    (loadProjectCards → the validated `portalGet` bridge) — no new call;
 *  - WRITE with PUT /api/containers/{cid}/icon {icon} through the validated `portalPut` bridge
 *    (main does the request: running stack's port only, `/api/…` paths only).
 *  A pick paints optimistically and rolls back when the write fails (403 no permission, 422,
 *  an older portal, or the project can't be reached) — the desktop never keeps a divergent
 *  local value. localStorage is only a READ CACHE of server values (first paint, offline).
 *
 *  One-time migration of the pre-store local-only icons (`orcha:host:projectIcons`): when the
 *  server reports no icon for a project that has one here, the desktop pushes it (it works
 *  when this user may change the icon); if the project refuses (403) the icon is OFFERED in the
 *  picker ("From this Mac") until a write for that project succeeds. The local entry is dropped
 *  once the server has an icon (pushed or someone else's) — server wins.
 *
 *  Emoji recents stay local: a picker convenience, not project data. */
import type { PrefsStorage } from './sidebarPrefs'
import { containerIcon, parseIcon, isEmoji, sameIcon, type ProjectIcon } from '../../../shared/projectIcon'
import type { ProjectContainer, Stack } from '../../../shared/types'

export { GLYPH_NAMES, parseIcon, type GlyphName, type ProjectIcon } from '../../../shared/projectIcon'

/** Pre-store local-only icons (migration source; emptied as projects are migrated). */
export const LEGACY_ICONS_KEY = 'orcha:host:projectIcons'
/** Read cache of the server's icons: `{ [cid]: icon | null }` (null = the server has none). */
export const ICON_CACHE_KEY = 'orcha:host:projectIconCache'
const RECENTS_KEY = 'orcha:host:emojiRecents'
export const RECENTS_MAX = 16

export function projectIconKey(row: { container: { id: string } | null; stack: { project: string } }): string {
  return row.container ? row.container.id : `stack:${row.stack.project}`
}

function readJson(storage: PrefsStorage, key: string): unknown {
  try {
    return JSON.parse(storage.getItem(key) ?? 'null')
  } catch {
    return null
  }
}

function writeJson(storage: PrefsStorage, key: string, value: unknown): void {
  try {
    storage.setItem(key, JSON.stringify(value))
  } catch {
    // quota / private mode — the cache just doesn't persist
  }
}

function dropKey(storage: PrefsStorage, key: string): void {
  try {
    const remove = (storage as { removeItem?: (k: string) => void }).removeItem
    if (remove) remove.call(storage, key)
    else if (storage.getItem(key) !== null) storage.setItem(key, '{}')
  } catch {
    // private mode
  }
}

function readMap(storage: PrefsStorage, key: string, allowNull: boolean): Record<string, ProjectIcon | null> {
  const raw = readJson(storage, key)
  const out: Record<string, ProjectIcon | null> = {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('stack:')) continue // never writable (no container id) — dropped
    if (v === null && allowNull) out[k] = null
    else {
      const icon = parseIcon(v)
      if (icon) out[k] = icon
    }
  }
  return out
}

/** The pre-store local map, validated (never trust storage). */
export function loadLegacyIcons(storage: PrefsStorage): Record<string, ProjectIcon> {
  return readMap(storage, LEGACY_ICONS_KEY, false) as Record<string, ProjectIcon>
}

// ---- writes: availability + errors ----------------------------------------------------------

export interface IconTarget {
  cid: string
  apiPort: number
}

export type IconEditability = { ok: true; target: IconTarget } | { ok: false; reason: string }

export const UNREACHABLE_REASON = "Can't reach this project — start it to change its icon"
export const UNSUPPORTED_REASON = "This project's Orcha is too old for shared icons — update it to change the icon"

/** Whether "Change icon…" can write for a row, else the reason it's disabled. A stopped or
 *  unreachable stack can't store the icon, and the desktop never keeps a local-only one. */
export function iconEditability(row: { container: ProjectContainer | null; stack: Stack }): IconEditability {
  if (!row.container || !row.stack.running || row.stack.apiPort === null) return { ok: false, reason: UNREACHABLE_REASON }
  if (row.container.icon === undefined) return { ok: false, reason: UNSUPPORTED_REASON }
  return { ok: true, target: { cid: row.container.id, apiPort: row.stack.apiPort } }
}

export type IconFailure = 'permission' | 'invalid' | 'unsupported' | 'unreachable'
export type IconWriteResult = { ok: true } | { ok: false; failure: IconFailure; message: string }

/** Map a bridge rejection ({code, status}) to a clear, user-facing reason. */
export function iconWriteFailure(err: unknown): { failure: IconFailure; message: string } {
  const e = (typeof err === 'object' && err !== null ? err : {}) as { code?: unknown; status?: unknown }
  if (e.code === 'PORTAL_REQUEST_FAILED') {
    if (e.status === 401 || e.status === 403) {
      return { failure: 'permission', message: "You don't have permission to change this project's icon" }
    }
    if (e.status === 422 || e.status === 400) return { failure: 'invalid', message: 'The project rejected this icon' }
    if (e.status === 404 || e.status === 405) return { failure: 'unsupported', message: UNSUPPORTED_REASON }
  }
  return { failure: 'unreachable', message: "Couldn't reach this project — the icon wasn't changed" }
}

// ---- the store --------------------------------------------------------------------------------

export type PortalPut = (apiPort: number, path: string, body: unknown) => Promise<unknown>

/** One row of the host's container poll, for applyServer. `icon` undefined = older portal. */
export interface ServerIconRow {
  cid: string
  apiPort: number
  icon: ProjectIcon | null | undefined
}

export class ProjectIconStore {
  private cache: Record<string, ProjectIcon | null>
  private legacy: Record<string, ProjectIcon>
  /** cid → writes in flight (oldest first); the newest is what the row shows meanwhile. */
  private inflight = new Map<string, Array<{ id: number; icon: ProjectIcon | null }>>()
  /** cids whose migration push was refused (no permission) — offered in the picker instead. */
  private refused = new Set<string>()
  private migrating = new Set<string>()
  private listeners = new Set<() => void>()
  private seq = 0
  private view: Record<string, ProjectIcon> = {}

  constructor(
    private storage: PrefsStorage,
    private put: PortalPut
  ) {
    this.cache = readMap(storage, ICON_CACHE_KEY, true)
    this.legacy = loadLegacyIcons(storage)
    this.rebuild()
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  /** What every surface shows, by projectIconKey. Stable identity between changes. */
  icons = (): Record<string, ProjectIcon> => this.view

  /** The pre-store icon picked on this Mac, offered when pushing it was refused. */
  offer(cid: string): ProjectIcon | null {
    return this.refused.has(cid) ? (this.legacy[cid] ?? null) : null
  }

  /** SERVER WINS: fold the polled `icon` of every container row into the cache. Rows without
   *  the field (older portal) and cids with a write in flight are skipped. Starts the one-time
   *  migration for a cid the server has no icon for but this Mac does. */
  applyServer(rows: ServerIconRow[]): void {
    let changed = false
    for (const row of rows) {
      if (row.icon === undefined || this.inflight.get(row.cid)?.length) continue
      if (row.icon && this.legacy[row.cid]) {
        delete this.legacy[row.cid] // the project already has an icon — ours is superseded
        this.refused.delete(row.cid)
        changed = true
      }
      if (!(row.cid in this.cache) || !sameIcon(this.cache[row.cid], row.icon)) {
        this.cache[row.cid] = row.icon
        changed = true
      }
      const mine = this.legacy[row.cid]
      if (row.icon === null && mine && !this.refused.has(row.cid) && !this.migrating.has(row.cid)) {
        void this.migrate({ cid: row.cid, apiPort: row.apiPort }, mine)
      }
    }
    if (changed) this.commit()
  }

  private async migrate(target: IconTarget, icon: ProjectIcon): Promise<void> {
    this.migrating.add(target.cid)
    try {
      const res = await this.set(target, icon)
      if (res.ok) return
      if (res.failure === 'permission') this.refused.add(target.cid)
      else if (res.failure === 'invalid') delete this.legacy[target.cid]
      // unreachable / unsupported: try again on a later poll
      this.commit()
    } finally {
      this.migrating.delete(target.cid)
    }
  }

  /** Set (null = reset to the default glyph) one project's icon: paints now, PUTs, and on
   *  failure rolls back to what the server has, resolving with a clear message. */
  async set(target: IconTarget, icon: ProjectIcon | null): Promise<IconWriteResult> {
    const valid = icon ? parseIcon(icon) : null
    if (icon && !valid) return { ok: false, failure: 'invalid', message: 'The project rejected this icon' }
    const id = ++this.seq
    const list = this.inflight.get(target.cid) ?? []
    list.push({ id, icon: valid })
    this.inflight.set(target.cid, list)
    this.commit()
    let result: IconWriteResult
    try {
      const res = await this.put(target.apiPort, `/api/containers/${encodeURIComponent(target.cid)}/icon`, { icon: valid })
      const stored = containerIcon(res)
      this.cache[target.cid] = stored === undefined ? valid : stored
      delete this.legacy[target.cid] // migrated / superseded by a real write
      this.refused.delete(target.cid)
      result = { ok: true }
    } catch (err) {
      result = { ok: false, ...iconWriteFailure(err) }
    }
    const rest = (this.inflight.get(target.cid) ?? []).filter((w) => w.id !== id)
    if (rest.length) this.inflight.set(target.cid, rest)
    else this.inflight.delete(target.cid)
    this.commit()
    return result
  }

  /** A project was removed: drop what this Mac cached for its containers (the icon itself
   *  lives in the project's database, so re-adding the project brings it back). */
  forget(cids: readonly string[]): void {
    let changed = false
    for (const cid of cids) {
      if (cid in this.cache || cid in this.legacy || this.refused.has(cid)) changed = true
      delete this.cache[cid]
      delete this.legacy[cid]
      this.refused.delete(cid)
    }
    if (changed) this.commit()
  }

  private commit(): void {
    writeJson(this.storage, ICON_CACHE_KEY, this.cache)
    if (Object.keys(this.legacy).length > 0) writeJson(this.storage, LEGACY_ICONS_KEY, this.legacy)
    else dropKey(this.storage, LEGACY_ICONS_KEY) // migration done: no local-only icons remain
    this.rebuild()
    this.listeners.forEach((f) => f())
  }

  private rebuild(): void {
    const out: Record<string, ProjectIcon> = {}
    const cids = new Set([...Object.keys(this.legacy), ...Object.keys(this.cache), ...this.inflight.keys()])
    for (const cid of cids) {
      const pending = this.inflight.get(cid)
      const icon = pending?.length
        ? pending[pending.length - 1].icon
        : cid in this.cache
          ? this.cache[cid]
          : (this.legacy[cid] ?? null) // not reported by a store-aware portal yet
      if (icon) out[cid] = icon
    }
    this.view = out
  }
}

// ---- emoji recents (local) --------------------------------------------------------------------

export function loadRecents(storage: PrefsStorage): string[] {
  const raw = readJson(storage, RECENTS_KEY)
  return Array.isArray(raw) ? raw.filter(isEmoji).slice(0, RECENTS_MAX) : []
}

/** Most-recent-first, de-duplicated, capped. */
export function pushRecent(storage: PrefsStorage, recents: string[], emoji: string): string[] {
  if (!isEmoji(emoji)) return recents
  const next = [emoji, ...recents.filter((e) => e !== emoji)].slice(0, RECENTS_MAX)
  writeJson(storage, RECENTS_KEY, next)
  return next
}
