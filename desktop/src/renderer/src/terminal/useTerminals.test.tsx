// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { TAB_PREFS_KEY, useTerminals } from './useTerminals'
import type { RestoredTab, TermApi, TermInfo, TermRestoreResult } from '../../../shared/terminal'

const info = (id: number): TermInfo => ({ id, kind: 'shell', project: null, cwd: '/h', shell: 'zsh', note: null, backlog: '' })

function mockApi(list: TermInfo[]): TermApi {
  let next = 10
  return {
    list: vi.fn().mockResolvedValue(list),
    create: vi.fn().mockImplementation(async () => info(next++)),
    kill: vi.fn().mockResolvedValue(undefined),
    write: vi.fn(),
    resize: vi.fn(),
    setFocus: vi.fn(),
    onEvent: () => () => {},
    onCommand: () => () => {}
  } as unknown as TermApi
}

function setup(list: TermInfo[]) {
  window.orchaDesktop = { term: mockApi(list) } as unknown as typeof window.orchaDesktop
  return renderHook(() => useTerminals(() => null, () => true))
}

beforeEach(() => window.localStorage.clear())

describe('useTerminals — per-tab prefs across a renderer reload', () => {
  it('re-applies title / pin order / colour to the sessions main re-lists', async () => {
    window.localStorage.setItem(TAB_PREFS_KEY, JSON.stringify({ '2': { pin: 0, color: 'pink' }, '1': { title: 'api' } }))
    const { result } = setup([info(1), info(2), info(3)])
    await waitFor(() => expect(result.current.state.tabs).toHaveLength(3))
    expect(result.current.state.tabs.map((t) => [t.ptyId, t.pinned, t.customTitle, t.color])).toEqual([
      [2, true, null, 'pink'],
      [1, false, 'api', null],
      [3, false, null, null]
    ])
  })

  it('writes changes back (keyed by pty id) once the restore has settled', async () => {
    const { result } = setup([info(1), info(2)])
    await waitFor(() => expect(result.current.state.tabs).toHaveLength(2))
    const [a, b] = result.current.state.tabs
    act(() => {
      result.current.pin(b.key, true)
      result.current.setColor(a.key, 'yellow')
      result.current.rename(b.key, 'db')
    })
    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem(TAB_PREFS_KEY) ?? '{}')).toEqual({ '2': { title: 'db', pin: 0 }, '1': { color: 'yellow' } })
    )
  })

  it('a fresh app start (main lists nothing) drops stale prefs, so a recycled pty id starts clean', async () => {
    window.localStorage.setItem(TAB_PREFS_KEY, JSON.stringify({ '10': { title: 'old', pin: 0 } }))
    const { result } = setup([])
    await waitFor(() => expect(window.localStorage.getItem(TAB_PREFS_KEY)).toBeNull())
    act(() => void result.current.open('shell', null, null))
    await waitFor(() => expect(result.current.state.tabs[0]?.ptyId).toBe(10))
    expect(result.current.state.tabs[0]).toMatchObject({ customTitle: null, pinned: false, color: null })
  })
})

describe('useTerminals — session restore after a quit', () => {
  const restored = (id: number, over: Partial<RestoredTab> = {}): RestoredTab => ({
    info: { ...info(id), cwd: '/Users/me/Desktop' },
    title: null,
    pinned: false,
    color: null,
    rowKey: null,
    launchBranch: null,
    how: 'shell',
    note: 'Restored · new shell',
    ...over
  })

  function setupRestore(result: TermRestoreResult) {
    const restore = vi.fn().mockResolvedValue(result)
    const saveLayout = vi.fn()
    const api = Object.assign(mockApi([]), { restore, saveLayout })
    window.orchaDesktop = { term: api } as unknown as typeof window.orchaDesktop
    return { api, ...renderHook(() => useTerminals((p) => (p ? p.replace(/^orcha-/, '') : null), () => true)) }
  }

  it('a fresh app asks main to restore, and rebuilds order / pins / colours / titles / selection / rows', async () => {
    const { api, result } = setupRestore({
      tabs: [
        restored(1, { pinned: true, color: 'pink', title: 'scratch' }),
        restored(2, { info: { ...info(2), kind: 'claude', project: 'orcha-todo' }, how: 'resumed', note: 'Restored · conversation resumed', rowKey: 'orcha-todo:c1' }),
        restored(3)
      ],
      active: 2,
      skipped: 0,
      capped: 0,
      deferred: 0,
      dropped: 0
    })
    await waitFor(() => expect(result.current.state.tabs).toHaveLength(3))
    expect(api.restore).toHaveBeenCalledWith({})
    const tabs = result.current.state.tabs
    expect(tabs.map((t) => [t.ptyId, t.pinned, t.color, t.customTitle, t.rowKey, t.projectLabel, t.status])).toEqual([
      [1, true, 'pink', 'scratch', null, null, 'running'],
      [2, false, null, null, 'orcha-todo:c1', 'todo', 'running'],
      [3, false, null, null, null, null, 'running']
    ])
    expect(result.current.active?.ptyId).toBe(2)
    expect(result.current.active?.restoredNote).toBe('Restored · conversation resumed')
    expect(tabs[0].meta).toBeNull() // prior status never carries over — idle until activity
    // …and the layout goes back to main (pty ids + cosmetics only).
    await waitFor(() =>
      expect(api.saveLayout).toHaveBeenLastCalledWith({
        tabs: [
          { id: 1, title: 'scratch', pinned: true, color: 'pink', rowKey: null, launchBranch: null },
          { id: 2, title: null, pinned: false, color: null, rowKey: 'orcha-todo:c1', launchBranch: null },
          { id: 3, title: null, pinned: false, color: null, rowKey: null, launchBranch: null }
        ],
        active: 2
      })
    )
  })

  it('says what was left out on the tab you land on', async () => {
    const { result } = setupRestore({ tabs: [restored(1)], active: 1, skipped: 0, capped: 4, deferred: 0, dropped: 0 })
    await waitFor(() => expect(result.current.state.tabs).toHaveLength(1))
    expect(result.current.active?.restoredNote).toBe('Restored · new shell · 4 more tabs not reopened (limit 20)')
  })

  it('setting off: nothing opens, ⌘K "Restore last session" is offered and restores on demand', async () => {
    const { api, result } = setupRestore({ tabs: [], active: null, skipped: 2, capped: 0, deferred: 0, dropped: 0 })
    await waitFor(() => expect(result.current.skipped).toBe(2))
    expect(result.current.state.tabs).toHaveLength(0)
    api.restore.mockResolvedValueOnce({ tabs: [restored(5), restored(6)], active: 6, skipped: 0, capped: 0, deferred: 0, dropped: 0 })
    act(() => result.current.restoreLast())
    await waitFor(() => expect(result.current.state.tabs).toHaveLength(2))
    expect(api.restore).toHaveBeenLastCalledWith({ manual: true })
    expect(result.current.skipped).toBe(0)
    expect(result.current.active?.ptyId).toBe(6)
  })
})
