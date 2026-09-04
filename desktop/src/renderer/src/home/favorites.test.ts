import { describe, it, expect } from 'vitest'
import { loadFavorites, toggleFavorite, type FavoritesStorage } from './favorites'

function memoryStorage(seed: Record<string, string> = {}): FavoritesStorage {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value)
  }
}

describe('loadFavorites', () => {
  it('returns an empty set when nothing is stored', () => {
    expect(loadFavorites(memoryStorage())).toEqual(new Set())
  })

  it('parses a stored id array', () => {
    const storage = memoryStorage({ 'orcha:desktop:favorites': JSON.stringify(['c1', 'c2']) })
    expect(loadFavorites(storage)).toEqual(new Set(['c1', 'c2']))
  })

  it('returns an empty set on malformed JSON (never throws)', () => {
    const storage = memoryStorage({ 'orcha:desktop:favorites': 'not json' })
    expect(loadFavorites(storage)).toEqual(new Set())
  })

  it('filters out non-string entries', () => {
    const storage = memoryStorage({ 'orcha:desktop:favorites': JSON.stringify(['c1', 42, null]) })
    expect(loadFavorites(storage)).toEqual(new Set(['c1']))
  })

  it('returns an empty set when the stored value is not an array', () => {
    const storage = memoryStorage({ 'orcha:desktop:favorites': JSON.stringify({ a: 1 }) })
    expect(loadFavorites(storage)).toEqual(new Set())
  })
})

describe('toggleFavorite', () => {
  it('adds an id that is not yet favorited', () => {
    const storage = memoryStorage()
    const next = toggleFavorite(storage, 'c1')
    expect(next).toEqual(new Set(['c1']))
    expect(loadFavorites(storage)).toEqual(new Set(['c1']))
  })

  it('removes an id that is already favorited', () => {
    const storage = memoryStorage({ 'orcha:desktop:favorites': JSON.stringify(['c1', 'c2']) })
    const next = toggleFavorite(storage, 'c1')
    expect(next).toEqual(new Set(['c2']))
    expect(loadFavorites(storage)).toEqual(new Set(['c2']))
  })

  it('persists across separate loadFavorites calls against the same storage', () => {
    const storage = memoryStorage()
    toggleFavorite(storage, 'c1')
    toggleFavorite(storage, 'c2')
    expect(loadFavorites(storage)).toEqual(new Set(['c1', 'c2']))
  })

  it('never throws when setItem fails (e.g. private-mode quota)', () => {
    const storage: FavoritesStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded')
      }
    }
    expect(() => toggleFavorite(storage, 'c1')).not.toThrow()
  })
})
