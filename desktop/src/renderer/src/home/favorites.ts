/** Favorited PROJECT (container) ids for the desktop home grid — mirrors the cloud hub's
 *  per-user default-star pattern, but local-only: no server round trip, just localStorage.
 *  Keyed on container id (not stack/project) since cards are per-container. */

const STORAGE_KEY = 'orcha:desktop:favorites'

/** Minimal storage surface (matches window.localStorage) so this stays unit-testable
 *  without a real DOM/localStorage. */
export interface FavoritesStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function readIds(storage: FavoritesStorage): string[] {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function writeIds(storage: FavoritesStorage, ids: string[]): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch {
    // Private-mode / quota errors — favoriting silently doesn't persist, not worth surfacing.
  }
}

/** All favorited container ids, in storage order. */
export function loadFavorites(storage: FavoritesStorage): Set<string> {
  return new Set(readIds(storage))
}

/** Toggle one container id's favorite state, returning the new set. */
export function toggleFavorite(storage: FavoritesStorage, cid: string): Set<string> {
  const ids = readIds(storage)
  const idx = ids.indexOf(cid)
  if (idx >= 0) ids.splice(idx, 1)
  else ids.push(cid)
  writeIds(storage, ids)
  return new Set(ids)
}
