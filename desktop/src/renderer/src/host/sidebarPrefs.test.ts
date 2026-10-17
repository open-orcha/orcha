import { describe, it, expect } from 'vitest'
import {
  isExpanded,
  loadExpanded,
  saveExpanded,
  loadCollapsed,
  loadOrder,
  loadWidth,
  moveKey,
  saveCollapsed,
  saveOrder,
  saveWidth,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN
} from './sidebarPrefs'

function memory() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}

describe('sidebarPrefs', () => {
  it('width defaults to 248 and is clamped to 200–360 on save and load', () => {
    const s = memory()
    expect(loadWidth(s)).toBe(SIDEBAR_DEFAULT)
    saveWidth(s, 999)
    expect(loadWidth(s)).toBe(SIDEBAR_MAX)
    saveWidth(s, 10)
    expect(loadWidth(s)).toBe(SIDEBAR_MIN)
    s.setItem('orcha:host:sidebarWidth', 'garbage')
    expect(loadWidth(s)).toBe(SIDEBAR_DEFAULT)
  })

  it('persists the collapsed flag', () => {
    const s = memory()
    expect(loadCollapsed(s)).toBe(false)
    saveCollapsed(s, true)
    expect(loadCollapsed(s)).toBe(true)
  })

  it('persists order and tolerates corrupt storage', () => {
    const s = memory()
    saveOrder(s, ['a', 'b'])
    expect(loadOrder(s)).toEqual(['a', 'b'])
    s.setItem('orcha:host:projectOrder', '{bad')
    expect(loadOrder(s)).toEqual([])
  })

  it('survives a throwing storage', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      }
    }
    expect(loadWidth(broken)).toBe(SIDEBAR_DEFAULT)
    expect(() => saveWidth(broken, 300)).not.toThrow()
  })

  it('moveKey swaps with the neighbour and is a no-op at the ends', () => {
    expect(moveKey(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(moveKey(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b'])
    expect(moveKey(['a', 'b'], 'a', -1)).toEqual(['a', 'b'])
    expect(moveKey(['a', 'b'], 'z', 1)).toEqual(['a', 'b'])
  })
})

describe('agents expansion prefs (D11)', () => {
  const mem = () => {
    const m = new Map<string, string>()
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
  }

  it('defaults: the open project is expanded, others collapsed', () => {
    expect(isExpanded({}, 'a', true)).toBe(true)
    expect(isExpanded({}, 'b', false)).toBe(false)
  })

  it('an explicit choice wins over the default and persists', () => {
    const s = mem()
    saveExpanded(s, { a: false, b: true })
    const loaded = loadExpanded(s)
    expect(isExpanded(loaded, 'a', true)).toBe(false)
    expect(isExpanded(loaded, 'b', false)).toBe(true)
  })

  it('tolerates corrupt storage and drops non-boolean values', () => {
    const s = mem()
    s.setItem('orcha:host:agentsExpanded', '{nope')
    expect(loadExpanded(s)).toEqual({})
    s.setItem('orcha:host:agentsExpanded', JSON.stringify({ a: true, b: 'yes', c: 1 }))
    expect(loadExpanded(s)).toEqual({ a: true })
    s.setItem('orcha:host:agentsExpanded', '[true]')
    expect(loadExpanded(s)).toEqual({})
  })
})
